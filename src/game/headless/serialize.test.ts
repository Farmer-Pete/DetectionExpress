import { describe, expect, it } from "vitest";
import type {
  CaughtDecision,
  CorrectnessReading,
  Decision,
  LiveFinding,
} from "../../sim/correctness";
import {
  type HeadlessResult,
  toFindingsJson,
  toSimJson,
  toSummaryJson,
  verdictOf,
} from "./serialize";

describe("verdictOf", () => {
  it("reads wave mode clean only with zero missed and zero false alerts", () => {
    expect(verdictOf({ caught: 3, missed: 0, falseAlerts: 0 }, "wave")).toBe("clean");
  });

  it("reads wave mode missed when any Attack was missed, even with no false alerts", () => {
    expect(verdictOf({ caught: 2, missed: 1, falseAlerts: 0 }, "wave")).toBe("missed");
  });

  it("reads wave mode false-alerts when there is a false alert but nothing missed", () => {
    expect(verdictOf({ caught: 3, missed: 0, falseAlerts: 1 }, "wave")).toBe("false-alerts");
  });

  it("reads normal mode clean with zero false alerts, ignoring missed entirely", () => {
    expect(verdictOf({ caught: 0, missed: 0, falseAlerts: 0 }, "normal")).toBe("clean");
  });

  it("reads normal mode false-alerts on any false alert", () => {
    expect(verdictOf({ caught: 0, missed: 0, falseAlerts: 1 }, "normal")).toBe("false-alerts");
  });
});

const reading: CorrectnessReading = { caught: 1, missed: 1, falseAlerts: 0, rolling: 50 };

const caughtDecision: CaughtDecision = {
  outcome: "caught",
  seq: 0,
  at: 10,
  resolvedAt: 10,
  attackId: 1,
  entity: "acct-1",
  finding: { alert: { eventIds: [5], reason: "pin_brute_force", at: 10 }, eventId: 5 },
  citedEvents: [],
  liveSeq: 0,
};

const decisions: readonly Decision[] = [caughtDecision];

const liveFinding: LiveFinding = {
  finding: { alert: { eventIds: [5], reason: "pin_brute_force", at: 10 }, eventId: 5 },
  entity: "acct-1",
  state: "hit",
  reason: "pin_brute_force",
  eventIds: [5],
  at: 10,
  seq: 0,
  citedEvents: [],
};

/** A small hand-built HeadlessResult, its ground truth carrying one labeled Attack. */
function buildResult(): HeadlessResult {
  return {
    scenarioId: "pin-brute-force",
    mode: "wave",
    seed: 1,
    reading,
    decisions,
    findings: [liveFinding],
    run: {
      events: [
        { id: 5, ts: 10, endpoint: "kiosk-v1", payload: { acct: "x" } },
        { id: 6, ts: 12, endpoint: "kiosk-v1", payload: { acct: "y" } },
      ],
      attacks: [
        {
          id: 1,
          entity: "acct-1",
          reason: "pin_brute_force",
          window: { startTs: 0, endTs: 20 },
          eventIds: [5],
          threshold: 1,
        },
      ],
      checkpoints: [{ atTick: 10, clearsThroughWave: 0 }],
      waves: [],
    },
    verdict: "missed",
  };
}

describe("toSimJson", () => {
  it("carries the run's identity and the ground-truth Attacks", () => {
    const sim = toSimJson(buildResult());
    expect(sim.scenarioId).toBe("pin-brute-force");
    expect(sim.mode).toBe("wave");
    expect(sim.seed).toBe(1);
    expect(sim.attacks).toEqual(buildResult().run.attacks);
  });

  it("labels each event with the id of the Attack it is evidence for, or benign", () => {
    const sim = toSimJson(buildResult());
    expect(sim.events).toEqual([
      { id: 5, ts: 10, endpoint: "kiosk-v1", payload: { acct: "x" }, label: 1 },
      { id: 6, ts: 12, endpoint: "kiosk-v1", payload: { acct: "y" }, label: "benign" },
    ]);
  });
});

describe("toFindingsJson", () => {
  it("keeps live alerts and resolved decisions as two distinct arrays", () => {
    const findingsJson = toFindingsJson(buildResult());
    expect(findingsJson.alerts).toEqual([liveFinding]);
    expect(findingsJson.decisions).toEqual([caughtDecision]);
  });
});

describe("toSummaryJson", () => {
  it("carries the run's identity, its counts and rolling score, and its verdict", () => {
    const summary = toSummaryJson(buildResult());
    expect(summary).toEqual({
      scenarioId: "pin-brute-force",
      mode: "wave",
      seed: 1,
      caught: 1,
      missed: 1,
      falseAlerts: 0,
      rolling: 50,
      verdict: "missed",
    });
  });
});
