import { describe, expect, it } from "bun:test";
import { Channel, ChannelClosedError } from "./channel";

/** Drain the microtask queue without any real timer. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

describe("Channel", () => {
  it("pushes then pulls items in order", async () => {
    const ch = new Channel<number>(4);
    await ch.push(1);
    await ch.push(2);
    await ch.push(3);
    expect(await ch.pull()).toBe(1);
    expect(await ch.pull()).toBe(2);
    expect(await ch.pull()).toBe(3);
  });

  it("reports buffered items through size and counts flow", async () => {
    const ch = new Channel<number>(4);
    expect(ch.size).toBe(0);
    await ch.push(1);
    await ch.push(2);
    expect(ch.size).toBe(2);
    expect(ch.accepted).toBe(2);
    await ch.pull();
    expect(ch.size).toBe(1);
    expect(ch.pulled).toBe(1);
  });

  it("exposes an immutable capacity", () => {
    const ch = new Channel<number>(7);
    expect(ch.cap).toBe(7);
  });

  it("holds a push on a full channel until a pull frees a slot", async () => {
    const ch = new Channel<number>(1);
    await ch.push(1);
    let settled = false;
    const blocked = ch.push(2).then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    // The blocked item has not entered yet.
    expect(ch.accepted).toBe(1);

    expect(await ch.pull()).toBe(1);
    await blocked;
    expect(settled).toBe(true);
    expect(ch.accepted).toBe(2);
    expect(await ch.pull()).toBe(2);
  });

  it("holds a pull on an empty channel until an item arrives", async () => {
    const ch = new Channel<number>(2);
    let got = -1;
    const waiting = ch.pull().then((v) => {
      got = v;
    });
    await flush();
    expect(got).toBe(-1);

    await ch.push(42);
    await waiting;
    expect(got).toBe(42);
  });

  it("settles blocked producers first-in first-out", async () => {
    const ch = new Channel<number>(1);
    await ch.push(0); // fills the single slot
    const order: number[] = [];
    const a = ch.push(1).then(() => order.push(1));
    const b = ch.push(2).then(() => order.push(2));
    const c = ch.push(3).then(() => order.push(3));
    await flush();

    // Each pull frees one slot; the oldest blocked producer settles next.
    expect(await ch.pull()).toBe(0);
    await flush();
    expect(await ch.pull()).toBe(1);
    await flush();
    expect(await ch.pull()).toBe(2);
    await flush();
    expect(await ch.pull()).toBe(3);
    await Promise.all([a, b, c]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("does not let a new push barge ahead of a blocked one", async () => {
    const ch = new Channel<number>(1);
    await ch.push(0);
    const order: number[] = [];
    const first = ch.push(1).then(() => order.push(1)); // blocks behind the full slot
    await flush();
    await ch.pull(); // frees the slot for the blocked producer, not a newcomer
    await first;
    const second = ch.push(2).then(() => order.push(2));
    await flush();
    expect(order).toEqual([1]); // 2 is now blocked behind 1's refill
    await ch.pull();
    await second;
    expect(order).toEqual([1, 2]);
  });

  it("drains buffered items after close, then rejects a pull", async () => {
    const ch = new Channel<number>(4);
    await ch.push(1);
    await ch.push(2);
    ch.close();
    expect(await ch.pull()).toBe(1);
    expect(await ch.pull()).toBe(2);
    await expect(ch.pull()).rejects.toBeInstanceOf(ChannelClosedError);
  });

  it("rejects a push or pull started after close at once", async () => {
    const ch = new Channel<number>(4);
    ch.close();
    await expect(ch.push(1)).rejects.toBeInstanceOf(ChannelClosedError);
    await expect(ch.pull()).rejects.toBeInstanceOf(ChannelClosedError);
  });

  it("rejects pending pushes and pulls when closed", async () => {
    const ch = new Channel<number>(1);
    await ch.push(0);
    const blockedPush = ch.push(1);
    const empty = new Channel<number>(1);
    const blockedPull = empty.pull();
    ch.close();
    empty.close();
    await expect(blockedPush).rejects.toBeInstanceOf(ChannelClosedError);
    await expect(blockedPull).rejects.toBeInstanceOf(ChannelClosedError);
  });

  it("delivers a buffered falsy value instead of reading it as empty", async () => {
    const ch = new Channel<number>(2);
    await ch.push(0); // 0 is falsy but is a real buffered item
    expect(ch.size).toBe(1);
    expect(await ch.pull()).toBe(0);
    expect(ch.size).toBe(0);
  });

  it("delivers a buffered undefined value", async () => {
    const ch = new Channel<undefined>(2);
    await ch.push(undefined); // the emptiness signal must not be the value itself
    expect(ch.size).toBe(1);
    const pulled = await ch.pull();
    expect(pulled).toBeUndefined();
    expect(ch.size).toBe(0);
  });

  it("rejects an invalid capacity at construction", () => {
    expect(() => new Channel<number>(-1)).toThrow(/non-negative integer/);
    expect(() => new Channel<number>(1.5)).toThrow(/non-negative integer/);
    expect(() => new Channel<number>(Number.NaN)).toThrow(/non-negative integer/);
  });
});
