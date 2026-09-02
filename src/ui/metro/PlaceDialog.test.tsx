import { act, fireEvent, render, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useGameStore } from "../../game/store";
import { emptySnapshot, type SimSnapshot } from "../../sim/snapshot";
import type { ActorView } from "../../sim/world-snapshot";
import { PlaceDialog } from "./PlaceDialog";

function snapshotWith(actors: readonly ActorView[]): SimSnapshot {
  return { ...emptySnapshot(), actors };
}

function noFallback(): RefObject<HTMLElement | null> {
  return { current: null };
}

beforeEach(() => {
  useGameStore.setState({
    snapshot: emptySnapshot(),
    mapSelection: null,
    transport: { frozen: false, speed: 1 },
  });
});

describe("PlaceDialog", () => {
  it("renders nothing while no map selection is set", () => {
    const { container } = render(<PlaceDialog fallbackFocusRef={noFallback()} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a station's real name, meta, and its devices", () => {
    useGameStore.setState({ mapSelection: { kind: "node", id: "cen" } });
    render(<PlaceDialog fallbackFocusRef={noFallback()} />);
    expect(screen.getByRole("dialog", { name: "Central" })).toBeDefined();
    expect(screen.getByText("Account kiosk")).toBeDefined();
    expect(screen.getByText("Fare gate")).toBeDefined();
  });

  it("shows a site's place kind meta and its restricted devices", () => {
    useGameStore.setState({ mapSelection: { kind: "node", id: "dep" } });
    render(<PlaceDialog fallbackFocusRef={noFallback()} />);
    expect(screen.getByRole("dialog", { name: "Eastyard Depot" })).toBeDefined();
    expect(screen.getByText("Train tracker")).toBeDefined();
  });

  it("shows a train's onboard riders and no devices", () => {
    useGameStore.setState({
      mapSelection: { kind: "train", actorId: "T1" },
      snapshot: snapshotWith([
        {
          id: "T1",
          kind: "train",
          presence: { kind: "at", node: "riv", fromTick: 0, untilTick: 20 },
        },
        {
          id: "R1",
          kind: "rider",
          presence: { kind: "onTrain", train: "T1", fromTick: 0, untilTick: 20 },
        },
      ]),
    });
    render(<PlaceDialog fallbackFocusRef={noFallback()} />);
    expect(screen.getByRole("dialog", { name: /T1/ })).toBeDefined();
    expect(screen.getByText("R1")).toBeDefined();
    expect(screen.getByText("No devices here.")).toBeDefined();
  });

  it("re-renders live as the snapshot changes, without ever freezing the engine", () => {
    useGameStore.setState({
      mapSelection: { kind: "node", id: "cen" },
      snapshot: snapshotWith([
        {
          id: "R1",
          kind: "rider",
          presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 10 },
        },
      ]),
    });
    render(<PlaceDialog fallbackFocusRef={noFallback()} />);
    expect(screen.getByText("R1")).toBeDefined();

    act(() => {
      useGameStore.setState({
        snapshot: snapshotWith([
          {
            id: "R1",
            kind: "rider",
            presence: { kind: "at", node: "riv", fromTick: 0, untilTick: 10 },
          },
        ]),
      });
    });
    expect(screen.queryByText("R1")).toBeNull(); // moved off cen, live

    expect(useGameStore.getState().transport.frozen).toBe(false);
  });

  it("Escape clears the selection and restores focus to a connected trigger", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    useGameStore.setState({ mapSelection: { kind: "node", id: "cen" } });
    render(<PlaceDialog fallbackFocusRef={noFallback()} />);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(useGameStore.getState().mapSelection).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("falls back focus to the given ref when the trigger is gone", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const fallback = document.createElement("div");
    fallback.tabIndex = -1;
    document.body.appendChild(fallback);

    useGameStore.setState({ mapSelection: { kind: "node", id: "cen" } });
    render(<PlaceDialog fallbackFocusRef={{ current: fallback }} />);

    trigger.remove(); // the trigger disappears while the dialog is open

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(document.activeElement).toBe(fallback);
    fallback.remove();
  });

  it("the close button clears the selection", () => {
    useGameStore.setState({ mapSelection: { kind: "node", id: "cen" } });
    render(<PlaceDialog fallbackFocusRef={noFallback()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useGameStore.getState().mapSelection).toBeNull();
  });
});
