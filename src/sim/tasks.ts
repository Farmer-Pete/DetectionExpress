/**
 * Node task logic. Each node is an independent async loop. Each turn it passes
 * the Clock gate, moves one message over its channel, and waits on the Clock. So
 * a pause holds every task at its next turn, and a stop unwinds it through a
 * rejected wait. No abort code lives here.
 *
 * The pipeline is the locked chain Ingest -> Normalize -> Detect -> Sink. Ingest
 * plays a seeded schedule and closes it with a single end-of-stream marker. The
 * marker rides the same FIFO all the way through, so every task ends cleanly and
 * in order (Detect after `finalize`, Sink after consuming it).
 *
 * The tasks depend only on a minimal clock contract, so `sim/` never imports the
 * concrete Clock from `game/`.
 */
import { GAME_SECONDS_PER_TICK } from "../game/tuning";
import type { Channel } from "./channel";
import type { ScoredFinding } from "./correctness";
import { END_OF_STREAM, isEndOfStream, type PipeEvent, type PipeMessage } from "./event";
import type { DetectView, Finding } from "./finding";
import type { TaskInspector } from "./inspector";
import { parseFindings } from "./parse-findings";
import { RuleError } from "./rule-error";
import { makeGovernor, type ServiceRate } from "./service-governor";

/** The slice of the Clock a task needs. The concrete Clock satisfies it. */
export interface TaskClock {
  now(): number;
  gate(): Promise<void>;
  sleep(ticks: number): Promise<void>;
}

/**
 * The player's loaded Rule, as the tasks call it. Injected by the run controller.
 * Both return an untyped value: the player owns the code, so the Detect task parses
 * their return at this boundary before handing it to the scorer.
 */
export interface TaskAlgorithm {
  normalize: (raw: unknown, endpoint: string) => unknown;
  detect: (e: unknown) => unknown;
}

/** The scorer surface the Detect task drives. The full scorer also reads. */
export interface TaskScorer {
  record: (findings: readonly ScoredFinding[], env: PipeEvent) => void;
  finalize: () => void;
}

/** A readable message for a thrown value, with a source frame when it carries one. */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const frame = error.stack?.split("\n")[1]?.trim();
    return frame?.startsWith("at ") ? `${error.message} (${frame.slice(3)})` : error.message;
  }
  return String(error);
}

/**
 * A plain object: `{}` or `Object.create(null)`, not an array, Date, Map, or
 * class instance. `Object.getPrototypeOf` boxes a primitive rather than
 * throwing, so every non-object domain value lands on its own wrapper
 * prototype here and is rejected the same way as a class instance.
 */
function isPlainObject(value: unknown): value is object {
  if (value === null || value === undefined) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Accept the Rule's normalize result only when it is a plain object to forward. */
export function normalizedPayload(value: unknown): object {
  if (isPlainObject(value)) {
    return value;
  }
  throw new RuleError("normalize", "normalize must return a plain object.");
}

/** The engine-owned fields the Detect view carries alongside the normalized payload. */
export interface EngineFields {
  id: number;
  ts: number;
  endpoint: string;
}

/**
 * Build the flat Detect view: the normalized payload spread first, then the engine
 * fields, so a payload field named `id` cannot shadow the real id. The profiler
 * reproduces this exact view, so both the runtime and the profiler call this.
 */
export function withEngineFields<T extends object>(
  base: T,
  id: number,
  ts: number,
  endpoint: string,
): T & EngineFields {
  return { ...base, id, ts, endpoint };
}

/**
 * A primitive string, by its tag (mirrors `parse-findings.ts`). The `instanceof
 * Object` guard rejects a boxed `new String(...)`, which is not the primitive the
 * entity contract promises.
 */
function isString(value: unknown): value is string {
  return !(value instanceof Object) && Object.prototype.toString.call(value) === "[object String]";
}

/** A primitive finite number, by its tag. A boxed Number or a non-finite value fails. */
function isFiniteNumber(value: unknown): value is number {
  return (
    !(value instanceof Object) &&
    Object.prototype.toString.call(value) === "[object Number]" &&
    Number.isFinite(value)
  );
}

/**
 * Resolve a finding's subject to a string entity from the Detect view. No
 * `subjectType` -> undefined. A present `subjectType` that does not resolve to a
 * string or finite number is a contract violation (finding.ts: "a subjectType that
 * names no field on the record is an error") and throws a detect-phase RuleError.
 * Called inside `runDetect`'s try, so the throw surfaces as one clean RuleError.
 */
export function resolveEntity(finding: Finding, view: DetectView): string | undefined {
  if (finding.subjectType === undefined) {
    return undefined;
  }
  const raw = view[finding.subjectType];
  if (isString(raw)) {
    return raw;
  }
  if (isFiniteNumber(raw)) {
    return String(raw);
  }
  throw new RuleError(
    "detect",
    `subjectType "${finding.subjectType}" did not resolve to a string or finite number.`,
  );
}

/**
 * The Ingest task: the source. It plays the seeded schedule from `nextEvent`.
 * For each Event it sleeps until the Clock reaches the Event's due tick, then
 * pushes. Same-tick Events push in order; overdue Events push at once; a full
 * channel blocks the push, so later Events wait and admission lags while `ts`
 * stays the scheduled value. When the schedule is exhausted (the source returns
 * null) it pushes exactly one end-of-stream marker, then returns.
 */
export async function runIngest(
  out: Channel<PipeMessage>,
  clock: TaskClock,
  nextEvent: () => PipeEvent | null,
  onAdmit: () => void,
): Promise<void> {
  for (;;) {
    await clock.gate();
    const event = nextEvent();
    if (event === null) {
      await out.push(END_OF_STREAM); // the schedule ran out; close it once
      return; // the marker is never admitted: onAdmit is for real Events only
    }
    const dueTick = Math.round(event.ts / GAME_SECONDS_PER_TICK);
    const wait = dueTick - clock.now();
    if (wait > 0) {
      await clock.sleep(wait);
    }
    await out.push(event);
    onAdmit(); // the Event has entered the Pipeline; the engine counts it admitted
  }
}

/**
 * The Normalize task: an Event -> replace its payload with the Rule's normalize
 * result and forward a fresh envelope. A marker -> forward it unchanged, without
 * calling player code, then return.
 *
 * On the success path, `inspector.captureNormalized` runs after `normalizedPayload`
 * validates and before `output.push`. A throw in `normalize`/`normalizedPayload`
 * fires before capture, so the ring is never half-written; capturing before the
 * push means downstream backpressure never gates it. The marker path captures
 * nothing.
 */
export async function runNormalize(
  input: Channel<PipeMessage>,
  output: Channel<PipeMessage>,
  clock: TaskClock,
  normalize: TaskAlgorithm["normalize"],
  inspector: TaskInspector,
): Promise<void> {
  for (;;) {
    await clock.gate();
    const message = await input.pull();
    if (isEndOfStream(message)) {
      await output.push(message);
      return;
    }
    let result: unknown;
    try {
      // One engine over many wire formats: the normalizer needs to know which
      // endpoint produced this payload, so it can dispatch to the right parser.
      result = normalize(message.payload, message.endpoint);
    } catch (error) {
      throw new RuleError("normalize", messageOf(error));
    }
    const payload = normalizedPayload(result);
    inspector.captureNormalized(message.id, message.ts, message.endpoint, message.payload, payload);
    await output.push({ id: message.id, ts: message.ts, endpoint: message.endpoint, payload });
  }
}

/**
 * The Detect task: an Event -> run the Rule on a flat view and record its Findings,
 * charge the rule's service time, then forward the Event to the Sink. Engine
 * fields win in the view, so a payload field named `id` cannot shadow the real
 * id. A marker -> call `scorer.finalize`, forward the marker, then return.
 *
 * The governor charges only real Events, never the marker. It runs after `record`
 * and before `push`, so a slow rule holds each Event in service for whole ticks;
 * the arrival rate then outruns the service rate and the Queue climbs.
 *
 * `inspector.markProcessed()` runs right after `scorer.record` and before the
 * governor charge, so the watermark tracks scoring completion, not service
 * completion: a stop mid-service still counts the Event processed. The marker
 * path marks nothing.
 */
export async function runDetect(
  input: Channel<PipeMessage>,
  output: Channel<PipeMessage>,
  clock: TaskClock,
  detect: TaskAlgorithm["detect"],
  scorer: TaskScorer,
  inspector: TaskInspector,
  serviceRate: ServiceRate,
): Promise<void> {
  const governor = makeGovernor(serviceRate);
  for (;;) {
    await clock.gate();
    const message = await input.pull();
    if (isEndOfStream(message)) {
      scorer.finalize();
      await output.push(message);
      return;
    }
    const payload = message.payload;
    const base = payload instanceof Object ? payload : {};
    // The flat view the Rule sees and the entity resolver reads. Built through the
    // shared `withEngineFields` (so the profiler reproduces it), then spread into a
    // DetectView literal so `resolveEntity` can index it by `subjectType`.
    const view: DetectView = {
      ...withEngineFields(base, message.id, message.ts, message.endpoint),
    };
    // Run detect(), validate its return, then canonicalize each finding to fresh
    // plain data and resolve its entity, all inside one boundary. The scorer runs
    // OUTSIDE this try (below), so an exotic player object (a throwing getter, a
    // Proxy trap, a toJSON) must be made safe here: any throw becomes one clean
    // RuleError the supervisor can report, and the scorer only ever sees plain data.
    // The partial-skip now lives in the scorer, so partials are passed through.
    let scored: ScoredFinding[];
    try {
      // 1. Validate the player's return, for good errors on a bad shape.
      const validated = parseFindings(detect(view));
      // 2. Serialize to plain data. A throwing getter or Proxy trap fires HERE.
      // 3. Re-validate: a non-enumerable toJSON can pass step 1 and then serialize
      //    to malformed-but-non-throwing data, so the canonical result is re-parsed.
      const canonical = parseFindings(JSON.parse(JSON.stringify(validated)));
      scored = canonical.map((finding) => {
        const entity = resolveEntity(finding, view);
        return entity === undefined ? { finding } : { finding, entity };
      });
    } catch (error) {
      throw new RuleError("detect", messageOf(error));
    }
    scorer.record(scored, message);
    inspector.markProcessed();
    const ticks = governor.charge();
    if (ticks > 0) {
      await clock.sleep(ticks);
    }
    await output.push(message);
  }
}

/**
 * The Sink task: the drain. An Event -> complete it (drives Throughput). A marker
 * -> return WITHOUT a completion, so it is not counted and Throughput stays exact.
 * No fake sleep: the Sink drains immediately now that the player owns the work.
 */
export async function runSink(
  input: Channel<PipeMessage>,
  clock: TaskClock,
  onComplete: () => void,
): Promise<void> {
  for (;;) {
    await clock.gate();
    const message = await input.pull();
    if (isEndOfStream(message)) {
      return;
    }
    onComplete();
  }
}

/**
 * A node's channels: the edge it targets is its `input`, the edge it sources is
 * its `output`. Ingest has no input; the Sink has no output.
 */
export interface NodeWiring {
  input: Channel<PipeMessage> | undefined;
  output: Channel<PipeMessage> | undefined;
}

/** The shared runtime a node task needs, apart from its own wiring. */
export interface NodeRuntime {
  clock: TaskClock;
  /** Called each time the Sink finishes an Event. The engine counts completions. */
  onComplete: () => void;
  /** Called each time Ingest admits a real Event. The engine counts admissions. */
  onAdmit: () => void;
  /** The player's loaded Rule. */
  algorithm: TaskAlgorithm;
  /** The Correctness scorer; the Detect task is its single writer. */
  scorer: TaskScorer;
  /** The inspector's write surface; Normalize and Detect are its writers. */
  inspector: TaskInspector;
  /** The Ingest source: the scheduled Events, then null when exhausted. */
  nextEvent: () => PipeEvent | null;
  /**
   * The live scored source (GH117-PLAN.md "Part C"). When present it REPLACES
   * `nextEvent` as the Ingest task's source: the task drives this pump instead of
   * `runIngest`, so the engine's tick listener feeds scored events in as they emit.
   * Omitted, the Ingest task plays the pre-generated `nextEvent` schedule exactly as
   * before — the reference path parity guard 2 compares against.
   */
  pump?: (out: Channel<PipeMessage>, clock: TaskClock, onAdmit: () => void) => Promise<void>;
  /** The quantized per-Event service rate the Detect governor charges. */
  serviceRate: ServiceRate;
}

/**
 * A node task: given a node's id, wiring, and runtime, run its loop until the
 * Clock stops or the stream ends. The engine looks one up by node kind, so it
 * never names a task directly.
 */
export type NodeTask = (nodeId: string, wiring: NodeWiring, runtime: NodeRuntime) => Promise<void>;

/** Resolve a required channel or fail loudly. A missing one is a wiring bug. */
function requireChannel(
  channel: Channel<PipeMessage> | undefined,
  nodeId: string,
  role: string,
): Channel<PipeMessage> {
  if (!channel) {
    throw new Error(`Node "${nodeId}" needs ${role} wiring, but none was built for it.`);
  }
  return channel;
}

const ingestTask: NodeTask = (nodeId, wiring, runtime) => {
  const out = requireChannel(wiring.output, nodeId, "output");
  // The live scored source, when injected, replaces the pull schedule: the engine's
  // tick listener offers events into it and this task pumps them out (GH117 Part C).
  return runtime.pump
    ? runtime.pump(out, runtime.clock, runtime.onAdmit)
    : runIngest(out, runtime.clock, runtime.nextEvent, runtime.onAdmit);
};

const normalizeTask: NodeTask = (nodeId, wiring, runtime) =>
  runNormalize(
    requireChannel(wiring.input, nodeId, "input"),
    requireChannel(wiring.output, nodeId, "output"),
    runtime.clock,
    runtime.algorithm.normalize,
    runtime.inspector,
  );

const detectTask: NodeTask = (nodeId, wiring, runtime) =>
  runDetect(
    requireChannel(wiring.input, nodeId, "input"),
    requireChannel(wiring.output, nodeId, "output"),
    runtime.clock,
    runtime.algorithm.detect,
    runtime.scorer,
    runtime.inspector,
    runtime.serviceRate,
  );

const sinkTask: NodeTask = (nodeId, wiring, runtime) =>
  runSink(requireChannel(wiring.input, nodeId, "input"), runtime.clock, runtime.onComplete);

/**
 * The node-kind registry: kind -> task. The engine spawns one task per graph node
 * by its kind, so a later slice adds a node kind by adding one entry here, with no
 * engine change.
 */
export const NODE_TASKS = new Map<string, NodeTask>([
  ["ingest", ingestTask],
  ["normalize", normalizeTask],
  ["detect", detectTask],
  ["sink", sinkTask],
]);
