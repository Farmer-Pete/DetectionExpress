import { describe, expect, it } from "vitest";
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
