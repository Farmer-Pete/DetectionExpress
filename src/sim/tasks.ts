/**
 * Node task logic. Each node is an independent async loop. Each turn it passes
 * the Clock gate, moves one message over its channel, and waits on the Clock. So
 * a pause holds every task at its next turn, and a stop unwinds it through a
 * rejected wait. No abort code lives here.
 *
 * The pipeline is the locked chain Ingest -> Normalize -> Match -> Sink. Ingest
 * plays a seeded schedule and closes it with a single end-of-stream marker. The
 * marker rides the same FIFO all the way through, so every task ends cleanly and
 * in order (Match after `finalize`, Sink after consuming it).
 *
 * The tasks depend only on a minimal clock contract, so `sim/` never imports the
 * concrete Clock from `game/`.
 */
import { GAME_SECONDS_PER_TICK } from "../game/tuning";
import type { Channel } from "./channel";
import { END_OF_STREAM, isEndOfStream, type PipeEvent, type PipeMessage } from "./event";
import type { Alert } from "./finding";
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
 * Both return an untyped value: the player owns the code, so the Match task parses
 * their return at this boundary before handing it to the scorer.
 */
export interface TaskAlgorithm {
  normalize: (raw: unknown) => unknown;
  match: (e: unknown) => unknown;
}

/** The scorer surface the Match task drives. The full scorer also reads. */
export interface TaskScorer {
  record: (alerts: Alert | Alert[] | null | undefined, env: PipeEvent) => void;
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

/** The engine-owned fields the Match view carries alongside the normalized payload. */
export interface EngineFields {
  id: number;
  ts: number;
  endpoint: string;
}

/**
 * Build the flat Match view: the normalized payload spread first, then the engine
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
 */
export async function runNormalize(
  input: Channel<PipeMessage>,
  output: Channel<PipeMessage>,
  clock: TaskClock,
  normalize: TaskAlgorithm["normalize"],
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
      result = normalize(message.payload);
    } catch (error) {
      throw new RuleError("normalize", messageOf(error));
    }
    const payload = normalizedPayload(result);
    await output.push({ id: message.id, ts: message.ts, endpoint: message.endpoint, payload });
  }
}

/**
 * The Match task: an Event -> run the Rule on a flat view and record its Alerts,
 * charge the rule's service time, then forward the Event to the Sink. Engine
 * fields win in the view, so a payload field named `id` cannot shadow the real
 * id. A marker -> call `scorer.finalize`, forward the marker, then return.
 *
 * The governor charges only real Events, never the marker. It runs after `record`
 * and before `push`, so a slow rule holds each Event in service for whole ticks;
 * the arrival rate then outruns the service rate and the Backlog climbs.
 */
export async function runMatch(
  input: Channel<PipeMessage>,
  output: Channel<PipeMessage>,
  clock: TaskClock,
  match: TaskAlgorithm["match"],
  scorer: TaskScorer,
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
    const view = withEngineFields(base, message.id, message.ts, message.endpoint);
    let result: unknown;
    try {
      result = match(view);
    } catch (error) {
      throw new RuleError("detect", messageOf(error));
    }
    // Parse the return at the boundary, then fold the resolved (non-partial)
    // findings down to their Alerts. T1 never scores a partial; T2 moves this
    // skip into the scorer when it folds Finding[] directly.
    const alerts = parseFindings(result)
      .filter((finding) => !finding.isPartial)
      .map((finding) => finding.alert);
    scorer.record(alerts, message);
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
  /** The Correctness scorer; the Match task is its single writer. */
  scorer: TaskScorer;
  /** The Ingest source: the scheduled Events, then null when exhausted. */
  nextEvent: () => PipeEvent | null;
  /** The quantized per-Event service rate the Match governor charges. */
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

const ingestTask: NodeTask = (nodeId, wiring, runtime) =>
  runIngest(
    requireChannel(wiring.output, nodeId, "output"),
    runtime.clock,
    runtime.nextEvent,
    runtime.onAdmit,
  );

const normalizeTask: NodeTask = (nodeId, wiring, runtime) =>
  runNormalize(
    requireChannel(wiring.input, nodeId, "input"),
    requireChannel(wiring.output, nodeId, "output"),
    runtime.clock,
    runtime.algorithm.normalize,
  );

const matchTask: NodeTask = (nodeId, wiring, runtime) =>
  runMatch(
    requireChannel(wiring.input, nodeId, "input"),
    requireChannel(wiring.output, nodeId, "output"),
    runtime.clock,
    runtime.algorithm.match,
    runtime.scorer,
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
  ["match", matchTask],
  ["sink", sinkTask],
]);
