/**
 * The generic checkpoint-squeeze simulator (issue #89). A faithful integer model
 * of a run: arrivals follow an injected per-tick curve; the Detect node completes
 * events at the real governor's rate; a backpressure ceiling of `2 * channelCap`
 * caps how far admitted may lead completed, exactly as two bounded upstream
 * Channels do. A checkpoint is read at the start-of-tick boundary, before that
 * tick's service, so an event completing on the checkpoint tick still counts as
 * outstanding. The clock is 0-based, matching the game Clock: tick 0 is the first
 * step, so `arrivalsByTick[0]` is admitted like any other index.
 *
 * A controlled generalization of the kiosk winnability test's `simulate(rate)`:
 * the arrivals and the checkpoints are injected instead of built from the wave
 * schedule, so any caller can pass its own curve. The channel and governor math
 * is unchanged. `band.ts` imports no kiosk cost model and no test, so there is no
 * bad dependency direction and no cycle; `src/game/profiler/kiosk-band-calibration.ts`
 * holds every kiosk-specific number.
 */
import type { Checkpoint } from "../../sim/scenario";
import { makeGovernor, type ServiceRate } from "../../sim/service-governor";

export interface SimResult {
  outcome: "won" | "failed";
  /** The failing checkpoint's index, or -1 on a win. */
  failedCheckpoint: number;
  backlogAtFailure: number;
  maxBacklog: number;
}

export interface SimInput {
  /** Events entering per tick; the array index is the (0-based) tick. */
  arrivalsByTick: readonly number[];
  serviceRate: ServiceRate;
  channelCap: number;
  checkpoints: readonly Checkpoint[];
}

/** Integer channel + governor math. Deterministic. No wall clock. */
export function simulate(input: SimInput): SimResult {
  const { arrivalsByTick, serviceRate, channelCap, checkpoints } = input;
  const deadline = checkpoints[checkpoints.length - 1]?.atTick ?? 0;
  const governor = makeGovernor(serviceRate);
  const ceiling = 2 * channelCap;

  let scheduledCum = 0;
  let admitted = 0;
  let completed = 0;
  let detectFreeAt = 0; // the next tick Detect may pull, given its governor sleeps
  let maxBacklog = 0;
  let nextCheckpoint = 0;

  for (let tick = 0; tick <= deadline; tick++) {
    // Start-of-tick checkpoint evaluation, before this tick's arrivals and service.
    while (nextCheckpoint < checkpoints.length) {
      const cp = checkpoints[nextCheckpoint];
      if (!cp || cp.atTick > tick) {
        break;
      }
      const backlog = admitted - completed;
      const isFinal = nextCheckpoint === checkpoints.length - 1;
      if (backlog !== 0) {
        return {
          outcome: "failed",
          failedCheckpoint: nextCheckpoint,
          backlogAtFailure: backlog,
          maxBacklog,
        };
      }
      if (isFinal) {
        return { outcome: "won", failedCheckpoint: -1, backlogAtFailure: 0, maxBacklog };
      }
      nextCheckpoint += 1;
    }

    // Admit this tick's arrivals, held back by the backpressure ceiling.
    scheduledCum += arrivalsByTick[tick] ?? 0;
    admitted = Math.min(scheduledCum, completed + ceiling);

    // Serve as many Events as the governor allows this tick.
    while (tick >= detectFreeAt && admitted > completed) {
      const sleep = governor.charge();
      completed += 1;
      admitted = Math.min(scheduledCum, completed + ceiling);
      if (sleep > 0) {
        detectFreeAt = tick + sleep; // busy through the sleep, resuming later
        break;
      }
    }
    maxBacklog = Math.max(maxBacklog, admitted - completed);
  }

  const remaining = admitted - completed;
  return {
    outcome: remaining === 0 ? "won" : "failed",
    failedCheckpoint: remaining === 0 ? -1 : checkpoints.length - 1,
    backlogAtFailure: remaining,
    maxBacklog,
  };
}
