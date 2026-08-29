import { beforeEach, describe, expect, it } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { DevHostClient, DevHostClientDeps, DevState } from "../game/dev-host-client";
import type { RunController } from "../game/run-controller";
import { useGameStore } from "../game/store";
import { referenceSource } from "../sim/scenarios/kiosk-pin-attack/reference";
import { kioskPinAttack } from "../sim/scenarios/kiosk-pin-attack/scenario";
import { App } from "./App";
import { scenarioSlug } from "./scenarios";

// The zustand store is a singleton shared across test files, so reset the fields
// this file reads before each test, or a leaked `sourceLocked` would hide the Run
// button. Mirrors the reset pattern in store.test.ts.
beforeEach(() => {
  useGameStore.setState({ source: referenceSource, sourceLocked: false });
});

/** A no-op controller so the test never touches the real loader or engine. */
function stubController(): RunController & { runs: number; disposes: number } {
  let runs = 0;
  let disposes = 0;
  return {
    get runs() {
      return runs;
    },
    get disposes() {
      return disposes;
    },
    run() {
      runs += 1;
    },
    dispose() {
      disposes += 1;
    },
  };
}

describe("App", () => {
  it("renders the heading, both gauges, and the Algorithm editor", () => {
    render(<App controller={stubController()} />);
    // getByRole/getByText throw if missing, so finding them is the assertion.
    const heading = screen.getByRole("heading", { name: "Detection Express" });
    expect(heading.textContent).toBe("Detection Express");
    expect(screen.getByText("Throughput")).toBeDefined();
    expect(screen.getByText("Backlog")).toBeDefined();
    expect(screen.getByRole("button", { name: "Run" })).toBeDefined();
  });

  it("runs the controller on mount", () => {
    const controller = stubController();
    render(<App controller={controller} />);
    expect(controller.runs).toBe(1);
  });
});

/** A fake dev-host client whose deps the App wires. Records the calls it receives. */
function fakeDevKit() {
  let deps: DevHostClientDeps | null = null;
  let connects = 0;
  let disconnects = 0;
  const editCalls: Array<{ name: string; defaultSource: string }> = [];

  const factory = (received: DevHostClientDeps): DevHostClient => {
    deps = received;
    return {
      connect() {
        connects += 1;
      },
      disconnect() {
        disconnects += 1;
      },
      async editInIde(name, defaultSource) {
        editCalls.push({ name, defaultSource });
        return { path: "/algorithms/detection-express-kiosk-pin-attack.js", existed: true };
      },
    };
  };

  return {
    factory,
    deps: () => {
      if (deps === null) {
        throw new Error("the App never built the dev client");
      }
      return deps;
    },
    connects: () => connects,
    disconnects: () => disconnects,
    editCalls,
  };
}

describe("App dev wiring", () => {
  beforeEach(() => {
    useGameStore.setState({ source: referenceSource, sourceLocked: false });
  });

  it("connects the dev client on mount and disconnects it on unmount", () => {
    const dev = fakeDevKit();
    const { unmount } = render(<App controller={stubController()} createDevClient={dev.factory} />);
    expect(dev.connects()).toBe(1);
    unmount();
    expect(dev.disconnects()).toBe(1);
  });

  it("locks the store when the client reports an active path and unlocks when it clears", () => {
    const dev = fakeDevKit();
    render(<App controller={stubController()} createDevClient={dev.factory} />);
    const onState = (state: DevState) => act(() => dev.deps().onState(state));

    onState({ status: "connected", path: "/algorithms/x.js", message: null });
    expect(useGameStore.getState().sourceLocked).toBe(true);

    onState({ status: "connected", path: null, message: null });
    expect(useGameStore.getState().sourceLocked).toBe(false);
  });

  it("applies a pushed source into the store and reruns the controller", () => {
    const dev = fakeDevKit();
    const controller = stubController();
    render(<App controller={controller} createDevClient={dev.factory} />);
    const runsBefore = controller.runs;

    act(() => dev.deps().applySource("// pushed from my IDE"));

    expect(useGameStore.getState().source).toBe("// pushed from my IDE");
    expect(controller.runs).toBe(runsBefore + 1);
  });

  it("opens the Scenario file in the IDE with the Scenario slug and reference source", async () => {
    const dev = fakeDevKit();
    render(<App controller={stubController()} createDevClient={dev.factory} />);

    // The panel is loaded through the folded DEV_KIT gate, so it mounts asynchronously.
    const button = await screen.findByRole("button", { name: "Edit in my IDE" });
    fireEvent.click(button);

    expect(dev.editCalls).toEqual([
      { name: scenarioSlug(kioskPinAttack.id), defaultSource: referenceSource },
    ]);
  });

  it("recovers a failed initial client build on a later Edit in my IDE click", async () => {
    let attempts = 0;
    let connects = 0;
    const editCalls: Array<{ name: string; defaultSource: string }> = [];
    const factory = (_deps: DevHostClientDeps): DevHostClient => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("the dev host client failed to build");
      }
      return {
        connect() {
          connects += 1;
        },
        disconnect() {},
        async editInIde(name, defaultSource) {
          editCalls.push({ name, defaultSource });
          return { path: "/algorithms/detection-express-kiosk-pin-attack.js", existed: true };
        },
      };
    };

    render(<App controller={stubController()} createDevClient={factory} />);

    // The first build threw, so no client connected yet, but the panel still mounts.
    const button = await screen.findByRole("button", { name: "Edit in my IDE" });
    expect(connects).toBe(0);

    fireEvent.click(button);

    // The click re-ran the build, connected the fresh client, and opened the file.
    expect(connects).toBe(1);
    expect(editCalls).toEqual([
      { name: scenarioSlug(kioskPinAttack.id), defaultSource: referenceSource },
    ]);
  });

  it("recovers a failed ASYNC client load with a single later Edit in my IDE click", async () => {
    // Drive the async load path (a dynamic import in production) through the injected
    // loader: it rejects once, then resolves the factory. F4: after the failed load the
    // first click must both reconnect AND open, not silently reconnect and need a second.
    let attempts = 0;
    let connects = 0;
    const editCalls: Array<{ name: string; defaultSource: string }> = [];
    const client: DevHostClient = {
      connect() {
        connects += 1;
      },
      disconnect() {},
      async editInIde(name, defaultSource) {
        editCalls.push({ name, defaultSource });
        return { path: "/algorithms/detection-express-kiosk-pin-attack.js", existed: true };
      },
    };
    const loadDevClient = (): Promise<(deps: DevHostClientDeps) => DevHostClient> => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new Error("the dynamic import failed"));
      }
      return Promise.resolve(() => client);
    };

    render(<App controller={stubController()} loadDevClient={loadDevClient} />);

    // The first (mount) load rejected, so nothing connected, but the panel still mounts.
    const button = await screen.findByRole("button", { name: "Edit in my IDE" });
    expect(connects).toBe(0);
    expect(attempts).toBe(1);

    // One click retries the async load, connects the fresh client, and opens the file.
    await act(async () => {
      fireEvent.click(button);
    });

    expect(connects).toBe(1);
    expect(editCalls).toEqual([
      { name: scenarioSlug(kioskPinAttack.id), defaultSource: referenceSource },
    ]);
  });

  it("replays the last dev state to a panel that subscribes after the event", async () => {
    const dev = fakeDevKit();
    render(<App controller={stubController()} createDevClient={dev.factory} />);

    // Emit a dev state before the async panel has mounted and subscribed. Without a
    // replay of the cached state, the panel would stay in its off state.
    act(() => dev.deps().onState({ status: "connected", path: "/algorithms/x.js", message: null }));

    // Once the panel subscribes it replays the cached state and shows the active path.
    expect(await screen.findByText("/algorithms/x.js")).toBeDefined();
    expect(screen.getByRole("button", { name: "Stop editing" })).toBeDefined();
  });

  it("surfaces the host's failure message when opening the Scenario file fails", async () => {
    const factory = (_deps: DevHostClientDeps): DevHostClient => ({
      connect() {},
      disconnect() {},
      async editInIde() {
        throw new Error("The dev host is at capacity.");
      },
    });

    render(<App controller={stubController()} createDevClient={factory} />);
    const button = await screen.findByRole("button", { name: "Edit in my IDE" });
    fireEvent.click(button);

    // Scope to the message text: the HUD is also a role="status" region, so a bare
    // findByRole("status") would race against the dev panel's error status.
    const status = await screen.findByText("The dev host is at capacity.");
    expect(status.getAttribute("role")).toBe("status");
  });
});
