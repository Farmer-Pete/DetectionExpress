import { describe, expect, it } from "bun:test";
import type { GraphEdge, GraphNode } from "../sim/graph";
import type { SimSnapshot } from "../sim/snapshot";
import { type Clock, ManualDriver, type TickDriver } from "./clock";
import { type StartOptions, start } from "./engine";

const NODES: GraphNode[] = [
  { id: "ingest", kind: "ingest" },
  { id: "sink", kind: "sink" },
];
const EDGES: GraphEdge[] = [{ id: "wire", source: "ingest", target: "sink" }];

// Read snapshot maps by variable keys: the maps are index signatures, so TS
// wants bracket access while Biome would rewrite a literal key to dot notation.
const WIRE_ID = "wire";
const SINK_ID = "sink";
const INGEST_ID = "ingest";

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

async function step(driver: ManualDriver, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    driver.advance(1);
    await flush();
  }
}

interface Harness {
  handle: ReturnType<typeof start>;
  driver: ManualDriver;
  snapshots: SimSnapshot[];
  last: () => SimSnapshot | undefined;
}

function launch(overrides: Partial<StartOptions> & { rates?: Record<string, number> }): Harness {
  const driver = new ManualDriver();
  const snapshots: SimSnapshot[] = [];
  const rates = overrides.rates ?? { ingest: 6, sink: 30 };
  const options: StartOptions = {
    getGraph: () => ({ nodes: NODES, edges: EDGES }),
    getRate: overrides.getRate ?? ((id) => rates[id] ?? 1),
    setSnapshot: overrides.setSnapshot ?? ((snapshot) => snapshots.push(snapshot)),
    driver,
    bindVisibility: overrides.bindVisibility ?? (() => () => undefined),
    ...(overrides.onError ? { onError: overrides.onError } : {}),
  };
  const handle = start(options);
  return { handle, driver, snapshots, last: () => snapshots.at(-1) };
}

/** A driver that records whether the Clock ever started it. */
class SpyDriver implements TickDriver {
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

describe("engine start guards", () => {
  it("throws on an invalid graph and allocates nothing", () => {
    const driver = new SpyDriver();
    expect(() =>
      start({
        getGraph: () => ({ nodes: [{ id: "x", kind: "detect" }], edges: [] }),
        getRate: () => 1,
        setSnapshot: () => undefined,
        driver,
        bindVisibility: () => () => undefined,
      }),
    ).toThrow(/unknown/i);
    expect(driver.started).toBe(false); // the Clock was never constructed
  });
});

describe("engine sampler", () => {
  it("publishes rates that track the fed flow when the Sink keeps up", async () => {
    const h = launch({ rates: { ingest: 6, sink: 30 } });
    await step(h.driver, 150);
    const snap = h.last();
    expect(snap).toBeDefined();
    if (!snap) return;
    const edge = snap.edges[WIRE_ID];
    expect(edge).toBeDefined();
    if (!edge) return;
    expect(edge.inRate).toBeGreaterThan(3);
    expect(edge.inRate).toBeLessThan(9);
    expect(edge.outRate).toBeGreaterThan(3);
    expect(snap.throughput).toBeGreaterThan(0);
    // The Sink keeps up, so its input stays near empty and it stays cool.
    expect(snap.nodes[SINK_ID]?.heat).toBe(0);
    expect(snap.nodes[INGEST_ID]?.heat).toBe(0);
    h.handle.stop();
  });

  it("reddens the Sink and keeps the Ingest calm when the Sink is the bottleneck", async () => {
    const h = launch({ rates: { ingest: 8, sink: 0.5 } }); // sink far slower
    await step(h.driver, 700); // fill the Backlog past the occupancy threshold
    const snap = h.last();
    expect(snap).toBeDefined();
    if (!snap) return;
    expect(snap.backlog).toBeGreaterThan(0);
    expect(snap.nodes[SINK_ID]?.heat).toBeGreaterThan(0); // the bottleneck reddens
    expect(snap.nodes[INGEST_ID]?.heat).toBe(0); // the source stays calm
    h.handle.stop();
  });
});

describe("engine stop", () => {
  it("is idempotent and settles whenStopped", async () => {
    const h = launch({});
    await step(h.driver, 10);
    h.handle.stop();
    h.handle.stop(); // no-op, no throw
    await h.handle.whenStopped;
    expect(true).toBe(true);
  });

  it("writes no snapshot after stop", async () => {
    const h = launch({});
    await step(h.driver, 30);
    const count = h.snapshots.length;
    expect(count).toBeGreaterThan(0);
    h.handle.stop();
    await step(h.driver, 30);
    expect(h.snapshots.length).toBe(count);
  });

  it("exits a paused task on stop", async () => {
    const holder: { clock: Clock | null } = { clock: null };
    const h = launch({
      bindVisibility: (clock) => {
        holder.clock = clock;
        return () => undefined;
      },
    });
    await step(h.driver, 5);
    holder.clock?.pause();
    await step(h.driver, 10); // held
    h.handle.stop();
    await h.handle.whenStopped; // resolves even though tasks were paused
    expect(true).toBe(true);
  });
});

describe("engine supervisor", () => {
  it("stops once and surfaces an unexpected task error", async () => {
    const errors: unknown[] = [];
    const h = launch({
      rates: { ingest: 6, sink: 30 },
      getRate: (id) => {
        if (id === "sink") {
          throw new Error("boom in sink");
        }
        return 6;
      },
      onError: (error) => errors.push(error),
    });
    await step(h.driver, 20);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    await h.handle.whenStopped;
  });

  it("stops once and surfaces an unexpected sampler error", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const h = launch({
      setSnapshot: () => {
        calls++;
        throw new Error("boom in sampler");
      },
      onError: (error) => errors.push(error),
    });
    await step(h.driver, 20);
    expect(errors).toHaveLength(1);
    expect(calls).toBe(1); // failed on the first publish, then stopped
    await h.handle.whenStopped;
  });

  it("does not surface the closed errors from a clean teardown", async () => {
    const errors: unknown[] = [];
    const h = launch({ onError: (error) => errors.push(error) });
    await step(h.driver, 20);
    h.handle.stop();
    await h.handle.whenStopped;
    expect(errors).toHaveLength(0);
  });

  it("tears down even when the onError handler throws", async () => {
    const holder: { clock: Clock | null } = { clock: null };
    const h = launch({
      bindVisibility: (clock) => {
        holder.clock = clock;
        return () => undefined;
      },
      setSnapshot: () => {
        throw new Error("boom in sampler");
      },
      onError: () => {
        throw new Error("the handler also throws");
      },
    });
    await step(h.driver, 5); // the first sample throws; fail() runs
    const tickAtFail = holder.clock?.now() ?? -1;
    await step(h.driver, 20); // the driver is stopped, so no more ticks
    expect(holder.clock?.now()).toBe(tickAtFail); // torn down, not looping forever
    await h.handle.whenStopped; // settles, no hang
  });
});

describe("engine pause", () => {
  it("stops sampling while paused, so heat and counts hold", async () => {
    const holder: { clock: Clock | null } = { clock: null };
    const h = launch({
      rates: { ingest: 8, sink: 0.5 },
      bindVisibility: (clock) => {
        holder.clock = clock;
        return () => undefined;
      },
    });
    await step(h.driver, 700); // fill the Backlog past the threshold so the Sink heats up
    expect(h.last()?.nodes[SINK_ID]?.heat).toBeGreaterThan(0);
    const count = h.snapshots.length;

    holder.clock?.pause();
    await step(h.driver, 300); // paused: the sampler does not run
    expect(h.snapshots.length).toBe(count); // no new snapshot, so heat holds
    h.handle.stop();
  });
});
