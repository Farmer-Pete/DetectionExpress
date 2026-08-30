import { describe, expect, it } from "vitest";
import { Clock, ManualDriver } from "../game/clock";
import { Channel } from "./channel";
import type { ScoredFinding } from "./correctness";
import { END_OF_STREAM, isEndOfStream, type PipeEvent, type PipeMessage } from "./event";
import type { Alert, DetectView, Finding } from "./finding";
import type { TaskInspector } from "./inspector";
import { RuleError } from "./rule-error";
import type { ServiceRate } from "./service-governor";
import {
  NODE_TASKS,
  type NodeRuntime,
  resolveEntity,
  runDetect,
  runIngest,
  runNormalize,
  runSink,
  type TaskClock,
  type TaskScorer,
} from "./tasks";

const HZ = 60;

/** A clock whose gate and sleep resolve at once: the task runs off channel flow. */
const idleClock: TaskClock = {
  now: () => 0,
  gate: () => Promise.resolve(),
  sleep: () => Promise.resolve(),
};

/** A rate so fast the governor never sleeps at these counts, so Detect timing is inert. */
const FAST_RATE: ServiceRate = { num: 1_000_000, den: 1 };

/** A no-op admit hook, for the tasks that do not exercise admission counting. */
const noAdmit = (): void => undefined;

/** A clock that records each sleep's tick count, so the governor charge is observable. */
function recordingClock(): TaskClock & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => 0,
    gate: () => Promise.resolve(),
    sleep: (ticks: number) => {
      sleeps.push(ticks);
      return Promise.resolve();
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

async function step(driver: ManualDriver, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    driver.tick();
    await flush();
  }
}

function guard(task: Promise<void>): void {
  task.catch(() => undefined);
}

function ev(id: number, ts: number, payload: unknown = { u: "bob" }): PipeEvent {
  return { id, ts, endpoint: "kiosk-v1", payload };
}

function idOf(message: PipeMessage): number {
  return isEndOfStream(message) ? -1 : message.id;
}

/** The flat view Detect hands the Rule: engine fields plus the normalized payload. */
interface FlatView {
  id: number;
  ts: number;
  endpoint: string;
  user: string;
}

function isFlatView(value: unknown): value is FlatView {
  return (
    value instanceof Object &&
    "id" in value &&
    "ts" in value &&
    "endpoint" in value &&
    "user" in value
  );
}

/** A scorer stub that records its calls, so a task test can observe them. */
function stubScorer(): TaskScorer & {
  records: Array<{ findings: readonly ScoredFinding[]; env: PipeEvent }>;
  finalizes: number;
} {
  const records: Array<{ findings: readonly ScoredFinding[]; env: PipeEvent }> = [];
  let finalizes = 0;
  return {
    records,
    get finalizes() {
      return finalizes;
    },
    record(findings, env) {
      records.push({ findings, env });
    },
    finalize() {
      finalizes += 1;
    },
  };
}

/** An inspector that does nothing, for tests that do not exercise the tap. */
const noopInspector: TaskInspector = {
  captureNormalized: () => undefined,
  markProcessed: () => undefined,
};

/** An inspector stub that records its calls, so a task test can observe them. */
function stubInspector(): TaskInspector & {
  captures: Array<{ id: number; ts: number; endpoint: string; raw: unknown; normalized: unknown }>;
  processedCalls: number;
} {
  const captures: Array<{
    id: number;
    ts: number;
    endpoint: string;
    raw: unknown;
    normalized: unknown;
  }> = [];
  let processedCalls = 0;
  return {
    captures,
    get processedCalls() {
      return processedCalls;
    },
    captureNormalized(id, ts, endpoint, raw, normalized) {
      captures.push({ id, ts, endpoint, raw, normalized });
    },
    markProcessed() {
      processedCalls += 1;
    },
  };
}

describe("runIngest schedule", () => {
  it("pushes same-tick Events in order, then exactly one marker at exhaustion", async () => {
    const driver = new ManualDriver();
    const clock = new Clock(HZ, driver);
    const out = new Channel<PipeMessage>(100);
    const events = [ev(0, 0), ev(1, 0), ev(2, 10)]; // GAME_SECONDS_PER_TICK=2 -> dueTicks 0,0,5
    let i = 0;
    guard(runIngest(out, clock, () => (i < events.length ? (events[i++] ?? null) : null), noAdmit));
    await flush();
    expect(out.accepted).toBe(2); // both ts=0 Events are due at tick 0

    await step(driver, 5); // reach tick 5, the third Event's due tick
    await flush();
    expect(out.accepted).toBe(4); // third Event, then the single marker

    const a = await out.pull();
    const b = await out.pull();
    const c = await out.pull();
    const d = await out.pull();
    expect([idOf(a), idOf(b), idOf(c)]).toEqual([0, 1, 2]); // schedule order held
    expect(isEndOfStream(d)).toBe(true);
    clock.stop();
  });

  it("holds overdue Events behind backpressure and admits them in order, no loss", async () => {
    const driver = new ManualDriver();
    const clock = new Clock(HZ, driver);
    const out = new Channel<PipeMessage>(2); // small cap forces backpressure
    const events = [ev(0, 0), ev(1, 0), ev(2, 2), ev(3, 4)]; // dueTicks 0,0,1,2
    let i = 0;
    let done = false;
    runIngest(out, clock, () => (i < events.length ? (events[i++] ?? null) : null), noAdmit)
      .then(() => {
        done = true;
      })
      .catch(() => undefined);
    await flush();
    expect(out.size).toBe(2); // two buffered, the third push is blocked

    await step(driver, 10); // time runs on; the blocked Events are now overdue
    const got: PipeMessage[] = [];
    for (let k = 0; k < 5; k++) {
      got.push(await out.pull());
      await flush();
    }
    expect(got.slice(0, 4).map(idOf)).toEqual([0, 1, 2, 3]); // FIFO order preserved
    const marker = got[4];
    expect(marker !== undefined && isEndOfStream(marker)).toBe(true); // one marker, last
    expect(done).toBe(true); // Ingest returned after the marker
    clock.stop();
  });

  it("calls onAdmit once per real Event, after its push, and never for the marker", async () => {
    const driver = new ManualDriver();
    const clock = new Clock(HZ, driver);
    const out = new Channel<PipeMessage>(100);
    const events = [ev(0, 0), ev(1, 0), ev(2, 0)]; // all due at tick 0
    let admits = 0;
    let i = 0;
    guard(
      runIngest(
        out,
        clock,
        () => (i < events.length ? (events[i++] ?? null) : null),
        () => {
          admits += 1;
        },
      ),
    );
    await flush();
    expect(admits).toBe(3); // one per real Event, none for the end-of-stream marker
    expect(out.accepted).toBe(4); // three Events plus the marker entered the channel
    clock.stop();
  });
});

describe("runNormalize", () => {
  it("replaces the payload and keeps id, ts, and endpoint", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    guard(
      runNormalize(
        input,
        output,
        idleClock,
        (raw) => ({
          user: raw instanceof Object && "u" in raw ? raw.u : null,
        }),
        noopInspector,
      ),
    );
    await input.push(ev(5, 100, { u: "bob" }));
    await flush();
    const out = await output.pull();
    expect(out).toEqual({ id: 5, ts: 100, endpoint: "kiosk-v1", payload: { user: "bob" } });
    input.close();
  });

  it("forwards the marker without calling the player's normalize", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    let calls = 0;
    let done = false;
    runNormalize(
      input,
      output,
      idleClock,
      (raw) => {
        calls += 1;
        return raw;
      },
      noopInspector,
    )
      .then(() => {
        done = true;
      })
      .catch(() => undefined);
    await input.push(END_OF_STREAM);
    await flush();
    expect(isEndOfStream(await output.pull())).toBe(true);
    expect(calls).toBe(0);
    expect(done).toBe(true);
  });

  it("turns a non-object normalize result into a structured error, not a crash", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    let err: unknown;
    runNormalize(input, output, idleClock, () => "not-an-object", noopInspector).catch(
      (e: unknown) => {
        err = e;
      },
    );
    await input.push(ev(1, 0));
    await flush();
    expect(err).toBeInstanceOf(RuleError);
    expect(err instanceof RuleError && err.phase).toBe("normalize");
  });

  it("keeps the FIFO order of Events and marker behind a full channel and does not hang", async () => {
    const input = new Channel<PipeMessage>(5);
    const output = new Channel<PipeMessage>(1); // tiny cap forces backpressure
    let done = false;
    runNormalize(input, output, idleClock, (raw) => raw, noopInspector)
      .then(() => {
        done = true;
      })
      .catch(() => undefined);
    await input.push(ev(1, 0));
    await input.push(ev(2, 0));
    await input.push(END_OF_STREAM);
    await flush();
    const got: PipeMessage[] = [];
    for (let k = 0; k < 3; k++) {
      got.push(await output.pull());
      await flush();
    }
    expect(got.map(idOf)).toEqual([1, 2, -1]); // Events then marker, in order
    expect(done).toBe(true);
  });
});

// Seam: the inspector tap runNormalize writes to (GH28-PLAN.md).
describe("runNormalize inspector capture", () => {
  it("captures raw paired with normalized, keyed by id/ts/endpoint", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    const inspector = stubInspector();
    guard(
      runNormalize(
        input,
        output,
        idleClock,
        (raw) => ({ user: raw instanceof Object && "u" in raw ? raw.u : null }),
        inspector,
      ),
    );
    await input.push(ev(5, 100, { u: "bob" }));
    await flush();
    expect(inspector.captures).toEqual([
      { id: 5, ts: 100, endpoint: "kiosk-v1", raw: { u: "bob" }, normalized: { user: "bob" } },
    ]);
    input.close();
  });

  it("captures even when the downstream push is blocked by backpressure", async () => {
    const input = new Channel<PipeMessage>(5);
    const output = new Channel<PipeMessage>(1); // tiny cap: the second push blocks
    const inspector = stubInspector();
    guard(runNormalize(input, output, idleClock, (raw) => raw, inspector));
    await input.push(ev(1, 0, { u: "a" }));
    await input.push(ev(2, 0, { u: "b" }));
    await flush();
    // Capture runs before the push, so a blocked downstream never gates it.
    expect(inspector.captures.map((c) => c.id)).toEqual([1, 2]);
    input.close();
  });

  it("captures nothing when normalize throws: the ring is never half-written", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    const inspector = stubInspector();
    runNormalize(
      input,
      output,
      idleClock,
      () => {
        throw new Error("boom");
      },
      inspector,
    ).catch(() => undefined);
    await input.push(ev(1, 0));
    await flush();
    expect(inspector.captures).toHaveLength(0);
  });

  it("captures nothing on the end-of-stream marker", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    const inspector = stubInspector();
    guard(runNormalize(input, output, idleClock, (raw) => raw, inspector));
    await input.push(END_OF_STREAM);
    await flush();
    expect(inspector.captures).toHaveLength(0);
  });
});

describe("runDetect", () => {
  it("records the finding against the Event and forwards the Event downstream", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    const scorer = stubScorer();
    const alert: Alert = { reason: "pin_brute_force", at: 100, eventIds: [1, 2] };
    guard(runDetect(input, output, idleClock, () => [{ alert }], scorer, noopInspector, FAST_RATE));
    await input.push(ev(5, 100, { user: "bob" }));
    await flush();
    expect(scorer.records).toHaveLength(1);
    // The task hands the scorer canonical ScoredFinding[]; no subject, so no entity.
    expect(scorer.records[0]?.findings).toEqual([{ finding: { alert } }]);
    expect(scorer.records[0]?.env.id).toBe(5);
    expect(idOf(await output.pull())).toBe(5); // Event forwarded to the Sink
    input.close();
  });

  it("passes partials through to the scorer, which now owns the skip (Seam G)", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    const scorer = stubScorer();
    const partial: Finding = {
      alert: { reason: "pin_brute_force", at: 8, eventIds: [1] },
      eventId: 1,
      isPartial: true,
    };
    const resolved: Finding = { alert: { reason: "pin_brute_force", at: 9, eventIds: [2] } };
    // The task no longer folds out partials; both reach the scorer as ScoredFinding.
    guard(
      runDetect(
        input,
        output,
        idleClock,
        () => [partial, resolved],
        scorer,
        noopInspector,
        FAST_RATE,
      ),
    );
    await input.push(ev(3, 0));
    await flush();
    expect(scorer.records[0]?.findings).toEqual([{ finding: partial }, { finding: resolved }]);
    input.close();
  });

  it("resolves each finding's entity from the view and passes it to the scorer", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    const scorer = stubScorer();
    // A subject-bearing finding: subjectType "user" resolves to the view's user field.
    const finding: Finding = {
      alert: { reason: "pin_brute_force", at: 5, eventIds: [3] },
      eventId: 3,
      subjectType: "user",
    };
    guard(runDetect(input, output, idleClock, () => [finding], scorer, noopInspector, FAST_RATE));
    await input.push(ev(3, 0, { user: "amy" }));
    await flush();
    expect(scorer.records[0]?.findings).toEqual([{ finding, entity: "amy" }]);
    input.close();
  });

  it("hands the Rule a flat view that a payload field cannot shadow", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    let seen: unknown;
    guard(
      runDetect(
        input,
        output,
        idleClock,
        (view) => {
          seen = view;
          return [];
        },
        stubScorer(),
        noopInspector,
        FAST_RATE,
      ),
    );
    // The payload carries id/ts/endpoint that must NOT win over the envelope.
    await input.push({
      id: 7,
      ts: 200,
      endpoint: "kiosk-v1",
      payload: { id: 999, ts: 999, endpoint: "evil", user: "bob" },
    });
    await flush();
    expect(isFlatView(seen)).toBe(true);
    if (isFlatView(seen)) {
      expect(seen.id).toBe(7); // the envelope id wins over the payload's 999
      expect(seen.ts).toBe(200);
      expect(seen.endpoint).toBe("kiosk-v1");
      expect(seen.user).toBe("bob");
    }
    input.close();
  });

  it("calls finalize exactly once and forwards the marker at end of stream", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    const scorer = stubScorer();
    let done = false;
    runDetect(input, output, idleClock, () => [], scorer, noopInspector, FAST_RATE)
      .then(() => {
        done = true;
      })
      .catch(() => undefined);
    await input.push(ev(1, 0));
    await input.push(END_OF_STREAM);
    await flush();
    expect(scorer.finalizes).toBe(1);
    expect(idOf(await output.pull())).toBe(1); // the Event first
    expect(isEndOfStream(await output.pull())).toBe(true); // then the marker
    expect(done).toBe(true);
  });

  it("turns a throwing detect into a structured error, not a crash", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    let err: unknown;
    runDetect(
      input,
      output,
      idleClock,
      () => {
        throw new Error("boom in detect");
      },
      stubScorer(),
      noopInspector,
      FAST_RATE,
    ).catch((e: unknown) => {
      err = e;
    });
    await input.push(ev(1, 0));
    await flush();
    expect(err).toBeInstanceOf(RuleError);
    expect(err instanceof RuleError && err.phase).toBe("detect");
  });

  it("turns a non-Finding detect return into a structured error, not a crash", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    let err: unknown;
    runDetect(
      input,
      output,
      idleClock,
      () => ({ nope: 1 }),
      stubScorer(),
      noopInspector,
      FAST_RATE,
    ).catch((e: unknown) => {
      err = e;
    });
    await input.push(ev(1, 0));
    await flush();
    expect(err).toBeInstanceOf(RuleError);
    expect(err instanceof RuleError && err.phase).toBe("detect");
  });

  it("charges the governor per real Event, after record and before push, never on the marker", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    const clock = recordingClock();
    // 0.5 records per tick -> the governor sleeps two whole ticks per Event.
    guard(
      runDetect(input, output, clock, () => [], stubScorer(), noopInspector, { num: 1, den: 2 }),
    );
    await input.push(ev(1, 0));
    await input.push(ev(2, 0));
    await input.push(ev(3, 0));
    await input.push(END_OF_STREAM);
    await flush();
    expect(clock.sleeps).toEqual([2, 2, 2]); // one charge per Event, none for the marker
  });

  it("does not sleep when the rate is fast enough to owe no whole tick", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    const clock = recordingClock();
    // 20 records per tick: the first Events owe a zero-tick charge, so no sleep.
    guard(
      runDetect(input, output, clock, () => [], stubScorer(), noopInspector, { num: 20, den: 1 }),
    );
    await input.push(ev(1, 0));
    await input.push(ev(2, 0));
    await input.push(END_OF_STREAM);
    await flush();
    expect(clock.sleeps).toEqual([]); // charge returned zero, so Detect never slept
  });
});

// Seam: the inspector watermark runDetect writes to (GH28-PLAN.md).
describe("runDetect inspector watermark", () => {
  it("marks processed once per real Event, after record and before the governor charge", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    const order: string[] = [];
    const orderedScorer: TaskScorer = {
      record: () => {
        order.push("record");
      },
      finalize: () => undefined,
    };
    const orderedInspector: TaskInspector = {
      captureNormalized: () => undefined,
      markProcessed: () => {
        order.push("markProcessed");
      },
    };
    const clock = recordingClock();
    const orderedClock: TaskClock = {
      now: clock.now,
      gate: clock.gate,
      sleep: (ticks) => {
        order.push("charge");
        return clock.sleep(ticks);
      },
    };
    // 0.5 records per tick: the governor sleeps, so its charge lands in order.
    guard(
      runDetect(input, output, orderedClock, () => [], orderedScorer, orderedInspector, {
        num: 1,
        den: 2,
      }),
    );
    await input.push(ev(1, 0));
    await flush();
    expect(order).toEqual(["record", "markProcessed", "charge"]);
  });

  it("increments the watermark once per real Event, never for the marker", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    const inspector = stubInspector();
    guard(runDetect(input, output, idleClock, () => [], stubScorer(), inspector, FAST_RATE));
    await input.push(ev(1, 0));
    await input.push(ev(2, 0));
    await input.push(END_OF_STREAM);
    await flush();
    expect(inspector.processedCalls).toBe(2);
  });
});

// Seam F: strict entity resolution off the Detect view.
describe("resolveEntity", () => {
  const view: DetectView = {
    id: 1,
    ts: 2,
    endpoint: "kiosk-v1",
    acct: "amy",
    count: 7,
    notFinite: Number.NaN,
    nested: { deep: true },
  };
  const withSubject = (subjectType: string): Finding => ({
    alert: { reason: "r", at: 0, eventIds: [1] },
    eventId: 1,
    subjectType,
  });

  it("returns undefined when the finding names no subject", () => {
    const finding: Finding = { alert: { reason: "r", at: 0, eventIds: [1] } };
    expect(resolveEntity(finding, view)).toBeUndefined();
  });

  it("returns the string the subjectType names", () => {
    expect(resolveEntity(withSubject("acct"), view)).toBe("amy");
  });

  it("stringifies a finite number the subjectType names", () => {
    expect(resolveEntity(withSubject("count"), view)).toBe("7");
  });

  it("throws a detect RuleError when the subjectType names no field", () => {
    let err: unknown;
    try {
      resolveEntity(withSubject("missing"), view);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RuleError);
    expect(err instanceof RuleError && err.phase).toBe("detect");
  });

  it("throws when the subjectType resolves to a non-primitive", () => {
    expect(() => resolveEntity(withSubject("nested"), view)).toThrow(RuleError);
  });

  it("throws when the subjectType resolves to a non-finite number", () => {
    expect(() => resolveEntity(withSubject("notFinite"), view)).toThrow(RuleError);
  });

  it("surfaces a resolveEntity failure inside runDetect as one clean RuleError", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    let err: unknown;
    // subjectType names a field the view lacks, so resolveEntity throws inside the try.
    runDetect(
      input,
      output,
      idleClock,
      () => [{ alert: { reason: "r", at: 0, eventIds: [1] }, eventId: 1, subjectType: "nope" }],
      stubScorer(),
      noopInspector,
      FAST_RATE,
    ).catch((e: unknown) => {
      err = e;
    });
    await input.push(ev(1, 0, { user: "amy" })); // no "nope" field on the view
    await flush();
    expect(err).toBeInstanceOf(RuleError);
    expect(err instanceof RuleError && err.phase).toBe("detect");
  });
});

// Seam I: two-pass canonicalization and clone safety at the runDetect boundary.
describe("runDetect canonicalization (Seam I)", () => {
  it("turns an exotic finding that throws on serialization into a RuleError", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    let err: unknown;
    // A Proxy finding whose get trap throws: parsing or serializing it must not crash.
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error("exotic trap");
        },
        has() {
          return true;
        },
      },
    );
    runDetect(input, output, idleClock, () => [trap], stubScorer(), noopInspector, FAST_RATE).catch(
      (e: unknown) => {
        err = e;
      },
    );
    await input.push(ev(1, 0));
    await flush();
    expect(err).toBeInstanceOf(RuleError);
    expect(err instanceof RuleError && err.phase).toBe("detect");
  });

  it("rejects a toJSON that silently returns malformed data via the second parse pass", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    let err: unknown;
    // Well-formed to the first parse, but toJSON serializes to {} with no alert.
    const finding = { alert: { reason: "r", at: 1, eventIds: [1] } };
    Object.defineProperty(finding, "toJSON", { enumerable: false, value: () => ({}) });
    runDetect(
      input,
      output,
      idleClock,
      () => [finding],
      stubScorer(),
      noopInspector,
      FAST_RATE,
    ).catch((e: unknown) => {
      err = e;
    });
    await input.push(ev(1, 0));
    await flush();
    expect(err).toBeInstanceOf(RuleError);
    expect(err instanceof RuleError && err.phase).toBe("detect");
  });

  it("canonicalizes a well-formed finding to plain data the scorer can store", async () => {
    const input = new Channel<PipeMessage>(10);
    const output = new Channel<PipeMessage>(10);
    const scorer = stubScorer();
    const finding: Finding = {
      alert: { reason: "pin_brute_force", at: 5, eventIds: [1, 2] },
      context: [{ type: "text", text: "caught" }],
    };
    guard(runDetect(input, output, idleClock, () => [finding], scorer, noopInspector, FAST_RATE));
    await input.push(ev(1, 0));
    await flush();
    const passed = scorer.records[0]?.findings[0]?.finding;
    expect(passed).toEqual(finding); // plain, structurally equal
    input.close();
  });
});

describe("runSink", () => {
  it("completes each Event but consumes the marker without a completion", async () => {
    const input = new Channel<PipeMessage>(10);
    let completes = 0;
    let done = false;
    runSink(input, idleClock, () => {
      completes += 1;
    })
      .then(() => {
        done = true;
      })
      .catch(() => undefined);
    await input.push(ev(1, 0));
    await input.push(ev(2, 0));
    await input.push(END_OF_STREAM);
    await flush();
    expect(completes).toBe(2); // two Events, the marker does not count
    expect(done).toBe(true); // returned on the marker
  });
});

describe("NODE_TASKS registry", () => {
  const runtime: NodeRuntime = {
    clock: idleClock,
    onComplete: () => undefined,
    onAdmit: () => undefined,
    algorithm: { normalize: (raw) => raw, detect: () => [] },
    scorer: { record: () => undefined, finalize: () => undefined },
    inspector: noopInspector,
    nextEvent: () => null,
    serviceRate: FAST_RATE,
  };
  const noWiring = { input: undefined, output: undefined };

  it("registers a task for each of the four chain kinds", () => {
    expect(NODE_TASKS.has("ingest")).toBe(true);
    expect(NODE_TASKS.has("normalize")).toBe(true);
    expect(NODE_TASKS.has("detect")).toBe(true);
    expect(NODE_TASKS.has("sink")).toBe(true);
  });

  it("fails fast when a task is missing its wiring", () => {
    expect(() => NODE_TASKS.get("ingest")?.("ingest", noWiring, runtime)).toThrow(/output/i);
    expect(() => NODE_TASKS.get("normalize")?.("normalize", noWiring, runtime)).toThrow(/input/i);
    expect(() => NODE_TASKS.get("detect")?.("detect", noWiring, runtime)).toThrow(/input/i);
    expect(() => NODE_TASKS.get("sink")?.("sink", noWiring, runtime)).toThrow(/input/i);
  });
});
