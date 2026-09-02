import { act, fireEvent, render, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useGameStore } from "../../game/store";
import { emptySnapshot, type SimSnapshot } from "../../sim/snapshot";
import type { WorldLogEvent } from "../../sim/world-log";
import { EventDialog } from "./EventDialog";

function kioskWorldEvent(overrides: Partial<WorldLogEvent> = {}): WorldLogEvent {
  return {
    id: 0,
    ts: 12,
    sensor: "kiosk",
    placeId: "cen",
    chipNode: "cen:kiosk",
    actorId: "patron-0",
    reading: {
      sensor: "kiosk",
      reading: { ts: 12, account: "rider", station: "cen", terminal: "K1", outcome: "success" },
    },
    scored: false,
    ...overrides,
  };
}

function fareGateWorldEvent(overrides: Partial<WorldLogEvent> = {}): WorldLogEvent {
  return {
    id: 1,
    ts: 12,
    sensor: "fare-gate",
    placeId: "cen",
    chipNode: "cen:gate",
    reading: {
      sensor: "fare-gate",
      reading: {
        ts: 12,
        card: "card-1",
        station: "cen",
        line: "red",
        direction: "in",
        result: "ok",
        balance: 50,
      },
    },
    scored: false,
    ...overrides,
  };
}

function setSnapshot(over: Partial<SimSnapshot> = {}): void {
  useGameStore.setState({ snapshot: { ...emptySnapshot(), ...over } });
}

function noFallback(): RefObject<HTMLElement | null> {
  return { current: null };
}

beforeEach(() => {
  useGameStore.setState({
    snapshot: emptySnapshot(),
    eventSelection: null,
    mapSelection: null,
  });
});

describe("EventDialog: lifecycle", () => {
  it("renders nothing while no event selection is set", () => {
    const { container } = render(<EventDialog fallbackFocusRef={noFallback()} />);
    expect(container.firstChild).toBeNull();
  });

  it("opens when eventSelection names a live world event", () => {
    setSnapshot({ worldEvents: [fareGateWorldEvent()] });
    useGameStore.setState({ eventSelection: 1 });
    render(<EventDialog fallbackFocusRef={noFallback()} />);
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("Escape clears the selection and restores focus to a connected trigger", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    setSnapshot({ worldEvents: [fareGateWorldEvent()] });
    useGameStore.setState({ eventSelection: 1 });
    render(<EventDialog fallbackFocusRef={noFallback()} />);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(useGameStore.getState().eventSelection).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("the close button clears the selection", () => {
    setSnapshot({ worldEvents: [fareGateWorldEvent()] });
    useGameStore.setState({ eventSelection: 1 });
    render(<EventDialog fallbackFocusRef={noFallback()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useGameStore.getState().eventSelection).toBeNull();
  });

  it("falls back focus to the given ref when the clicked trigger is gone", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const fallback = document.createElement("div");
    fallback.tabIndex = -1;
    document.body.appendChild(fallback);

    setSnapshot({ worldEvents: [fareGateWorldEvent()] });
    useGameStore.setState({ eventSelection: 1 });
    render(<EventDialog fallbackFocusRef={{ current: fallback }} />);

    trigger.remove(); // the trigger disappears while the dialog is open

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(document.activeElement).toBe(fallback);
    fallback.remove();
  });

  it("closes when the selected entry is evicted from the ring on a later publish", () => {
    setSnapshot({ worldEvents: [fareGateWorldEvent()] });
    useGameStore.setState({ eventSelection: 1 });
    render(<EventDialog fallbackFocusRef={noFallback()} />);
    expect(screen.getByRole("dialog")).toBeDefined();

    // A fresh publish whose ring no longer carries id 1: the store's own setSnapshot
    // reconciliation clears the selection (mirrors selection/decisionSelection), and
    // the dialog stops rendering as a direct consequence — there is no separate
    // close-detection effect in the component itself.
    act(() => {
      useGameStore.getState().setSnapshot({ ...emptySnapshot(), worldEvents: [] });
    });
    expect(useGameStore.getState().eventSelection).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("EventDialog: adaptive detail", () => {
  it("shows raw + normalized + citing findings for a scored kiosk reading still in the ring", () => {
    const ev = kioskWorldEvent({ id: 5, scored: true, scoredEventId: 42 });
    setSnapshot({
      worldEvents: [ev],
      events: [
        {
          id: 42,
          ts: 12,
          endpoint: "kiosk-v1",
          raw: { acct: "rider", term: "K1", res: "OK" },
          normalized: { account: "rider", outcome: "success" },
        },
      ],
    });
    useGameStore.setState({ eventSelection: 5 });
    render(<EventDialog fallbackFocusRef={noFallback()} />);
    expect(screen.getByText(/"acct": "rider"/)).toBeDefined();
    expect(screen.getByText(/"account": "rider"/)).toBeDefined();
    expect(screen.queryByTestId("event-detail-evicted-note")).toBeNull();
  });

  it("shows the 'normalized detail no longer retained' state for a scored reading evicted from the inspector ring", () => {
    const ev = kioskWorldEvent({ id: 5, scored: true, scoredEventId: 42 });
    // The wider world ring still carries this row, but snapshot.events (the 256-entry
    // inspector ring) no longer does.
    setSnapshot({ worldEvents: [ev], events: [] });
    useGameStore.setState({ eventSelection: 5 });
    render(<EventDialog fallbackFocusRef={noFallback()} />);
    expect(screen.getByTestId("event-detail-evicted-note").textContent).toMatch(
      /no longer retained/i,
    );
  });

  it("shows raw + source, and an 'open place' link, for a non-scored reading", () => {
    setSnapshot({ worldEvents: [fareGateWorldEvent({ id: 1, actorId: "R1", placeId: "cen" })] });
    useGameStore.setState({ eventSelection: 1 });
    render(<EventDialog fallbackFocusRef={noFallback()} />);
    expect(screen.getByText(/"card": "card-1"/)).toBeDefined();
    expect(screen.getByText(/R1/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Open place" })).toBeDefined();
  });

  it("the 'open place' link atomically swaps to the place dialog: closes the event selection and opens the place dialog in one update", () => {
    setSnapshot({ worldEvents: [fareGateWorldEvent({ id: 1, placeId: "cen" })] });
    useGameStore.setState({ eventSelection: 1 });
    render(<EventDialog fallbackFocusRef={noFallback()} />);

    fireEvent.click(screen.getByRole("button", { name: "Open place" }));

    const state = useGameStore.getState();
    expect(state.eventSelection).toBeNull();
    expect(state.mapSelection).toEqual({ kind: "node", id: "cen" });
  });
});
