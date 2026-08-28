import { beforeEach, describe, expect, it } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { DevHostClient, DevHostClientDeps, DevState } from "../game/dev-host-client";
import type { RunController } from "../game/run-controller";
import { useGameStore } from "../game/store";
import { referenceSource } from "../sim/scenarios/kiosk-pin-attack/reference";
import { kioskPinAttack } from "../sim/scenarios/kiosk-pin-attack/scenario";
import { App } from "./App";
import { levelSlug } from "./levels";

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

  it("opens the level file in the IDE with the level slug and reference source", async () => {
    const dev = fakeDevKit();
    render(<App controller={stubController()} createDevClient={dev.factory} />);

    // The panel is loaded through the folded DEV_KIT gate, so it mounts asynchronously.
    const button = await screen.findByRole("button", { name: "Edit in my IDE" });
    fireEvent.click(button);

    expect(dev.editCalls).toEqual([
      { name: levelSlug(kioskPinAttack.id), defaultSource: referenceSource },
    ]);
  });
});
