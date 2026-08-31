/**
 * `useLocalIde` owns the dev-only local-IDE (algorithms hot-reload) client App used
 * to inline: the `import.meta.env.DEV` + live-HMR-channel gate, the `algoReady`/
 * `localMode` state, and the enter/stop handlers. `getChannel`/`loadClient` are the
 * hook's own test-injection seam (mirroring `usePipelineController`'s
 * `createController`), so these tests exercise the channel-present path through real
 * dependency injection, never module mocking. The default test environment has no
 * `import.meta.hot`, so the real, uninjected `devHotChannel()` already returns null
 * (matching `App.test.tsx`'s "does not mount the local-IDE control" case).
 */
import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AlgorithmsDevClient,
  AlgorithmsDevClientDeps,
  AlgorithmsDevClientModule,
  HotChannelLike,
} from "../../game/algorithms-dev-client";
import type { RunController } from "../../game/run-controller";
import { useGameStore } from "../../game/store";
import { useLocalIde } from "./use-local-ide";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A no-op controller, the same shape as the real one, so a run() call is observable. */
function stubController(run: () => void = () => {}): RunController {
  return { run, setFrozen: () => {}, setSpeed: () => {}, dispose: () => {} };
}

/** A fake HMR channel, the same shape the real `devHotChannel()` returns. */
function fakeChannel(): HotChannelLike {
  return { on: vi.fn(), off: vi.fn(), send: vi.fn() };
}

/** A fake dev client, the same shape `createAlgorithmsDevClient` returns. */
function fakeClient(resume: () => boolean = () => false): AlgorithmsDevClient {
  return { enter: vi.fn(), resume: vi.fn(resume), stop: vi.fn(), dispose: vi.fn() };
}

describe("useLocalIde", () => {
  it("stays inert by default: the real devHotChannel() finds no import.meta.hot in the test environment", () => {
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() => useLocalIde({ slug: "kiosk-pin-attack", controllerRef }));
    expect(result.current.algoReady).toBe(false);
  });

  it("builds no client when getChannel returns null", () => {
    const loadClient = vi.fn();
    const getChannel = () => null;
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() =>
      useLocalIde({ slug: "kiosk-pin-attack", controllerRef, getChannel, loadClient }),
    );
    expect(result.current.algoReady).toBe(false);
    expect(loadClient).not.toHaveBeenCalled();
  });

  it("builds the client with the expected slug/channel args and enters local mode when resume() returns true", async () => {
    const channel = fakeChannel();
    const client = fakeClient(() => true);
    const createAlgorithmsDevClient = vi.fn((_deps: AlgorithmsDevClientDeps) => client);
    const module: AlgorithmsDevClientModule = { createAlgorithmsDevClient };
    // Stable references, declared once outside the renderHook callback: an inline
    // arrow function recreated on every render would give the effect's [getChannel,
    // loadClient] dependencies a fresh identity after the first state update, and
    // re-run the whole build a second time.
    const getChannel = () => channel;
    const loadClient = () => Promise.resolve(module);

    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() =>
      useLocalIde({ slug: "kiosk-pin-attack", controllerRef, getChannel, loadClient }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(createAlgorithmsDevClient).toHaveBeenCalledTimes(1);
    const deps = createAlgorithmsDevClient.mock.calls[0]?.[0];
    expect(deps?.slug).toBe("kiosk-pin-attack");
    expect(deps?.channel).toBe(channel);
    // The session is the real browser sessionStorage, and the store adapter delegates
    // to the real game store rather than some detached object: getSource reads the live
    // source, and each setter forwards to the matching store action. The setters are
    // mocked to no-ops so this assertion does not mutate the shared singleton store; the
    // one real read restores the source it seeded.
    expect(deps?.session).toBe(window.sessionStorage);
    const originalSource = useGameStore.getState().source;
    const setSourceSpy = vi
      .spyOn(useGameStore.getState(), "setAlgorithmSource")
      .mockImplementation(() => {});
    const setLockedSpy = vi
      .spyOn(useGameStore.getState(), "setSourceLocked")
      .mockImplementation(() => {});
    const setLocalSpy = vi
      .spyOn(useGameStore.getState(), "setLocalAlgorithm")
      .mockImplementation(() => {});
    useGameStore.setState({ source: "SEED-SOURCE" });
    expect(deps?.store.getSource()).toBe("SEED-SOURCE");
    deps?.store.setSource("NEXT-SOURCE");
    expect(setSourceSpy).toHaveBeenCalledWith("NEXT-SOURCE");
    deps?.store.setSourceLocked(true);
    expect(setLockedSpy).toHaveBeenCalledWith(true);
    deps?.store.setLocalAlgorithm({ path: "algo.ts", version: 3 });
    expect(setLocalSpy).toHaveBeenCalledWith({ path: "algo.ts", version: 3 });
    useGameStore.setState({ source: originalSource }); // undo the one real mutation

    expect(result.current.algoReady).toBe(true);
    expect(result.current.localMode).toBe(true); // resume() returned true: a forced-reload re-entry
  });

  it("swallows a loader rejection and stays inert", async () => {
    const getChannel = () => fakeChannel();
    const loadClient = () => Promise.reject(new Error("boom"));
    const controllerRef = createRef<RunController | null>();
    const { result } = renderHook(() =>
      useLocalIde({ slug: "s", controllerRef, getChannel, loadClient }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.algoReady).toBe(false);
  });

  it("disposes the client on unmount", async () => {
    const client = fakeClient();
    const getChannel = () => fakeChannel();
    const loadClient = () => Promise.resolve({ createAlgorithmsDevClient: () => client });
    const controllerRef = createRef<RunController | null>();
    const { unmount } = renderHook(() =>
      useLocalIde({ slug: "s", controllerRef, getChannel, loadClient }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });

  it("onEnterLocalMode/onStopLocalMode toggle localMode; onStop calls controllerRef.current?.run() even with no client", () => {
    const run = vi.fn();
    const getChannel = () => null;
    const controllerRef = createRef<RunController | null>();
    controllerRef.current = stubController(run);
    const { result } = renderHook(() => useLocalIde({ slug: "s", controllerRef, getChannel }));

    act(() => result.current.onEnterLocalMode());
    expect(result.current.localMode).toBe(true);

    act(() => result.current.onStopLocalMode());
    expect(result.current.localMode).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("the client's run() call reaches whatever controller is current at call time, not a stale closure", async () => {
    // A property, not a bare `let`: TS's control-flow narrowing does not track a
    // reassignment made inside a nested closure, so a bare `let` would stay narrowed
    // to its initial `null` at the read site below even after the closure runs.
    const captured: { run: (() => void) | null } = { run: null };
    const client = fakeClient();
    const createAlgorithmsDevClient = vi.fn((deps: AlgorithmsDevClientDeps) => {
      captured.run = deps.run;
      return client;
    });
    const getChannel = () => fakeChannel();
    const loadClient = () => Promise.resolve({ createAlgorithmsDevClient });

    const controllerRef = createRef<RunController | null>();
    const firstRun = vi.fn();
    controllerRef.current = stubController(firstRun);
    renderHook(() => useLocalIde({ slug: "s", controllerRef, getChannel, loadClient }));
    await act(async () => {
      await Promise.resolve();
    });

    const secondRun = vi.fn();
    controllerRef.current = stubController(secondRun);

    if (captured.run === null) {
      throw new Error("expected the client's run() dependency to have been captured");
    }
    captured.run();
    expect(secondRun).toHaveBeenCalledTimes(1);
    expect(firstRun).not.toHaveBeenCalled();
  });
});
