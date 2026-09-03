import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./sim-run";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

describe("parseCliArgs", () => {
  it("splits a CSV --scenario into a list", () => {
    const args = parseCliArgs(["--scenario", "a,b"]);
    expect(args.scenarios).toEqual(["a", "b"]);
  });

  it("accepts a repeated --scenario flag", () => {
    const args = parseCliArgs(["--scenario", "a", "--scenario", "b"]);
    expect(args.scenarios).toEqual(["a", "b"]);
  });

  it("defaults mode to wave, seed to 1, and out to out/", () => {
    const args = parseCliArgs(["--scenario", "pin-brute-force"]);
    expect(args.mode).toBe("wave");
    expect(args.seed).toBe(1);
    expect(args.out).toBe("out/");
    expect(args.serviceRate).toBeUndefined();
    expect(args.ticks).toBeUndefined();
  });

  it("parses an explicit --mode and --seed", () => {
    const args = parseCliArgs(["--scenario", "x", "--mode", "normal", "--seed", "7"]);
    expect(args.mode).toBe("normal");
    expect(args.seed).toBe(7);
  });

  it("parses --service-rate as a bare integer", () => {
    const args = parseCliArgs(["--scenario", "x", "--service-rate", "500"]);
    expect(args.serviceRate).toEqual({ num: 500, den: 1 });
  });

  it("parses --service-rate as num/den", () => {
    const args = parseCliArgs(["--scenario", "x", "--service-rate", "3/2"]);
    expect(args.serviceRate).toEqual({ num: 3, den: 2 });
  });

  it("parses --ticks as an integer", () => {
    const args = parseCliArgs(["--scenario", "x", "--ticks", "42"]);
    expect(args.ticks).toBe(42);
  });

  it("throws when no --scenario is given", () => {
    expect(() => parseCliArgs([])).toThrow(/--scenario/);
  });

  it("throws on an invalid --mode", () => {
    expect(() => parseCliArgs(["--scenario", "x", "--mode", "bogus"])).toThrow(/--mode/);
  });

  it("rejects a --seed with trailing junk", () => {
    expect(() => parseCliArgs(["--scenario", "x", "--seed", "1junk"])).toThrow(/--seed/);
  });

  it("rejects a non-integer --ticks", () => {
    expect(() => parseCliArgs(["--scenario", "x", "--ticks", "2.5"])).toThrow(/--ticks/);
  });

  it("rejects a --service-rate with trailing junk", () => {
    expect(() => parseCliArgs(["--scenario", "x", "--service-rate", "3/2junk"])).toThrow(
      /--service-rate/,
    );
    expect(() => parseCliArgs(["--scenario", "x", "--service-rate", "500x"])).toThrow(
      /--service-rate/,
    );
  });
});

describe("sim-run CLI end to end", () => {
  it("runs pin-brute-force in wave mode to a clean verdict and writes the three files", () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "sim-run-e2e-"));
    try {
      const result = spawnSync(
        "npx",
        [
          "tsx",
          "scripts/sim-run.ts",
          "--scenario",
          "pin-brute-force",
          "--mode",
          "wave",
          "--seed",
          "1",
          "--out",
          outDir,
        ],
        // Cap the blocking subprocess below the 30s test timeout, so a hung CLI
        // fails this test with ETIMEDOUT instead of stalling the worker.
        { cwd: REPO_ROOT, encoding: "utf8", timeout: 25_000 },
      );

      const failure = `${result.stderr ?? ""}${result.error ? `\n${String(result.error)}` : ""}`;
      expect(result.status, failure).toBe(0);

      const simPath = path.join(outDir, "sim.json");
      const findingsPath = path.join(outDir, "findings.json");
      const summaryPath = path.join(outDir, "summary.json");
      expect(existsSync(simPath)).toBe(true);
      expect(existsSync(findingsPath)).toBe(true);
      expect(existsSync(summaryPath)).toBe(true);

      const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
      expect(summary.verdict).toBe("clean");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);
});
