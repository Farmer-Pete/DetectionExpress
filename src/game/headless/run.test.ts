import { describe, expect, it } from "vitest";
import { runScenarioHeadless } from "./run";
import { getScenarioEntry, supportedScenarioIds } from "./scenarios";

describe("the headless scenario map", () => {
  it("resolves the pin-brute-force entry", () => {
    const entry = getScenarioEntry("pin-brute-force");
    expect(entry.scenario.id).toBe("pin-brute-force");
    expect(supportedScenarioIds()).toContain("pin-brute-force");
  });

  it("throws on an unknown id and lists the supported ids", () => {
    expect(() => getScenarioEntry("does-not-exist")).toThrow(/does-not-exist/);
    expect(() => getScenarioEntry("does-not-exist")).toThrow(/pin-brute-force/);
  });
});

describe("runScenarioHeadless: wave mode", () => {
  it("scores pin-brute-force to a clean verdict with zero missed and zero false alerts", async () => {
    const result = await runScenarioHeadless({
      scenarioId: "pin-brute-force",
      mode: "wave",
      seed: 1,
    });
    expect(result.verdict).toBe("clean");
    expect(result.reading.missed).toBe(0);
    expect(result.reading.falseAlerts).toBe(0);
    expect(result.reading.caught).toBeGreaterThan(0);
    expect(result.reading.caught).toBe(result.run.attacks.length);
  }, 20_000);

  it("rejects, rather than reporting clean, when the wave run hits an undersized tick cap", async () => {
    await expect(
      runScenarioHeadless({
        scenarioId: "pin-brute-force",
        mode: "wave",
        seed: 1,
        ticks: 1,
      }),
    ).rejects.toThrow(/safety tick cap/);
  }, 20_000);

  it("rejects, rather than reporting clean, when a task fails during the run", async () => {
    // An invalid service rate (`num < 1`) makes the Detect task's governor throw at
    // construction (`service-governor.ts`), a task failure the engine reports
    // through `onError`. This must surface as a run error, never a verdict.
    await expect(
      runScenarioHeadless({
        scenarioId: "pin-brute-force",
        mode: "wave",
        seed: 1,
        serviceRate: { num: 0, den: 1 },
      }),
    ).rejects.toThrow();
  }, 20_000);
});

describe("runScenarioHeadless: normal mode", () => {
  it("returns zero false alerts off the endless benign baseline", async () => {
    const result = await runScenarioHeadless({
      scenarioId: "pin-brute-force",
      mode: "normal",
      seed: 1,
      ticks: 200,
    });
    expect(result.verdict).toBe("clean");
    expect(result.reading.falseAlerts).toBe(0);
    expect(result.run.attacks).toEqual([]);
    expect(result.run.events).toEqual([]);
  }, 20_000);
});

describe("runScenarioHeadless: unknown scenario", () => {
  it("rejects with a message listing the supported ids", async () => {
    await expect(
      runScenarioHeadless({ scenarioId: "does-not-exist", mode: "wave", seed: 1 }),
    ).rejects.toThrow(/does-not-exist/);
  });
});
