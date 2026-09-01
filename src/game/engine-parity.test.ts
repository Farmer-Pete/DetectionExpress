/**
 * The GH117 parity guards (GH117-PLAN.md "Parity guards"): the acceptance gate before
 * the legacy world engine and store may be removed. Three guards plus the scoring-boundary
 * guard prove the merged engine, scoring off the LIVE stepped scenario stream, is
 * byte-for-byte what the pre-generated pipeline produced.
 *
 *   Guard 1 — event-stream equivalence, across a seed sweep. The events the live engine
 *   adapts out of the stepped cast (id, ts, endpoint, payload, order) equal
 *   `Scenario.generate(seed).events` exactly, and every Attack's evidence eventIds match.
 *   Run with the whole ambient cast attached, so a seed collision that perturbed a
 *   scenario actor's stream would surface as a divergence.
 *
 *   Guard 2 — paired engine equivalence at a fast rate. For a fixed algorithm and a
 *   service rate so fast the governor never sleeps, the engine scoring off the LIVE
 *   stream and the engine scoring off the pre-generated stream agree on decisions,
 *   correctness, admitted/completed, terminal status and failure reason, and the
 *   checkpoint observations at each checkpoint tick.
 *
 *   Guard 2b — the same paired equivalence at REFERENCE_SLOW_RATE, the naive rule's real
 *   quantized rate at the shipped OMEGA. Slow enough that Detect's governor sleeps and
 *   Channel backpressure builds behind it, forcing the run through ScoredIngress
 *   buffering and a Queue checkpoint failure on BOTH sides — the highest-risk integrated
 *   path guard 2's never-sleeps rate cannot reach.
 *
 *   Boundary guard — an ambient kiosk fail flashes and logs but never enters the
 *   channels: it never bumps the dense event id or `admitted`; a scored-scenario fail
 *   does.
 */
import { describe, expect, it } from "vitest";
import { createAccountRider, initialAccountRiderPresence } from "../sim/actors/account-rider";
import type { AccountRiderSpawner } from "../sim/actors/account-rider-spawner";
import { createScorer, type ScorerConfig } from "../sim/correctness";
import { isRawKioskV1 } from "../sim/endpoints/kiosk/formats/kiosk-v1";
import { controlReference } from "../sim/entities/control";
import type { PipeEvent } from "../sim/event";
import { buildReferenceAlgorithm } from "../sim/scenarios/pin-brute-force/reference";
import { buildBlueprint, pinBruteForce } from "../sim/scenarios/pin-brute-force/scenario";
import { ScoredIngress } from "../sim/scored-ingress";
import type { ServiceRate } from "../sim/service-governor";
import type { SimSnapshot } from "../sim/snapshot";
import type { TaskAlgorithm } from "../sim/tasks";
import { distanceTable } from "../sim/world/distance";
import { buildTimetable } from "../sim/world/timetable";
import { world } from "../sim/world/world";
import type { WorldEnv } from "../sim/world-reading";
import { buildAmbientFixtures, buildAmbientSpawners } from "./ambient-cast";
import { ManualDriver } from "./clock";
import {
  type CheckpointObservation,
  type ScenarioCast,
  type ScenarioCastMember,
  type ScoredIngestSource,
  type StartOptions,
  start,
} from "./engine";
import { REFERENCE_SLOW_RATE } from "./profiler/kiosk-band-calibration";
import { getGraph } from "./store";
import { CORRECTNESS_W_FN, CORRECTNESS_W_FP, CORRECTNESS_WINDOW, LEVEL_SEED } from "./tuning";

const SCORER_CONFIG: ScorerConfig = {
  window: CORRECTNESS_WINDOW,
  wFn: CORRECTNESS_W_FN,
  wFp: CORRECTNESS_W_FP,
};

/** A rate so fast the governor never sleeps: the pipeline drains as fast as it fills. */
const FAST_RATE: ServiceRate = { num: 1_000_000, den: 1 };

/** The valid seed sweep frozen in compose-scenario.test.ts (>= 24 seeds, all valid). */
const SWEEP_SEEDS = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 42, 99, 123, 777, 1000, 2026, 4242, 9999, 10000, 31415, 55555,
  99991, 123456, 654321, 1000003,
];

/** The normalized record the reference detect reads, after Normalize runs. */
interface ReferenceView {
  account: string;
  terminal: string;
  outcome: "success" | "fail";
  id: number;
  ts: number;
  endpoint: string;
}

function isReferenceView(value: unknown): value is ReferenceView {
  return value instanceof Object && "account" in value && "outcome" in value && "id" in value;
}

/** The reference twin, adapted to the engine's untyped TaskAlgorithm. Deterministic. */
function referenceTaskAlgorithm(): TaskAlgorithm {
  const algo = buildReferenceAlgorithm();
  return {
    normalize: (raw) => (isRawKioskV1(raw) ? algo.normalize(raw) : raw),
    detect: (view) => (isReferenceView(view) ? algo.detect(view) : []),
  };
}

async function flush(rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/** Advance the Clock `ticks` ticks, draining microtasks between each. */
async function step(driver: ManualDriver, ticks: number, flushRounds = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    driver.tick();
    await flush(flushRounds);
  }
}

/** Build the live scenario cast (members) from a seed's blueprint, aligned by index. */
function membersOf(blueprint: ReturnType<typeof buildBlueprint>): ScenarioCastMember[] {
  const actors = blueprint.instantiate();
  return actors.map((actor, i) => {
    const d = blueprint.descriptors[i];
    if (!d) throw new Error("descriptor/actor misalignment");
    return { actor, kind: d.kind, provenance: d.provenance, initialPresence: d.initialPresence };
  });
}

/** A ScoredIngress whose every offered event is captured, in emission order. */
function capturingIngress(): { ingress: ScoredIngress; captured: PipeEvent[] } {
  const ingress = new ScoredIngress();
  const captured: PipeEvent[] = [];
  const realOffer = ingress.offer.bind(ingress);
  ingress.offer = (event: PipeEvent): void => {
    captured.push(event);
    realOffer(event);
  };
  return { ingress, captured };
}

describe("GH117 parity guard 1: live event-stream equivalence across a seed sweep", () => {
  it("covers at least 24 seeds", () => {
    expect(SWEEP_SEEDS.length).toBeGreaterThanOrEqual(24);
  });

  it.each(SWEEP_SEEDS)(
    "the live-adapted scenario stream equals Scenario.generate(seed).events exactly for seed %i",
    async (seed) => {
      const oracle = pinBruteForce.generate(seed);
      const blueprint = buildBlueprint(seed);

      // The whole living metro attached: if an ambient actor perturbed a scenario
      // actor's seed, the live scored stream would diverge from the oracle here.
      const env: WorldEnv = { ...blueprint.env, control: controlReference };
      const cast: ScenarioCast = { members: membersOf(blueprint), env, runSeed: seed };
      const { ingress, captured } = capturingIngress();
      const scoredIngest: ScoredIngestSource = {
        ingress,
        toEvent: blueprint.toEvent,
        lastScoredTick: blueprint.lastScoredTick,
      };

      const driver = new ManualDriver();
      const handle = start({
        getGraph,
        setSnapshot: () => undefined,
        algorithm: referenceTaskAlgorithm(),
        scorer: createScorer(blueprint.precomposed.attacks, SCORER_CONFIG),
        generator: () => null,
        serviceRate: FAST_RATE,
        checkpoints: [],
        waves: [...blueprint.waves],
        scenarioCast: cast,
        ambientCast: {
          fixtures: buildAmbientFixtures(world, env.timetable),
          ...buildAmbientSpawners(world, seed),
        },
        scoredIngest,
        driver,
      });

      // Every scored reading is emitted by lastScoredTick. Tick past it synchronously
      // (the offers land in the tick listener), then tear the run down.
      for (let t = 0; t <= blueprint.lastScoredTick + 1; t++) {
        driver.tick();
      }
      handle.stop();
      await flush(20); // let the parked pump unwind through the stop; no hang

      expect(captured).toEqual(oracle.events);
      // Attack evidence binds to those exact ids; prove the manifest matches too.
      expect(blueprint.precomposed.attacks).toEqual(oracle.attacks);
    },
  );
});

/** The scoring fields two runs must agree on, read off the terminal snapshot. */
function scoringFields(snap: SimSnapshot) {
  return {
    status: snap.status,
    failureReason: snap.failureReason,
    admitted: snap.admitted,
    completed: snap.completed,
    correctness: snap.correctness,
    decisions: snap.decisions,
    findings: snap.findings,
    queued: snap.queued,
  };
}

/** Run one full engine to conclusion, capturing checkpoint observations. */
async function runToConclusion(
  build: (onCheckpoint: (o: CheckpointObservation) => void, driver: ManualDriver) => StartOptions,
  finalTick: number,
): Promise<{ last: SimSnapshot | undefined; observations: CheckpointObservation[] }> {
  const observations: CheckpointObservation[] = [];
  const snapshots: SimSnapshot[] = [];
  const driver = new ManualDriver();
  const options = build((o) => observations.push(o), driver);
  const handle = start({ ...options, setSnapshot: (s) => snapshots.push(s) });
  await step(driver, finalTick + 2, 300);
  await handle.whenStopped;
  return { last: snapshots.at(-1), observations };
}

describe("GH117 parity guard 2: paired engine equivalence (live vs pre-generated)", () => {
  it.each([LEVEL_SEED, 7, 2026])(
    "the engine off the live stream agrees with the pre-generated reference for seed %i",
    async (seed) => {
      const run = pinBruteForce.generate(seed);
      const finalTick = run.checkpoints[run.checkpoints.length - 1]?.atTick ?? 0;

      // Reference: the pre-generated generator, no cast, no live ingress.
      let refIndex = 0;
      const reference = await runToConclusion(
        (onCheckpoint, driver) => ({
          getGraph,
          setSnapshot: () => undefined,
          algorithm: referenceTaskAlgorithm(),
          scorer: createScorer(run.attacks, SCORER_CONFIG),
          generator: () => (refIndex < run.events.length ? (run.events[refIndex++] ?? null) : null),
          serviceRate: FAST_RATE,
          checkpoints: run.checkpoints,
          waves: run.waves,
          driver,
          onCheckpoint,
        }),
        finalTick,
      );

      // Live: score off the stepped cast through the scored ingress, no generator.
      const blueprint = buildBlueprint(seed);
      const env: WorldEnv = { ...blueprint.env, control: controlReference };
      const live = await runToConclusion(
        (onCheckpoint, driver) => ({
          getGraph,
          setSnapshot: () => undefined,
          algorithm: referenceTaskAlgorithm(),
          scorer: createScorer(blueprint.precomposed.attacks, SCORER_CONFIG),
          generator: () => null,
          serviceRate: FAST_RATE,
          checkpoints: [...blueprint.checkpoints],
          waves: [...blueprint.waves],
          scenarioCast: { members: membersOf(blueprint), env, runSeed: seed },
          ambientCast: {
            fixtures: buildAmbientFixtures(world, env.timetable),
            ...buildAmbientSpawners(world, seed),
          },
          scoredIngest: {
            ingress: new ScoredIngress(),
            toEvent: blueprint.toEvent,
            lastScoredTick: blueprint.lastScoredTick,
          },
          driver,
          onCheckpoint,
        }),
        finalTick,
      );

      expect(reference.last).toBeDefined();
      expect(live.last).toBeDefined();
      if (!reference.last || !live.last) return;

      // The scored outcome is identical: decisions, correctness, counts, terminal state.
      expect(scoringFields(live.last)).toEqual(scoringFields(reference.last));
      // And both engines saw the same state at every checkpoint tick.
      expect(live.observations).toEqual(reference.observations);
      expect(reference.observations.length).toBeGreaterThan(0);
      // The live run really did win (a meaningful, concluding run, not an early bail).
      expect(live.last.status).toBe("won");
    },
  );
});

describe("GH117 parity guard 2b: paired engine equivalence under backpressure (slow service, queue failure)", () => {
  it.each([LEVEL_SEED, 7, 2026])(
    "the engine off the live stream agrees with the pre-generated reference under backpressure for seed %i",
    async (seed) => {
      const run = pinBruteForce.generate(seed);
      const finalTick = run.checkpoints[run.checkpoints.length - 1]?.atTick ?? 0;

      // Reference: the pre-generated generator, no cast, no live ingress. REFERENCE_SLOW_RATE
      // is the naive rule's real quantized rate at the shipped OMEGA (kiosk-band-calibration.ts):
      // slow enough that the abstract band model fails a checkpoint with margin against this
      // same LEVEL_SEED corpus. Here it drives the two REAL engines (live and pre-generated)
      // through the real Channel/ScoredIngress backpressure, not the abstract model.
      let refIndex = 0;
      const reference = await runToConclusion(
        (onCheckpoint, driver) => ({
          getGraph,
          setSnapshot: () => undefined,
          algorithm: referenceTaskAlgorithm(),
          scorer: createScorer(run.attacks, SCORER_CONFIG),
          generator: () => (refIndex < run.events.length ? (run.events[refIndex++] ?? null) : null),
          serviceRate: REFERENCE_SLOW_RATE,
          checkpoints: run.checkpoints,
          waves: run.waves,
          driver,
          onCheckpoint,
        }),
        finalTick,
      );

      // Live: score off the stepped cast through the scored ingress, no generator. Same
      // slow rate, so ScoredIngress buffers behind the same governed Detect pace.
      const blueprint = buildBlueprint(seed);
      const env: WorldEnv = { ...blueprint.env, control: controlReference };
      const live = await runToConclusion(
        (onCheckpoint, driver) => ({
          getGraph,
          setSnapshot: () => undefined,
          algorithm: referenceTaskAlgorithm(),
          scorer: createScorer(blueprint.precomposed.attacks, SCORER_CONFIG),
          generator: () => null,
          serviceRate: REFERENCE_SLOW_RATE,
          checkpoints: [...blueprint.checkpoints],
          waves: [...blueprint.waves],
          scenarioCast: { members: membersOf(blueprint), env, runSeed: seed },
          ambientCast: {
            fixtures: buildAmbientFixtures(world, env.timetable),
            ...buildAmbientSpawners(world, seed),
          },
          scoredIngest: {
            ingress: new ScoredIngress(),
            toEvent: blueprint.toEvent,
            lastScoredTick: blueprint.lastScoredTick,
          },
          driver,
          onCheckpoint,
        }),
        finalTick,
      );

      expect(reference.last).toBeDefined();
      expect(live.last).toBeDefined();
      if (!reference.last || !live.last) return;

      // The scored outcome is identical: decisions, correctness, counts, terminal state.
      expect(scoringFields(live.last)).toEqual(scoringFields(reference.last));
      // And both engines saw the same state at every checkpoint tick.
      expect(live.observations).toEqual(reference.observations);
      expect(reference.observations.length).toBeGreaterThan(0);

      // This guard only proves something at a slow rate if the slow rate actually bit:
      // some checkpoint must have failed on a Queue margin, and the run must have ended
      // there, with the typed "queue" failure reason (not a correctness fail, and not a
      // win the fast-rate guard already covers).
      expect(reference.observations.some((o) => o.outcome === "queue")).toBe(true);
      expect(reference.observations.some((o) => o.queued > 0)).toBe(true);
      expect(live.last.status).toBe("failed");
      expect(live.last.failureReason).toBe("queue");
    },
  );
});

/** An ambient account rider that signs in with one wrong-PIN fumble at `atTick`, once. */
function oneFumblingAmbientRider(id: string, station: string, atTick: number): AccountRiderSpawner {
  let done = false;
  return {
    tick: (nowTick) => {
      if (done || nowTick < atTick) return [];
      done = true;
      return [
        {
          actor: createAccountRider({
            id,
            account: "ambient",
            station,
            terminal: "K1",
            startTick: nowTick,
            dwellTicks: 4,
            fumbleFails: 1, // one wrong-PIN kiosk fail before the sign-in
          }),
          kind: "account-rider",
          initialPresence: (t) => initialAccountRiderPresence(station, t),
        },
      ];
    },
  };
}

describe("GH117 boundary guard: ambient kiosk fails flash and log but never score", () => {
  it("offers only scored-scenario kiosk readings; an ambient fail flashes but never bumps the id or admitted", async () => {
    const env: WorldEnv = {
      world,
      distances: distanceTable(world),
      timetable: buildTimetable(world),
      control: controlReference,
    };
    // One scored patron at "cen": one fumble fail then a sign-in success at tick 3 -> two
    // scored kiosk readings. Reuse a real blueprint's adapter to mint the wire events.
    const patron = createAccountRider({
      id: "patron-0",
      account: "rider",
      station: "cen",
      terminal: "K1",
      startTick: 3,
      dwellTicks: 4,
      fumbleFails: 1,
    });
    const members: ScenarioCastMember[] = [
      {
        actor: patron,
        kind: "account-rider",
        provenance: "scored-scenario",
        initialPresence: (t) => initialAccountRiderPresence("cen", t),
      },
    ];
    const { ingress, captured } = capturingIngress();
    const blueprint = buildBlueprint(LEVEL_SEED); // only its `toEvent` kiosk adapter is used

    const snapshots: SimSnapshot[] = [];
    const driver = new ManualDriver();
    const handle = start({
      getGraph,
      setSnapshot: (s) => snapshots.push(s),
      algorithm: referenceTaskAlgorithm(),
      scorer: createScorer([], SCORER_CONFIG),
      generator: () => null,
      serviceRate: FAST_RATE,
      checkpoints: [],
      waves: [],
      scenarioCast: { members, env, runSeed: LEVEL_SEED },
      ambientCast: {
        fixtures: [],
        accountSpawner: oneFumblingAmbientRider("A-amb", "cen", 6), // an ambient fail near tick 6
      },
      scoredIngest: { ingress, toEvent: blueprint.toEvent, lastScoredTick: 3 },
      driver,
    });
    await step(driver, 12, 40);
    handle.stop();
    await handle.whenStopped;

    // Exactly the patron's two kiosk readings were offered, with dense ids 0 and 1: the
    // ambient fail never entered the stream, so it never bumped the id.
    expect(captured.map((e) => e.id)).toEqual([0, 1]);
    // Admission counts only the two scored events; the ambient fail never admits.
    expect(snapshots.at(-1)?.admitted).toBe(2);

    // Yet the ambient wrong-PIN fail still raised a pinfail flash, and the ambient actor
    // stays tagged "ambient" in the actor view (never "scored-scenario").
    const flashes = snapshots.flatMap((s) => s.flashes);
    expect(flashes.some((f) => f.kind === "pinfail")).toBe(true);
    const ambientActor = snapshots.flatMap((s) => s.actors).find((actor) => actor.id === "A-amb");
    expect(ambientActor?.provenance).toBe("ambient");
  });
});
