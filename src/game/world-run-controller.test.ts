import { describe, expect, it } from "vitest";
import { distanceTable } from "../sim/world/distance";
import { world } from "../sim/world/world";
import type { WorldEnv } from "../sim/world-reading";
import { emptyWorldSnapshot, type WorldSnapshot } from "../sim/world-snapshot";
import type { WorldEngineHandle } from "./world-engine";
import { createWorldRunController, type WorldRunControllerDeps } from "./world-run-controller";

const env: WorldEnv = { world, distances: distanceTable(world) };

/** A fake engine handle whose `whenStopped` a test resolves by hand. */
function fakeHandle(): { handle: WorldEngineHandle; stops: number; settle: () => void } {
  let stops = 0;
  let resolveStopped: () => void = () => undefined;
  const whenStopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  return {
    get stops() {
      return stops;
    },
    handle: {
      stop: () => {
        stops += 1;
        resolveStopped();
      },
      whenStopped,
    },
    settle: () => resolveStopped(),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function baseDeps(over: Partial<WorldRunControllerDeps>): WorldRunControllerDeps {
  return {
    getFixtures: () => [],
    env,
    getSeed: () => 1,
    setWorldSnapshot: () => undefined,
    start: () => fakeHandle().handle,
    ...over,
  };
}

describe("world run controller", () => {
  it("clears the snapshot and starts an engine on run", () => {
    const published: WorldSnapshot[] = [];
    let started = 0;
    const controller = createWorldRunController(
      baseDeps({
        setWorldSnapshot: (snapshot) => published.push(snapshot),
        start: () => {
          started += 1;
          return fakeHandle().handle;
        },
      }),
    );
    controller.run();
    expect(started).toBe(1);
    expect(published).toEqual([emptyWorldSnapshot()]);
  });

  it("passes the current fixtures and seed to the engine", () => {
    let seenSeed: number | null = null;
    const controller = createWorldRunController(
      baseDeps({
        getSeed: () => 4242,
        start: (options) => {
          seenSeed = options.runSeed;
          return fakeHandle().handle;
        },
      }),
    );
    controller.run();
    expect(seenSeed).toBe(4242);
  });

  it("stops a prior engine before starting a fresh one", () => {
    const handles = [fakeHandle(), fakeHandle()];
    let call = 0;
    const controller = createWorldRunController(
      baseDeps({ start: () => handles[call++]?.handle ?? fakeHandle().handle }),
    );
    controller.run();
    controller.run();
    expect(handles[0]?.stops).toBe(1); // the first engine was stopped
    expect(call).toBe(2); // a fresh engine was started
  });

  it("disposes permanently: it stops the engine and a later run does nothing", () => {
    const fake = fakeHandle();
    let started = 0;
    const controller = createWorldRunController(
      baseDeps({
        start: () => {
          started += 1;
          return fake.handle;
        },
      }),
    );
    controller.run();
    controller.dispose();
    expect(fake.stops).toBe(1);
    controller.run(); // ignored after dispose
    expect(started).toBe(1);
  });

  it("calls onFinished when the engine settles on its own", async () => {
    const fake = fakeHandle();
    let finished = 0;
    const controller = createWorldRunController(
      baseDeps({
        start: () => fake.handle,
        onFinished: () => {
          finished += 1;
        },
      }),
    );
    controller.run();
    fake.settle();
    await flush();
    expect(finished).toBe(1);
  });

  it("does not call onFinished after dispose", async () => {
    const fake = fakeHandle();
    let finished = 0;
    const controller = createWorldRunController(
      baseDeps({
        start: () => fake.handle,
        onFinished: () => {
          finished += 1;
        },
      }),
    );
    controller.run();
    controller.dispose();
    await flush();
    expect(finished).toBe(0);
  });
});
