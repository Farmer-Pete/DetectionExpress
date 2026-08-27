/**
 * The pipe envelope and the end-of-stream marker that ride the Pipeline's
 * channels. An Event is one atomic record entering the Engine (see `CONTEXT.md`);
 * on the wire it travels inside a `PipeEvent` envelope.
 */

/**
 * PipeEvent: the envelope the wire carries. The engine fields (`id`, `ts`,
 * `endpoint`) are readonly and stable; Normalize replaces only `payload` and
 * forwards a fresh envelope. `payload` is `RawAuthV1` at Ingest and the player's
 * own shape after Normalize, so it stays `unknown` at this boundary.
 *
 * There is no `truth` field here. Ground truth lives only in the scorer, so the
 * Rule cannot read it: it is not on the wire.
 */
export interface PipeEvent {
  /** Stable, engine-assigned. */
  readonly id: number;
  /** Event time in the Clock's game-time domain (the scheduled time). */
  readonly ts: number;
  /** Which format produced it. */
  readonly endpoint: string;
  payload: unknown;
}

/**
 * The end-of-stream marker. It rides the same FIFO as Events so finalize happens
 * after the last real Event, in order, with no timer.
 */
export interface EndOfStream {
  readonly kind: "end";
}

/** The single marker instance. One is pushed once, at the end of the schedule. */
export const END_OF_STREAM: EndOfStream = { kind: "end" };

/** Channels carry a message, not only an Event: a PipeEvent or the marker. */
export type PipeMessage = PipeEvent | EndOfStream;

/** Narrow a message to the marker. Only the marker carries a `kind`. */
export function isEndOfStream(message: PipeMessage): message is EndOfStream {
  return "kind" in message && message.kind === "end";
}
