import { describe, expect, it } from "vitest";
import { Clock, ManualDriver } from "../game/clock";
import { Channel } from "./channel";
import { isEndOfStream, type PipeEvent, type PipeMessage } from "./event";
import { ScoredIngress } from "./scored-ingress";
import { runIngest, type TaskClock } from "./tasks";

const HZ = 60;

/** Drain the microtask queue without any real timer. Mirrors tasks.test.ts. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

/** A no-op admit hook, for tests that do not exercise admission counting. */
const noAdmit = (): void => undefined;

function ev(id: number, ts: number, payload: unknown = { u: "bob" }): PipeEvent {
  return { id, ts, endpoint: "kiosk-v1", payload };
}

function idOf(message: PipeMessage): number {
  return isEndOfStream(message) ? -1 : message.id;
}

/** A clock whose gate and sleep resolve at once: pace comes from channel flow only. */
const idleClock: TaskClock = {
  now: () => 0,
  gate: () => Promise.resolve(),
  sleep: () => Promise.resolve(),
};

describe("ScoredIngress state transitions", () => {
  it("starts pending, moves to ready on offer, and reaches closed once drained", async () => {
    const ingress = new ScoredIngress();
    expect(ingress.state).toBe("pending");

    ingress.offer(ev(0, 0));
    expect(ingress.state).toBe("ready");

    ingress.close(); // horizon passed, but the offered event is still buffered
    const out = new Channel<PipeMessage>(10);
    const pump = ingress.pump(out, idleClock, noAdmit);
    await flush();
    await pump; // drains the one event, then pushes the single marker and returns

    expect(ingress.state).toBe("closed");
    expect(idOf(await out.pull())).toBe(0);
    expect(isEndOfStream(await out.pull())).toBe(true);
  });

  it("moves to failed from pending", () => {
    const ingress = new ScoredIngress();
    const boom = new Error("teardown");
    ingress.fail(boom);
    expect(ingress.state).toBe("failed");
  });

  it("moves to failed from ready", () => {
    const ingress = new ScoredIngress();
    ingress.offer(ev(0, 0));
    const boom = new Error("teardown");
    ingress.fail(boom);
    expect(ingress.state).toBe("failed");
  });

  it("moves to failed from closed", async () => {
    const ingress = new ScoredIngress();
    ingress.close();
    expect(ingress.state).toBe("closed");
    const boom = new Error("teardown");
    ingress.fail(boom);
    expect(ingress.state).toBe("failed");
  });

  it("rejects an offer made after close, since the horizon already passed", () => {
    const ingress = new ScoredIngress();
    ingress.close();
    expect(() => ingress.offer(ev(0, 0))).toThrow(/close/);
  });
});

// GH126-PLAN.md finding 8 / seam 12: `size` exposes the buffered-but-unpumped count
// for the ingress's own backlog getter and for the tests below. The engine's
// wave-scoped queue metric no longer reads it directly — it computes the exact
// offered-minus-processed watermark instead (`nextScoredEventId -
// inspector.processedCount()`, `engine.ts`) — but this getter still needs covering
// on its own terms.
describe("ScoredIngress size (the buffered backlog, GH126 seam 12)", () => {
  it("counts offered events still buffered, and drops to zero once pump drains them", async () => {
    const ingress = new ScoredIngress();
    expect(ingress.size).toBe(0);

    ingress.offer(ev(0, 0));
    ingress.offer(ev(1, 2));
    ingress.offer(ev(2, 4));
    expect(ingress.size).toBe(3); // three offered, none pumped yet

    ingress.close();
    const out = new Channel<PipeMessage>(10);
    await ingress.pump(out, idleClock, noAdmit);
    expect(ingress.size).toBe(0); // fully drained
  });
});

describe("ScoredIngress backpressure", () => {
  it("blocks pump on a full channel and fires onAdmit only after the channel accepts", async () => {
    const out = new Channel<PipeMessage>(1);
    await out.push({ id: -1, ts: -1, endpoint: "filler", payload: null }); // fill the one slot

    const ingress = new ScoredIngress();
    ingress.offer(ev(0, 0));

    let admits = 0;
    const pump = ingress.pump(out, idleClock, () => {
      admits += 1;
    });
    await flush();
    // The channel is full: the event is taken from ScoredIngress but still parked on push.
    expect(admits).toBe(0);

    await out.pull(); // frees the slot, letting the blocked push settle
    await flush();
    expect(admits).toBe(1);

    ingress.fail(new Error("teardown")); // unwind the still-parked pump loop
    await pump.catch(() => undefined);
  });
});

describe("ScoredIngress pause and freeze parity with runIngest", () => {
  it("admits a due-now event whose gate already passed, even once the clock is then paused", async () => {
    // Mirrors run-controller.ts: the engine's tasks start (and pass their first gate
    // while the clock still runs), and only then does the controller call pause() --
    // one line later, per GH117-PLAN.md Part C. So a due-now event admits despite the
    // run "starting frozen." The same schedule and clock drive both a legacy runIngest
    // and a ScoredIngress.pump, and their admissions must agree.
    const driver = new ManualDriver();
    const clock = new Clock(HZ, driver);

    const legacyEvents = [ev(0, 0)];
    let i = 0;
    const legacyOut = new Channel<PipeMessage>(10);
    const legacyAdmits: number[] = [];
    const legacyDone = runIngest(
      legacyOut,
      clock,
      () => (i < legacyEvents.length ? (legacyEvents[i++] ?? null) : null),
      () => legacyAdmits.push(0),
    );
    legacyDone.catch(() => undefined);

    const ingress = new ScoredIngress();
    ingress.offer(ev(0, 0)); // primed before the clock loop starts, per Part C
    const liveOut = new Channel<PipeMessage>(10);
    const liveAdmits: number[] = [];
    const livePump = ingress.pump(liveOut, clock, () => liveAdmits.push(0));
    livePump.catch(() => undefined);

    // Both gate() calls above already resolved (the clock is still running); pause now,
    // one line later, exactly like run-controller does for a frozen start.
    clock.pause();

    await flush();

    expect(legacyAdmits).toEqual([0]); // legacy admitted the due-now Event despite the freeze
    expect(liveAdmits).toEqual([0]); // ScoredIngress agrees: same admission under the same freeze
    expect(idOf(await legacyOut.pull())).toBe(0);
    expect(idOf(await liveOut.pull())).toBe(0);

    // Both loops are now parked on clock.gate() for their second iteration (paused,
    // no more Events due). clock.stop() rejects that gate, unwinding both -- fail()
    // alone would not, since the park is on the clock, not on ScoredIngress's own
    // waiter.
    clock.stop();
    await Promise.allSettled([legacyDone, livePump]);
  });

  it("holds pump behind a paused gate, then still respects a full channel after resume", async () => {
    // Paused before either loop's first gate(), so neither may even attempt a push.
    // On resume, ordinary channel backpressure still applies exactly as it does for
    // runIngest: both block on the full channel until a pull frees the slot.
    const driver = new ManualDriver();
    const clock = new Clock(HZ, driver);
    clock.pause();

    const filler: PipeMessage = { id: -1, ts: -1, endpoint: "filler", payload: null };
    const legacyEvents = [ev(0, 0)];
    let i = 0;
    const legacyOut = new Channel<PipeMessage>(1);
    await legacyOut.push(filler); // pre-fill the one slot
    const legacyAdmits: number[] = [];
    runIngest(
      legacyOut,
      clock,
      () => (i < legacyEvents.length ? (legacyEvents[i++] ?? null) : null),
      () => legacyAdmits.push(0),
    ).catch(() => undefined);

    const ingress = new ScoredIngress();
    ingress.offer(ev(0, 0));
    const liveOut = new Channel<PipeMessage>(1);
    await liveOut.push(filler);
    const liveAdmits: number[] = [];
    const livePump = ingress.pump(liveOut, clock, () => liveAdmits.push(0));
    livePump.catch(() => undefined);

    await flush();
    // Paused before the first gate(): neither loop has even attempted its push yet.
    expect(legacyAdmits).toEqual([]);
    expect(liveAdmits).toEqual([]);

    clock.resume();
    await flush();
    // Resumed, but the channel is still full: both pushes block the same way, so
    // onAdmit has still not fired for either source.
    expect(legacyAdmits).toEqual([]);
    expect(liveAdmits).toEqual([]);

    await legacyOut.pull(); // drains the filler, freeing the slot for the blocked push
    await liveOut.pull();
    await flush();
    expect(legacyAdmits).toEqual([0]);
    expect(liveAdmits).toEqual([0]);

    clock.stop();
  });
});

describe("ScoredIngress teardown", () => {
  it("rejects a parked pump with fail's error, and the promise settles with no hang", async () => {
    const ingress = new ScoredIngress();
    const out = new Channel<PipeMessage>(10);
    let settled = false;
    let caught: unknown;
    const pump = ingress.pump(out, idleClock, noAdmit).catch((error: unknown) => {
      caught = error;
      settled = true;
    });
    await flush();
    expect(settled).toBe(false); // parked: no event offered yet, nothing to consume

    const boom = new Error("teardown");
    ingress.fail(boom);
    await pump;

    expect(settled).toBe(true);
    expect(caught).toBe(boom);
  });
});

describe("ScoredIngress end-of-stream", () => {
  it("yields every buffered event then exactly one END_OF_STREAM, and pump returns", async () => {
    const ingress = new ScoredIngress();
    ingress.offer(ev(0, 0));
    ingress.offer(ev(1, 0));
    ingress.offer(ev(2, 0));
    ingress.close();

    const out = new Channel<PipeMessage>(10);
    let admits = 0;
    let done = false;
    const pump = ingress
      .pump(out, idleClock, () => {
        admits += 1;
      })
      .then(() => {
        done = true;
      });
    await pump;

    expect(done).toBe(true);
    expect(admits).toBe(3);
    const a = await out.pull();
    const b = await out.pull();
    const c = await out.pull();
    const d = await out.pull();
    expect([idOf(a), idOf(b), idOf(c)]).toEqual([0, 1, 2]); // buffered order held
    expect(isEndOfStream(d)).toBe(true);
    expect(out.accepted).toBe(4); // exactly one marker, after the three real Events
  });
});
