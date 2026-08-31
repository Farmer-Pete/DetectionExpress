import { describe, expect, it } from "vitest";
import {
  type AlgorithmsDevClientDeps,
  createAlgorithmsDevClient,
  type DevClientStore,
  type HotChannelLike,
  LOCAL_MODE_SNAPSHOT_KEY,
  type SessionStorageLike,
} from "./algorithms-dev-client";

/** A fake HMR channel: records outbound sends and replays frames to `algo:changed`. */
class FakeChannel implements HotChannelLike {
  readonly sent: Array<{ event: string; data: unknown }> = [];
  private handlers: Array<(data: unknown) => void> = [];

  on(event: string, handler: (data: unknown) => void): void {
    if (event === "algo:changed") {
      this.handlers.push(handler);
    }
  }

  off(event: string, handler: (data: unknown) => void): void {
    if (event === "algo:changed") {
      this.handlers = this.handlers.filter((h) => h !== handler);
    }
  }

  send(event: string, data?: unknown): void {
    this.sent.push({ event, data });
  }

  /** Whether a bootstrap `algo:hello` was ever sent (the handshake carries no slug). */
  sentHello(): boolean {
    return this.sent.some((frame) => frame.event === "algo:hello");
  }

  /** How many listeners are currently registered (a leak check). */
  listenerCount(): number {
    return this.handlers.length;
  }

  /** Deliver an `algo:changed` frame to every registered listener. */
  emitChanged(payload: unknown): void {
    for (const handler of [...this.handlers]) {
      handler(payload);
    }
  }
}

/**
 * A channel whose `off` never removes a listener. A re-subscribe therefore leaves the old
 * epoch's listener registered, so the generation guard — not the unsubscribe — is the only
 * thing that can drop a stale frame. Used to exercise the guard in isolation.
 */
class KeepAllChannel extends FakeChannel {
  override off(): void {}
}

/** The recorded state a fake store exposes to assertions, alongside its setters. */
interface FakeStoreState {
  source: string;
  local: { path: string; version: number } | null;
  locked: boolean;
}

/** A fake store slice recording the calls the client makes. */
function fakeStore(initialSource: string): DevClientStore & FakeStoreState {
  const state: DevClientStore & FakeStoreState = {
    source: initialSource,
    local: null,
    locked: false,
    getSource() {
      return state.source;
    },
    setSource(source) {
      state.source = source;
    },
    setLocalAlgorithm(value) {
      state.local = value;
    },
    setSourceLocked(locked) {
      state.locked = locked;
    },
  };
  return state;
}

/** A fake `sessionStorage` backed by a Map. */
function fakeSession(): SessionStorageLike & { size(): number } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    size: () => map.size,
  };
}

interface Harness {
  client: ReturnType<typeof createAlgorithmsDevClient>;
  channel: FakeChannel;
  store: ReturnType<typeof fakeStore>;
  session: ReturnType<typeof fakeSession>;
  runs: () => number;
}

function harness(overrides: Partial<AlgorithmsDevClientDeps> = {}): Harness {
  const channel = new FakeChannel();
  const store = fakeStore("// in-game source");
  const session = fakeSession();
  let runs = 0;

  const client = createAlgorithmsDevClient({
    channel,
    store,
    run: () => {
      runs += 1;
    },
    session,
    ...overrides,
  });

  return { client, channel, store, session, runs: () => runs };
}

describe("algorithms dev client", () => {
  it("bootstraps with algo:hello for the one engine on enter", () => {
    const h = harness();
    h.client.enter();
    expect(h.channel.sentHello()).toBe(true);
  });

  it("locks the editor and snapshots the in-game source on enter", () => {
    const h = harness();
    h.client.enter();
    expect(h.store.locked).toBe(true);
    expect(h.session.getItem(LOCAL_MODE_SNAPSHOT_KEY)).toBe(
      JSON.stringify({ source: "// in-game source" }),
    );
  });

  it("applies an algo:changed frame and runs", () => {
    const h = harness();
    h.client.enter();
    h.channel.emitChanged({ path: "/src/algorithms/engine.ts", version: 3 });
    expect(h.store.local).toEqual({ path: "/src/algorithms/engine.ts", version: 3 });
    expect(h.runs()).toBe(1);
  });

  it("switches to the override when a create ping arrives for engine.ts", () => {
    const h = harness();
    h.client.enter();
    // First the default-engine fallback, then a create of the override switches to it.
    h.channel.emitChanged({ path: "/src/sim/default-engine.ts", version: 1 });
    h.channel.emitChanged({ path: "/src/algorithms/engine.ts", version: 2 });
    expect(h.store.local).toEqual({ path: "/src/algorithms/engine.ts", version: 2 });
    expect(h.runs()).toBe(2);
  });

  it("ignores a malformed frame instead of throwing", () => {
    const h = harness();
    h.client.enter();
    expect(() => h.channel.emitChanged({ path: 5, version: "x" })).not.toThrow();
    expect(() => h.channel.emitChanged("not an object")).not.toThrow();
    expect(h.store.local).toBeNull();
    expect(h.runs()).toBe(0);
    // A good frame still applies after a bad one, so the channel is not wedged.
    h.channel.emitChanged({ path: "/src/algorithms/engine.ts", version: 1 });
    expect(h.runs()).toBe(1);
  });

  it("drops a stale frame delivered after stop", () => {
    const h = harness();
    h.client.enter();
    const stray = h.channel; // same channel, but the listener is torn down on stop
    h.client.stop();
    stray.emitChanged({ path: "/src/algorithms/engine.ts", version: 4 });
    expect(h.store.local).toBeNull();
    expect(h.runs()).toBe(0);
  });

  it("drops a stale frame from a superseded generation after a re-subscribe", () => {
    // A channel whose `off` never removes a listener keeps the epoch-1 listener registered
    // after the re-subscribe, so the generation guard (not the unsubscribe) is what drops
    // the stale frame.
    const channel = new KeepAllChannel();
    const h = harness({ channel });
    h.client.enter(); // epoch 1
    h.client.stop();
    h.client.enter(); // epoch 2, a fresh subscribe over the same channel
    // The frame reaches BOTH the epoch-1 and epoch-2 listeners; only epoch 2 acts.
    channel.emitChanged({ path: "/src/algorithms/engine.ts", version: 7 });
    expect(h.runs()).toBe(1);
    expect(h.store.local).toEqual({ path: "/src/algorithms/engine.ts", version: 7 });
  });

  it("restores the snapshot and unlocks on stop", () => {
    const h = harness();
    h.client.enter();
    // A local frame drives the run and stashes the override.
    h.channel.emitChanged({ path: "/src/algorithms/engine.ts", version: 1 });
    // Simulate the editor being driven elsewhere while locked.
    h.store.setSource("// something else");
    h.client.stop();
    expect(h.store.source).toBe("// in-game source"); // the snapshot is restored
    expect(h.store.local).toBeNull();
    expect(h.store.locked).toBe(false);
    expect(h.session.size()).toBe(0); // the snapshot is cleared
  });

  it("re-enters from the persisted snapshot after a forced reload", () => {
    // First session: enter and persist. Then a "reload" builds a fresh client over the
    // SAME sessionStorage (a real reload keeps sessionStorage but resets memory).
    const session = fakeSession();
    const store1 = fakeStore("// player's customized text");
    const client1 = createAlgorithmsDevClient({
      channel: new FakeChannel(),
      store: store1,
      run: () => {},
      session,
    });
    client1.enter();
    client1.dispose(); // the reload tears the old client down WITHOUT restoring

    // The snapshot survives the reload.
    expect(session.getItem(LOCAL_MODE_SNAPSHOT_KEY)).not.toBeNull();

    // Second session: a fresh page whose store holds only the default text.
    const channel2 = new FakeChannel();
    const store2 = fakeStore("// the default text after reload");
    const client2 = createAlgorithmsDevClient({
      channel: channel2,
      store: store2,
      run: () => {},
      session,
    });

    expect(client2.resume()).toBe(true);
    expect(store2.locked).toBe(true);
    expect(channel2.sentHello()).toBe(true); // re-subscribed after the reload

    // The plugin re-resolves to the default engine (the override was deleted).
    channel2.emitChanged({ path: "/src/sim/default-engine.ts", version: 5 });
    expect(store2.local).toEqual({ path: "/src/sim/default-engine.ts", version: 5 });

    // Stop restores the ORIGINAL customized text, not the post-reload default.
    client2.stop();
    expect(store2.source).toBe("// player's customized text");
    expect(session.size()).toBe(0);
  });

  it("resume is a no-op with no persisted snapshot", () => {
    const h = harness();
    expect(h.client.resume()).toBe(false);
    expect(h.store.locked).toBe(false);
    expect(h.channel.sentHello()).toBe(false);
  });

  it("does not leak a listener across a stop and re-enter", () => {
    const h = harness();
    h.client.enter();
    h.client.stop();
    h.client.enter();
    expect(h.channel.listenerCount()).toBe(1);
  });
});
