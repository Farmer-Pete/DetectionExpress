/**
 * Channel<T>: a bounded, blocking, FIFO async queue on one edge of the Pipeline.
 * Push into it, read with pull. When it is full a push waits until a pull frees
 * a slot; when it is empty a pull waits until a push arrives. Nothing is dropped
 * during a normal run, so the channel's size is that edge's Queue.
 *
 * It counts pushes that entered (`accepted`) and pulls that took an item
 * (`pulled`) so the sampler can measure flow. Waiters unblock through `close`,
 * so no abort signal is threaded through the tasks.
 */

/** Recognizable rejection once a channel is closed and cannot deliver. */
export class ChannelClosedError extends Error {
  constructor(message = "channel closed") {
    super(message);
    this.name = "ChannelClosedError";
  }
}

interface PullWaiter<T> {
  resolve: (item: T) => void;
  reject: (error: unknown) => void;
}

interface PushWaiter<T> {
  item: T;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class Channel<T> {
  /** Immutable capacity. */
  readonly cap: number;
  /** Cumulative pushes that entered the buffer or went straight to a puller. */
  accepted = 0;
  /** Cumulative pulls that took an item. */
  pulled = 0;

  // Each item sits in its own slot object. Emptiness is a missing slot, never a
  // value, so a buffered `undefined` (for a `Channel<undefined>`) is delivered,
  // not mistaken for an empty buffer.
  private readonly buffer: Array<{ value: T }> = [];
  private readonly pullWaiters: PullWaiter<T>[] = [];
  private readonly pushWaiters: PushWaiter<T>[] = [];
  private closed = false;

  constructor(cap: number) {
    if (!Number.isInteger(cap) || cap < 0) {
      throw new Error(`Channel capacity must be a non-negative integer, got ${cap}.`);
    }
    this.cap = cap;
  }

  /** Items buffered right now. */
  get size(): number {
    return this.buffer.length;
  }

  /** Waits while full; rejects when closed. Resolves once the item enters. */
  push(item: T): Promise<void> {
    if (this.closed) {
      return Promise.reject(new ChannelClosedError());
    }
    // Hand straight to a waiting puller (the buffer is empty in that case).
    const puller = this.pullWaiters.shift();
    if (puller) {
      this.accepted++;
      this.pulled++;
      puller.resolve(item);
      return Promise.resolve();
    }
    if (this.buffer.length < this.cap) {
      this.buffer.push({ value: item });
      this.accepted++;
      return Promise.resolve();
    }
    // Full: the producer holds its item until a pull frees a slot. FIFO.
    return new Promise<void>((resolve, reject) => {
      this.pushWaiters.push({ item, resolve, reject });
    });
  }

  /** Waits while empty; drains buffered items then rejects when closed. */
  pull(): Promise<T> {
    // A slot is truthy whether or not its value is; only a missing slot is empty.
    const slot = this.buffer.shift();
    if (slot) {
      this.pulled++;
      this.admitOneBlockedProducer();
      return Promise.resolve(slot.value);
    }
    // Empty buffer but a producer is blocked only when cap is 0: hand directly.
    const producer = this.pushWaiters.shift();
    if (producer) {
      this.accepted++;
      this.pulled++;
      producer.resolve();
      return Promise.resolve(producer.item);
    }
    if (this.closed) {
      return Promise.reject(new ChannelClosedError());
    }
    return new Promise<T>((resolve, reject) => {
      this.pullWaiters.push({ resolve, reject });
    });
  }

  /** Wakes every waiter. Buffered items stay for a later drain. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const error = new ChannelClosedError();
    for (const producer of this.pushWaiters.splice(0)) {
      producer.reject(error);
    }
    for (const puller of this.pullWaiters.splice(0)) {
      puller.reject(error);
    }
  }

  /** A slot just freed: let the oldest blocked producer's item enter. */
  private admitOneBlockedProducer(): void {
    if (this.buffer.length >= this.cap) {
      return;
    }
    const producer = this.pushWaiters.shift();
    if (!producer) {
      return;
    }
    this.buffer.push({ value: producer.item });
    this.accepted++;
    producer.resolve();
  }
}
