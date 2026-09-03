/**
 * The headless scenario-validation CLI (GH128-PLAN.md). A thin wrapper over
 * `runScenarioHeadless`: it parses args, loops the requested scenarios, writes
 * `sim.json`, `findings.json`, and `summary.json` per run, prints one line per
 * run, and sets the process exit code.
 *
 * Usage: `pnpm sim:run -- --scenario pin-brute-force --mode wave --seed 1 --out out/`
 *
 * Exit codes: 0 every run clean; 1 any detection failure (missed or false alerts);
 * 2 a run error (a Rule threw, or a wave run hit its safety cap) or a usage/load
 * error (an unknown scenario, a bad flag).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { type HeadlessResult, type RunMode, runScenarioHeadless } from "../src/game/headless/run";
import { supportedScenarioIds } from "../src/game/headless/scenarios";
import { toFindingsJson, toSimJson, toSummaryJson } from "../src/game/headless/serialize";
import { isMainModule } from "./entry";

export interface ParsedCliArgs {
  scenarios: string[];
  mode: RunMode;
  seed: number;
  out: string;
  serviceRate?: { num: number; den: number };
  ticks?: number;
}

function isRunMode(value: string): value is RunMode {
  return value === "normal" || value === "wave";
}

/** `--service-rate`: an integer `N` (`{ num: N, den: 1 }`), or `"num/den"`. */
function parseServiceRate(raw: string): { num: number; den: number } {
  const slash = raw.indexOf("/");
  if (slash === -1) {
    const num = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(num) || num < 1) {
      throw new Error(`--service-rate must be a positive integer or "num/den", got "${raw}".`);
    }
    return { num, den: 1 };
  }
  const num = Number.parseInt(raw.slice(0, slash), 10);
  const den = Number.parseInt(raw.slice(slash + 1), 10);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num < 1 || den < 1) {
    throw new Error(`--service-rate "num/den" must both be positive integers, got "${raw}".`);
  }
  return { num, den };
}

function parsePositiveInt(raw: string, flag: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer, got "${raw}".`);
  }
  return value;
}

/** Parse the CLI's flags into a plain, validated shape. Throws on any usage error. */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      scenario: { type: "string", multiple: true },
      mode: { type: "string" },
      seed: { type: "string" },
      out: { type: "string" },
      "service-rate": { type: "string" },
      ticks: { type: "string" },
    },
  });

  const scenarios = (values.scenario ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (scenarios.length === 0) {
    throw new Error(
      `--scenario is required. Supported scenario ids: ${supportedScenarioIds().join(", ")}.`,
    );
  }

  const modeRaw = values.mode ?? "wave";
  if (!isRunMode(modeRaw)) {
    throw new Error(`--mode must be "normal" or "wave", got "${modeRaw}".`);
  }

  const seedRaw = values.seed ?? "1";
  const seed = Number.parseInt(seedRaw, 10);
  if (!Number.isSafeInteger(seed)) {
    throw new Error(`--seed must be an integer, got "${seedRaw}".`);
  }

  const args: ParsedCliArgs = { scenarios, mode: modeRaw, seed, out: values.out ?? "out/" };
  if (values["service-rate"] !== undefined) {
    args.serviceRate = parseServiceRate(values["service-rate"]);
  }
  if (values.ticks !== undefined) {
    args.ticks = parsePositiveInt(values.ticks, "--ticks");
  }
  return args;
}

function formatLine(result: HeadlessResult): string {
  const { reading } = result;
  return (
    `${result.scenarioId} ${result.mode} seed=${result.seed} -> ${result.verdict} ` +
    `(caught ${reading.caught} / missed ${reading.missed} / false ${reading.falseAlerts})`
  );
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/** With one scenario, write straight to `out`; with several, one subfolder each. */
function outDirFor(out: string, scenarioIds: readonly string[], scenarioId: string): string {
  return scenarioIds.length > 1 ? path.join(out, scenarioId) : out;
}

/** 0 every run clean; 1 any detection failure; 2 a run error or a usage/load error. */
type ExitCode = 0 | 1 | 2;

/** Run every requested scenario, write its files, and return the worst exit code. */
async function main(argv: readonly string[]): Promise<ExitCode> {
  let args: ParsedCliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  let worstExit: ExitCode = 0;
  for (const scenarioId of args.scenarios) {
    let result: HeadlessResult;
    try {
      result = await runScenarioHeadless({
        scenarioId,
        mode: args.mode,
        seed: args.seed,
        ...(args.serviceRate ? { serviceRate: args.serviceRate } : {}),
        ...(args.ticks !== undefined ? { ticks: args.ticks } : {}),
      });
    } catch (error) {
      console.error(
        `${scenarioId} ${args.mode} seed=${args.seed}: run error -- ` +
          (error instanceof Error ? error.message : String(error)),
      );
      worstExit = 2;
      continue;
    }

    console.log(formatLine(result));
    const dir = outDirFor(args.out, args.scenarios, scenarioId);
    mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, "sim.json"), toSimJson(result));
    writeJson(path.join(dir, "findings.json"), toFindingsJson(result));
    writeJson(path.join(dir, "summary.json"), toSummaryJson(result));

    if (result.verdict !== "clean" && worstExit < 1) {
      worstExit = 1;
    }
  }
  return worstExit;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const exitCode = await main(process.argv.slice(2));
  process.exit(exitCode);
}
