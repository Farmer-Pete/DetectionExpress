import { act, fireEvent, render, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useGameStore } from "../../game/store";
import { emptySnapshot, type SimSnapshot } from "../../sim/snapshot";
import type { WorldLogEvent } from "../../sim/world-log";
import type { ActorView } from "../../sim/world-snapshot";
import { PlaceDialog } from "./PlaceDialog";

function snapshotWith(actors: readonly ActorView[]): SimSnapshot {
  return { ...emptySnapshot(), actors };
}

function fareGateEvent(id: number, placeId: string): WorldLogEvent {
  return {
    id,
    ts: id,
    sensor: "fare-gate",
    placeId,
    chipNode: `${placeId}:gate`,
    reading: {
      sensor: "fare-gate",
      reading: {
        ts: id,
        card: `card-${id}`,
        station: placeId,
        line: "red",
        direction: "in",
        result: "ok",
        balance: 10,
      },
    },
    scored: false,
  };
}

function noFallback(): RefObject<HTMLElement | null> {
  return { current: null };
}

beforeEach(() => {
  useGameStore.setState({
    snapshot: emptySnapshot(),
    mapSelection: null,
    eventSelection: null,
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

  it("shows a train's onboard riders, aggregated, and no devices", () => {
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
    // The aggregated table: an actor kind/activity/count, never a raw actor id.
    expect(screen.getByText("Rider")).toBeDefined();
    expect(screen.getByText("heading to Riverside")).toBeDefined();
    expect(screen.getByText("1")).toBeDefined();
    expect(screen.queryByText("R1")).toBeNull();
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
    expect(screen.getByText("waiting for a train")).toBeDefined();

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
    // Moved off cen, live: the table row is gone and the empty state is back.
    expect(screen.queryByText("waiting for a train")).toBeNull();
    expect(screen.getByText("No one here right now.")).toBeDefined();

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

describe("PlaceDialog actors table (GH124-PLAN.md Checkpoint 4 Part 4)", () => {
  it("aggregates several actors doing the same thing into one row with a count, not one row each", () => {
    useGameStore.setState({
      mapSelection: { kind: "node", id: "cen" },
      snapshot: snapshotWith([
        {
          id: "R1",
          kind: "rider",
          presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
        },
        {
          id: "R2",
          kind: "rider",
          presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
        },
        {
          id: "R3",
          kind: "rider",
          presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
        },
      ]),
    });
    render(<PlaceDialog fallbackFocusRef={noFallback()} />);
    expect(screen.getByText("waiting for a train")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.queryByText("R1")).toBeNull();
  });

  it("sorts a pin-attacker row first and renders it in the threat tone", () => {
    useGameStore.setState({
      mapSelection: { kind: "node", id: "cen" },
      snapshot: snapshotWith([
        {
          id: "R1",
          kind: "rider",
          presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
        },
        {
          id: "R2",
          kind: "rider",
          presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
        },
        {
          id: "P1",
          kind: "pin-attacker",
          presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
        },
      ]),
    });
    render(<PlaceDialog fallbackFocusRef={noFallback()} />);
    const rows = document.querySelectorAll(".actor-table tbody tr");
    expect(rows[0]?.className).toContain("actor-table-row-threat");
    expect(rows[0]?.textContent).toContain("Pin attacker");
  });

  it("shows the empty state when no actor is at the selected place", () => {
    useGameStore.setState({ mapSelection: { kind: "node", id: "cen" } });
    render(<PlaceDialog fallbackFocusRef={noFallback()} />);
    expect(screen.getByText("No one here right now.")).toBeDefined();
    expect(document.querySelector(".actor-table")).toBeNull();
  });
});

describe("PlaceDialog scoped log (GH124-PLAN.md Checkpoint 5)", () => {
  it("shows only worldEvents scoped to this place, from the same ring", () => {
    useGameStore.setState({
      mapSelection: { kind: "node", id: "cen" },
      snapshot: {
        ...emptySnapshot(),
        worldEvents: [fareGateEvent(0, "cen"), fareGateEvent(1, "riv")],
      },
    });
    render(<PlaceDialog fallbackFocusRef={noFallback()} />);
    expect(screen.getByTestId("place-log-row-0")).toBeDefined();
    expect(screen.queryByTestId("place-log-row-1")).toBeNull();
  });

  it("shows an empty state when nothing has logged here yet", () => {
    useGameStore.setState({ mapSelection: { kind: "node", id: "cen" } });
    render(<PlaceDialog fallbackFocusRef={noFallback()} />);
    expect(screen.getByText("No activity logged here yet.")).toBeDefined();
  });

  it("selects the world event when a scoped-log row is clicked", () => {
    useGameStore.setState({
      mapSelection: { kind: "node", id: "cen" },
      snapshot: { ...emptySnapshot(), worldEvents: [fareGateEvent(0, "cen")] },
    });
    render(<PlaceDialog fallbackFocusRef={noFallback()} />);
    fireEvent.click(screen.getByTestId("place-log-row-0"));
    expect(useGameStore.getState().eventSelection).toBe(0);
  });
});
