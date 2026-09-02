/**
 * ScoredIngress: a clock-gated, bounded live source between a synchronous
 * producer (the engine's tick listener) and an async channel consumer
 * (the pipeline's Ingest edge, `tasks.ts:150`).
 *
 * `runIngest` pulls a precomposed, immutable schedule: `nextEvent()` returns
 * the next Event or `null` at exhaustion, and that `null` is the one signal
 * that closes the run. A live source cannot use that two-signal contract,
 * because an empty-but-still-open source (nothing scored yet this tick) is
 * not the same as a finished run, and a `null` read at the wrong moment
 * would finalize the scorer early. `ScoredIngress` replaces the pull source
 * with an explicit three-signal contract instead: `offer` (a new Event is
 * ready), `close` (the scored horizon passed; drain then end), and `fail`
 * (teardown; unwind now). See GH117-PLAN.md Part C for the full rationale.
 *
 * It owns four invariants by construction, so nothing outside it re-derives
 * them at the seam:
 *
 * 1. State is one of `pending` (open, nothing ready), `ready` (an Event is
 *    buffered), `closed` (the horizon passed and the buffer is drained), or
 *    `failed` (cancelled on teardown).
 * 2. `offer` and `close` are synchronous and never block, so the caller (a
 *    tick listener) stays synchronous.
 * 3. `pump` mirrors `runIngest`'s loop exactly: gate on the clock, take the
 *    next ready Event, push it to the bounded channel, THEN call `onAdmit`.
 *    It adds no atomic pause re-check at the admit point. That is
 *    deliberate parity, not a gap: legacy admits a due-now Event whose gate
 *    already passed even if the clock is paused one line later
 *    (`run-controller.ts:518` calls `handle.pause()` only after the tasks
 *    have started and passed their first gate). A stronger "never admit on
 *    a frozen tick" guard would re-park that Event and diverge from legacy.
 * 4. Backpressure and buffering: `pump` blocks on `out.push` exactly as
 *    `runIngest` does, so offered Events buffer inside this module, in
 *    order, until the channel has room.
 */
import type { Channel } from "./channel";
import { END_OF_STREAM, type PipeEvent, type PipeMessage } from "./event";
import type { TaskClock } from "./tasks";

export type ScoredIngressState = "pending" | "ready" | "closed" | "failed";

/** What `take()` resolves to: a real Event, or the drained-and-closed signal. */
type Ready = { readonly kind: "event"; readonly event: PipeEvent } | { readonly kind: "end" };

/** A single parked `take()` waiter. At most one exists: `pump` is the sole consumer. */
interface Waiter {
  resolve: (ready: Ready) => void;
  reject: (error: unknown) => void;
}

export class ScoredIngress {
  private readonly queue: PipeEvent[] = [];
  private horizonClosed = false;
  private failed = false;
  private failure: unknown;
  private waiter: Waiter | undefined;

  /**
   * The current state. `ready` covers both "buffered, horizon open" and
   * "buffered, horizon closed but not yet drained": either way there is a
   * real Event still to admit. `closed` is reserved for the fully drained
   * horizon, matching `runIngest`'s single end-of-stream marker.
   */
  get state(): ScoredIngressState {
    if (this.failed) {
      return "failed";
    }
    if (this.queue.length > 0) {
      return "ready";
    }
    if (this.horizonClosed) {
      return "closed";
    }
    return "pending";
  }

  /**
   * How many offered Events are buffered here, not yet taken by `pump` (GH126-PLAN.md
   * finding 8, seam 12). The engine's wave-scoped queue metric adds this to the
   * channel sizes so the backlog it peaks over includes Events still waiting inside
   * this source, not only those already pushed onto a channel. Zero once drained.
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Append one ID-assigned scored Event. Synchronous, never blocks: the
   * tick listener that calls it stays synchronous. Throws if the horizon
   * already closed, since an Event offered after `close()` is a wiring bug,
   * not a race this module needs to tolerate. A stray offer after `fail()`
   * is ignored, since teardown may still be unwinding its callers.
   */
  offer(event: PipeEvent): void {
    if (this.failed) {
      return;
    }
    if (this.horizonClosed) {
      throw new Error("ScoredIngress.offer: cannot offer after close().");
    }
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ kind: "event", event });
      return;
    }
    this.queue.push(event);
  }

  /**
   * Mark the scored horizon passed. Synchronous, never blocks, and
   * idempotent. If nothing is buffered and a `pump` is parked waiting, wake
   * it with the drained-and-closed signal at once.
   */
  close(): void {
    if (this.failed || this.horizonClosed) {
      return;
    }
    this.horizonClosed = true;
    if (this.waiter && this.queue.length === 0) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ kind: "end" });
    }
  }

  /**
   * Cancel on teardown. Rejects any parked `pump` waiter with `error`, so it
   * unwinds through the same supervision as a Clock or Channel rejection.
   * Idempotent: only the first `fail` takes effect.
   */
  fail(error: unknown): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.failure = error;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.reject(error);
    }
  }

  /** Resolve the next Event, the drained-and-closed signal, or park until one arrives. */
  private take(): Promise<Ready> {
    if (this.failed) {
      return Promise.reject(this.failure);
    }
    const event = this.queue.shift();
    if (event) {
      return Promise.resolve({ kind: "event", event });
    }
    if (this.horizonClosed) {
      return Promise.resolve({ kind: "end" });
    }
    return new Promise<Ready>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  /**
   * The one loop that feeds the channel, mirroring `runIngest` exactly: gate
   * on the clock, await the next ready item, push it to the bounded channel,
   * then call `onAdmit` AFTER the channel accepts. On the drained-and-closed
   * signal it pushes exactly one `END_OF_STREAM` and returns.
   */
  async pump(out: Channel<PipeMessage>, clock: TaskClock, onAdmit: () => void): Promise<void> {
    for (;;) {
      await clock.gate();
      const next = await this.take();
      if (next.kind === "end") {
        await out.push(END_OF_STREAM); // the horizon drained; close it once
        return; // the marker is never admitted: onAdmit is for real Events only
      }
      await out.push(next.event);
      onAdmit(); // the Event has entered the Pipeline; the engine counts it admitted
    }
  }
}
