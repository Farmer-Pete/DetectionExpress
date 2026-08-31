import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleEngineSource } from "./engine-assembler";

/** One normalized kiosk fail view, the flat record detect reads. */
interface KioskFailView {
  account: string;
  terminal: string;
  outcome: "fail";
  id: number;
  ts: number;
  endpoint: string;
}

/** One finding, reduced to the fields these behavioral assertions read. */
interface EngineFinding {
  alert: { reason: string };
  isPartial?: boolean;
}

/** A loaded engine, as the browser run would import from the assembled source. */
interface LoadedEngine {
  normalize(raw: unknown, endpoint: string): { account: string; terminal: string; outcome: string };
  detect(e: KioskFailView): EngineFinding[];
}

/**
 * Evaluate the assembled source in-process, the same way the reference tests do: drop
 * the cosmetic first import line and the `export` keywords, then hand back the two
 * callables. Each call rebuilds the module, so its rule state starts clean.
 */
function evaluate(src: string): LoadedEngine {
  const body = src.replace(/^import .*$/m, "").replace(/^export\s+/gm, "");
  const factory = new Function(`${body}\nreturn { normalize, detect };`);
  const loaded: LoadedEngine = factory();
  return loaded;
}

function fail(id: number, ts: number): KioskFailView {
  return { account: "amy", terminal: "K1", outcome: "fail", id, ts, endpoint: "kiosk-v1" };
}

const SOURCE = assembleEngineSource(process.cwd());

describe("assembled engine source shape", () => {
  it("opens with the teaching import and exports normalize and detect", () => {
    expect(SOURCE).toContain('import _ from "https://esm.sh/lodash@4.17.21"');
    expect(SOURCE).toContain("export function normalize");
    expect(SOURCE).toContain("export function detect");
  });

  it("carries exactly one import line (the teaching prop), so it runs offline", () => {
    const imports = SOURCE.split("\n").filter((line) => /^\s*import\b/.test(line));
    expect(imports).toHaveLength(1);
  });

  it("inlines the rule's own tuning constants, but shakes out unrelated cross-cutting ones", () => {
    // GH42-PLAN.md code review: rule.ts imports WINDOW/THRESHOLD from its own tuning.ts,
    // which itself imports GAME_SECONDS_PER_TICK from the big cross-cutting game/tuning.ts
    // (for a derived constant the rule never reads). Dependency-aware inlining must pull
    // in the two constants the rule actually uses...
    expect(SOURCE).toContain("PIN_BRUTE_FORCE_THRESHOLD");
    expect(SOURCE).toContain("PIN_BRUTE_FORCE_WINDOW_S");
    // ...without dragging the whole unrelated file's constants into the rule's block.
    expect(SOURCE).not.toContain("TRAIN_HEADWAY_MINUTES");
    expect(SOURCE).not.toContain("STAFF_BADGE_POOL");
    expect(SOURCE).not.toContain("CAMERA_WINDOW_TICKS");
  });
});

describe("assembled engine runs", () => {
  it("dispatches normalize by endpoint", () => {
    const engine = evaluate(SOURCE);
    expect(
      engine.normalize({ t: 1, acct: "amy", term: "K1", res: "WRONG_PIN" }, "kiosk-v1"),
    ).toEqual({ account: "amy", terminal: "K1", outcome: "fail" });
  });

  it("detects a full pin-brute-force burst as one hit", () => {
    const engine = evaluate(SOURCE);
    const findings = [0, 1, 2, 3, 4].flatMap((i) => engine.detect(fail(i, i * 10)));
    const hits = findings.filter((f) => f.isPartial !== true);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.alert.reason).toBe("pin_brute_force");
  });

  it("isolates rule state: a fresh evaluation starts clean", () => {
    const engineA = evaluate(SOURCE);
    for (let i = 0; i < 5; i++) {
      engineA.detect(fail(i, i * 10));
    }
    // A second evaluation is a fresh module: two fails are below threshold, no hit.
    const engineB = evaluate(SOURCE);
    const findings = [engineB.detect(fail(0, 0)), engineB.detect(fail(1, 10))].flat();
    expect(findings.filter((f) => f.isPartial !== true)).toHaveLength(0);
  });
});

/**
 * A synthetic fixture, isolated from the real `src/sim` tree, proving the general
 * shape of the fix rather than relying only on pin-brute-force's own current files:
 * a rule imports its own tuning, which itself imports a second file for one constant
 * among several unrelated ones. `node_modules` is symlinked in so the real Biome
 * binary formats the output, exactly as `assembleEngineSource` does in production.
 */
const tempRoots: string[] = [];

function makeFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "engine-assembler-fixture-"));
  tempRoots.push(root);
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"));

  const simDir = join(root, "src", "sim");
  mkdirSync(join(simDir, "engine"), { recursive: true });
  mkdirSync(join(simDir, "scenarios", "widget-attack"), { recursive: true });
  mkdirSync(join(root, "src", "shared"), { recursive: true });

  writeFileSync(
    join(simDir, "engine", "core.ts"),
    `// The shared core. Inlined once, above every rule.
export function withinWindow(items: { ts: number }[], now: number, windowSeconds: number) {
  return items.filter((x) => x.ts > now - windowSeconds);
}
`,
  );

  writeFileSync(
    join(root, "src", "shared", "tuning.ts"),
    `// A big cross-cutting file, unrelated to widget-attack except for one constant.
export const TICK_SECONDS = 2;
export const UNRELATED_HUGE_CONSTANT = "should never reach the assembled output";
`,
  );

  writeFileSync(
    join(simDir, "scenarios", "widget-attack", "tuning.ts"),
    `import { TICK_SECONDS } from "../../../shared/tuning";
export const THRESHOLD = 3;
export const WINDOW_S = 60;
// A derived constant the rule never reads: its own dependency (TICK_SECONDS) must
// never get pulled in just because it lives in the same file as THRESHOLD/WINDOW_S.
export const DERIVED_TICKS = WINDOW_S / TICK_SECONDS;
`,
  );

  writeFileSync(
    join(simDir, "scenarios", "widget-attack", "rule.ts"),
    `import { withinWindow } from "../../engine/core";
import { THRESHOLD, WINDOW_S } from "./tuning";
export function buildRule() {
  const fails = new Map<string, { id: number; ts: number }[]>();
  return {
    id: "widget-attack",
    endpoints: ["widget-v1"],
    detect(e: { id: number; ts: number; entity: string }) {
      const seen = fails.get(e.entity) ?? [];
      seen.push({ id: e.id, ts: e.ts });
      const kept = withinWindow(seen, e.ts, WINDOW_S);
      fails.set(e.entity, kept);
      if (kept.length < THRESHOLD) {
        return [];
      }
      return [{ alert: { reason: "widget_attack", at: e.ts, eventIds: kept.map((x) => x.id) } }];
    },
  };
}
`,
  );

  return root;
}

describe("fixture: dependency-aware inlining across a multi-hop import chain", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assembles a rule that imports its own tuning into one runnable module", () => {
    const source = assembleEngineSource(makeFixtureRoot());
    expect(source).toContain("export function detect");

    const body = source.replace(/^import .*$/m, "").replace(/^export\s+/gm, "");
    const factory = new Function(`${body}\nreturn { detect };`);
    const loaded: { detect: (e: unknown) => Array<{ alert: { reason: string } }> } = factory();

    const findings = [0, 1, 2].flatMap((i) =>
      loaded.detect({ id: i, ts: i * 10, entity: "widget-A", endpoint: "widget-v1" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.alert.reason).toBe("widget_attack");
  });

  it("shakes the dependency to only the names the rule's chain actually uses", () => {
    const source = assembleEngineSource(makeFixtureRoot());
    expect(source).toContain("THRESHOLD");
    expect(source).toContain("WINDOW_S");
    // TICK_SECONDS only feeds DERIVED_TICKS, which the rule never reads: neither the
    // derived constant nor the unrelated file's other export should ever appear.
    expect(source).not.toContain("DERIVED_TICKS");
    expect(source).not.toContain("TICK_SECONDS");
    expect(source).not.toContain("UNRELATED_HUGE_CONSTANT");
  });
});

describe("assembly failures throw rather than fall back", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws on a relative import shape it cannot inline, instead of dropping it", () => {
    const root = makeFixtureRoot();
    writeFileSync(
      join(root, "src", "sim", "scenarios", "widget-attack", "rule.ts"),
      `import tuning from "./tuning"; // a default import: unsupported
export function buildRule() {
  return { id: "widget-attack", endpoints: ["widget-v1"], detect: () => [] };
}
`,
    );
    expect(() => assembleEngineSource(root)).toThrow(/cannot inline/);
  });

  it("throws when Biome fails to format the assembled source, instead of shipping it unformatted", () => {
    // A fixture root with no symlinked node_modules: the Biome binary is missing, so
    // the format step itself must fail loudly rather than falling back to raw output.
    const root = mkdtempSync(join(tmpdir(), "engine-assembler-fixture-nobiome-"));
    tempRoots.push(root);
    mkdirSync(join(root, "src", "sim", "engine"), { recursive: true });
    writeFileSync(
      join(root, "src", "sim", "engine", "core.ts"),
      "export function withinWindow() { return []; }\n",
    );
    expect(() => assembleEngineSource(root)).toThrow(/Biome/);
  });
});
