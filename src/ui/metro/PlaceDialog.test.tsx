import { act, fireEvent, render, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import type { MapModalEntry } from "../../game/store";
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

/** A one-entry stack naming the given node, for the common single-dialog cases. */
function placeStack(id: string): MapModalEntry[] {
  return [{ kind: "place", selection: { kind: "node", id } }];
}

function noFallback(): RefObject<HTMLElement | null> {
  return { current: null };
}

/** A fresh root-trigger ref for tests that render a single dialog with no
 *  navigation-stack history to share it with. */
function noRootTrigger(): RefObject<Element | null> {
  return { current: null };
}

/** A fresh root-fallback ref, paired with `noRootTrigger()` above for the same
 *  single-dialog tests. */
function noRootFallback(): RefObject<RefObject<HTMLElement | null> | null> {
  return { current: null };
}

beforeEach(() => {
  useGameStore.setState({
    snapshot: emptySnapshot(),
    mapDialogStack: [],
    transport: { frozen: false, speed: 1 },
  });
});

describe("PlaceDialog", () => {
  it("renders nothing while the stack's top entry is not a place entry", () => {
    const { container } = render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows a station's real name, meta, and its devices", () => {
    useGameStore.setState({ mapDialogStack: placeStack("cen") });
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Central" })).toBeDefined();
    expect(screen.getByText("Account kiosk")).toBeDefined();
    expect(screen.getByText("Fare gate")).toBeDefined();
  });

  it("renders each device's sensors.data description and vendor list, not the raw sensor id", () => {
    useGameStore.setState({ mapDialogStack: placeStack("cen") });
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(
      screen.getByText(
        "The turnstile that guards the paid area. A tap either opens it or does not. It is the Z0 to Z1 boundary in physical form.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText("Gatekeep TurnKey 5, VeriTap FlowGate, RailSense GateNode"),
    ).toBeDefined();
    expect(screen.queryByText("fare-gate")).toBeNull();
  });

  it("shows a site's place kind meta and its restricted devices", () => {
    useGameStore.setState({ mapDialogStack: placeStack("dep") });
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Eastyard Depot" })).toBeDefined();
    expect(screen.getByText("Train tracker")).toBeDefined();
  });

  it("shows a train's onboard riders, aggregated, and no devices", () => {
    useGameStore.setState({
      mapDialogStack: [{ kind: "place", selection: { kind: "train", actorId: "T1" } }],
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
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    // T1 derives from the Red Line, so the dialog is titled by the authored train
    // name — never the raw train id (GH127-PLAN.md M2).
    expect(screen.getByRole("dialog", { name: "Red Line train" })).toBeDefined();
    // The aggregated table: an actor kind/activity/count, never a raw actor id.
    expect(screen.getByText("Rider")).toBeDefined();
    expect(screen.getByText("heading to Riverside")).toBeDefined();
    expect(screen.getByText("1")).toBeDefined();
    expect(screen.queryByText("R1")).toBeNull();
    expect(screen.getByText("No devices here.")).toBeDefined();
  });

  it("re-renders live as the snapshot changes, without ever freezing the engine", () => {
    useGameStore.setState({
      mapDialogStack: placeStack("cen"),
      snapshot: snapshotWith([
        {
          id: "R1",
          kind: "rider",
          presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 10 },
        },
      ]),
    });
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
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

  it("Escape at the root entry clears the whole stack and restores focus to a connected trigger", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    useGameStore.setState({ mapDialogStack: placeStack("cen") });
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(useGameStore.getState().mapDialogStack).toEqual([]);
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

    useGameStore.setState({ mapDialogStack: placeStack("cen") });
    render(
      <PlaceDialog
        fallbackFocusRef={{ current: fallback }}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );

    trigger.remove(); // the trigger disappears while the dialog is open

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(document.activeElement).toBe(fallback);
    fallback.remove();
  });

  it("the close button clears the whole stack", () => {
    useGameStore.setState({ mapDialogStack: placeStack("cen") });
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useGameStore.getState().mapDialogStack).toEqual([]);
  });
});

describe("PlaceDialog navigation stack (GH124 follow-up: Back)", () => {
  it("shows no Back control at the root (single-entry) stack", () => {
    useGameStore.setState({ mapDialogStack: placeStack("cen") });
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("shows a Back control when this place dialog was pushed on top of an event dialog", () => {
    useGameStore.setState({
      mapDialogStack: [{ kind: "event", id: 5 }, ...placeStack("cen")],
    });
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(screen.getByRole("button", { name: "Back" })).toBeDefined();
  });

  it("Back pops this place entry, leaving the event entry underneath and closing this dialog", () => {
    useGameStore.setState({
      mapDialogStack: [{ kind: "event", id: 5 }, ...placeStack("cen")],
    });
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(useGameStore.getState().mapDialogStack).toEqual([{ kind: "event", id: 5 }]);
    expect(screen.queryByRole("dialog", { name: "Central" })).toBeNull();
  });

  it("Escape pops one entry while a Back is available, instead of closing the whole stack", () => {
    useGameStore.setState({
      mapDialogStack: [{ kind: "event", id: 5 }, ...placeStack("cen")],
    });
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(useGameStore.getState().mapDialogStack).toEqual([{ kind: "event", id: 5 }]);
  });

  it("the close button (X) always closes the WHOLE stack, even when a Back is available", () => {
    useGameStore.setState({
      mapDialogStack: [{ kind: "event", id: 5 }, ...placeStack("cen")],
    });
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(useGameStore.getState().mapDialogStack).toEqual([]);
  });
});

describe("PlaceDialog actors table (GH124-PLAN.md Checkpoint 4 Part 4)", () => {
  it("aggregates several actors doing the same thing into one row with a count, not one row each", () => {
    useGameStore.setState({
      mapDialogStack: placeStack("cen"),
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
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(screen.getByText("waiting for a train")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.queryByText("R1")).toBeNull();
  });

  it("sorts a pin-attacker row first and renders it in the threat tone", () => {
    useGameStore.setState({
      mapDialogStack: placeStack("cen"),
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
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    const rows = document.querySelectorAll(".actor-table tbody tr");
    expect(rows[0]?.className).toContain("actor-table-row-threat");
    expect(rows[0]?.textContent).toContain("Attacker");
    expect(rows[0]?.textContent).toContain("Pin attacking");
  });

  it("shows the empty state when no actor is at the selected place", () => {
    useGameStore.setState({ mapDialogStack: placeStack("cen") });
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(screen.getByText("No one here right now.")).toBeDefined();
    expect(document.querySelector(".actor-table")).toBeNull();
  });
});

describe("PlaceDialog scoped log (GH124-PLAN.md Checkpoint 5)", () => {
  it("shows only worldEvents scoped to this place, from the same ring", () => {
    useGameStore.setState({
      mapDialogStack: placeStack("cen"),
      snapshot: {
        ...emptySnapshot(),
        worldEvents: [fareGateEvent(0, "cen"), fareGateEvent(1, "riv")],
      },
    });
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(screen.getByTestId("place-log-row-0")).toBeDefined();
    expect(screen.queryByTestId("place-log-row-1")).toBeNull();
  });

  it("shows an empty state when nothing has logged here yet", () => {
    useGameStore.setState({ mapDialogStack: placeStack("cen") });
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(screen.getByText("No activity logged here yet.")).toBeDefined();
  });

  it("clicking a scoped-log row PUSHES an event entry, keeping the place entry underneath", () => {
    useGameStore.setState({
      mapDialogStack: placeStack("cen"),
      snapshot: { ...emptySnapshot(), worldEvents: [fareGateEvent(0, "cen")] },
    });
    render(
      <PlaceDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    fireEvent.click(screen.getByTestId("place-log-row-0"));
    expect(useGameStore.getState().mapDialogStack).toEqual([
      ...placeStack("cen"),
      { kind: "event", id: 0 },
    ]);
  });
});
