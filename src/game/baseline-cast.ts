/**
 * The baseline cast: the calm, endless metro `run-controller.ts` runs by default
 * (GH126-PLAN.md M1, "Baseline-cast builder"). It mirrors `buildMapCast`'s shape —
 * a `ScenarioCast` plus an `AmbientCast` over one shared `WorldEnv` and seed — but
 * carries no scenario blueprint, since the baseline plans no Attack: `scenarioCast`
 * always holds an EMPTY member list, so the engine's `start()` guard (which requires
 * a `scenarioCast` whenever `scoredIngest` is present) passes with nothing scenario-
 * specific to step.
 *
 * The scored source is the perpetual ambient account-rider kiosk stream instead
 * (GH126-PLAN.md Q10, Q2): `scoredIngest.lastScoredTick` is `Infinity`, so the
 * engine's scored-horizon check (`tick >= scoredIngest.lastScoredTick`) never
 * fires and the ingress never closes — the baseline run has no end. `toEvent`
 * formats every scored reading through the same kiosk-v1 endpoint every other
 * kiosk stream in the game uses (`sim/endpoints/kiosk/formats/kiosk-v1.ts`), via
 * the shared `composeEvent` construction (`sim/actors/compose.ts`) so a baseline
 * event is built exactly the way a scenario's live event is.
 */
import type { TimedReading } from "../sim/actors/actor";
import { composeEvent } from "../sim/actors/compose";
import { kioskV1, type RawKioskV1 } from "../sim/endpoints/kiosk/formats/kiosk-v1";
import { controlReference } from "../sim/entities/control";
import type { PipeEvent } from "../sim/event";
import { ScoredIngress } from "../sim/scored-ingress";
import { distanceTable } from "../sim/world/distance";
import { buildTimetable } from "../sim/world/timetable";
import { world } from "../sim/world/world";
import type { WorldEnv, WorldReading } from "../sim/world-reading";
import { buildAmbientFixtures, buildAmbientSpawners } from "./ambient-cast";
import type { AmbientCast, ScenarioCast, ScoredIngestSource } from "./engine";

/** Every `WorldReading` arm carries its own `ts`; read it once, generically. */
function tsOf(t: TimedReading<WorldReading>): number {
  return t.reading.reading.ts;
}

/**
 * Narrow a timed reading to its kiosk record, or fail loudly: the baseline scores
 * only account-rider kiosk readings (the boundary in `engine.ts`'s tick listener
 * already ensures `toEvent` is only ever called on one), so a non-kiosk reading
 * here is a caller bug, not a data shape to format defensively.
 */
function kioskReading(t: TimedReading<WorldReading>) {
  if (t.reading.sensor !== "kiosk") {
    throw new Error(`baseline cast: expected a kiosk reading, got "${t.reading.sensor}".`);
  }
  return t.reading.reading;
}

function format(t: TimedReading<WorldReading>): RawKioskV1 {
  return kioskV1.format(kioskReading(t));
}

function endpointIdOf(): string {
  return kioskV1.id;
}

/**
 * Build the calm baseline's cast for one run seed: an empty-member scenario cast
 * (no Attack, so `start()`'s `scoredIngest`-requires-`scenarioCast` guard passes
 * with nothing scenario-specific), the metro's ambient life (trains, staff, riders,
 * and the account riders whose kiosk readings this baseline scores), and a scored
 * ingress that never closes.
 */
export function buildBaselineCast(seed: number): {
  scenarioCast: ScenarioCast;
  ambientCast: AmbientCast;
  scoredIngest: ScoredIngestSource;
} {
  const env: WorldEnv = {
    world,
    distances: distanceTable(world),
    timetable: buildTimetable(world),
    control: controlReference,
  };
  const ambientCast: AmbientCast = {
    fixtures: buildAmbientFixtures(world, env.timetable),
    ...buildAmbientSpawners(world, seed),
  };
  const toEvent = (t: TimedReading<WorldReading>, id: number): PipeEvent =>
    composeEvent(t, id, { tsOf, format, endpointIdOf });
  return {
    scenarioCast: { members: [], env, runSeed: seed },
    ambientCast,
    scoredIngest: {
      ingress: new ScoredIngress(),
      toEvent,
      // Never closes (GH126-PLAN.md Q0, Q2): the baseline run has no end, so no
      // tick is ever >= this.
      lastScoredTick: Number.POSITIVE_INFINITY,
    },
  };
}
