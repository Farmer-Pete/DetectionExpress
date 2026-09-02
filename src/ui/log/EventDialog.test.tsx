import { act, fireEvent, render, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import type { MapModalEntry } from "../../game/store";
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

/** A one-entry stack naming the given world-log id, for the common single-dialog cases. */
function eventStack(id: number): MapModalEntry[] {
  return [{ kind: "event", id }];
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
  });
});

describe("EventDialog: lifecycle", () => {
  it("renders nothing while the stack's top entry is not an event entry", () => {
    const { container } = render(
      <EventDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("opens when the stack's top entry names a live world event", () => {
    setSnapshot({ worldEvents: [fareGateWorldEvent()] });
    useGameStore.setState({ mapDialogStack: eventStack(1) });
    render(
      <EventDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("Escape at the root entry clears the whole stack and restores focus to a connected trigger", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    setSnapshot({ worldEvents: [fareGateWorldEvent()] });
    useGameStore.setState({ mapDialogStack: eventStack(1) });
    render(
      <EventDialog
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

  it("the close button clears the whole stack", () => {
    setSnapshot({ worldEvents: [fareGateWorldEvent()] });
    useGameStore.setState({ mapDialogStack: eventStack(1) });
    render(
      <EventDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useGameStore.getState().mapDialogStack).toEqual([]);
  });

  it("falls back focus to the given ref when the clicked trigger is gone", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const fallback = document.createElement("div");
    fallback.tabIndex = -1;
    document.body.appendChild(fallback);

    setSnapshot({ worldEvents: [fareGateWorldEvent()] });
    useGameStore.setState({ mapDialogStack: eventStack(1) });
    render(
      <EventDialog
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

  it("closes when the selected entry is evicted from the ring on a later publish", () => {
    setSnapshot({ worldEvents: [fareGateWorldEvent()] });
    useGameStore.setState({ mapDialogStack: eventStack(1) });
    render(
      <EventDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(screen.getByRole("dialog")).toBeDefined();

    // A fresh publish whose ring no longer carries id 1: the store's own setSnapshot
    // reconciliation filters the stale entry out of the stack (mirrors selection/
    // decisionSelection), and the dialog stops rendering as a direct consequence —
    // there is no separate close-detection effect in the component itself.
    act(() => {
      useGameStore.getState().setSnapshot({ ...emptySnapshot(), worldEvents: [] });
    });
    expect(useGameStore.getState().mapDialogStack).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("EventDialog navigation stack (GH124 follow-up: Back)", () => {
  it("shows no Back control at the root (single-entry) stack", () => {
    setSnapshot({ worldEvents: [fareGateWorldEvent()] });
    useGameStore.setState({ mapDialogStack: eventStack(1) });
    render(
      <EventDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("shows a Back control when this event dialog was pushed on top of a place dialog", () => {
    setSnapshot({ worldEvents: [fareGateWorldEvent()] });
    useGameStore.setState({
      mapDialogStack: [{ kind: "place", selection: { kind: "node", id: "cen" } }, ...eventStack(1)],
    });
    render(
      <EventDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(screen.getByRole("button", { name: "Back" })).toBeDefined();
  });

  it("Back pops this event entry, leaving the place entry underneath and closing this dialog", () => {
    setSnapshot({ worldEvents: [fareGateWorldEvent()] });
    useGameStore.setState({
      mapDialogStack: [{ kind: "place", selection: { kind: "node", id: "cen" } }, ...eventStack(1)],
    });
    render(
      <EventDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(useGameStore.getState().mapDialogStack).toEqual([
      { kind: "place", selection: { kind: "node", id: "cen" } },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape pops one entry while a Back is available, instead of closing the whole stack", () => {
    setSnapshot({ worldEvents: [fareGateWorldEvent()] });
    useGameStore.setState({
      mapDialogStack: [{ kind: "place", selection: { kind: "node", id: "cen" } }, ...eventStack(1)],
    });
    render(
      <EventDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(useGameStore.getState().mapDialogStack).toEqual([
      { kind: "place", selection: { kind: "node", id: "cen" } },
    ]);
  });

  it("the close button (X) always closes the WHOLE stack, even when a Back is available", () => {
    setSnapshot({ worldEvents: [fareGateWorldEvent()] });
    useGameStore.setState({
      mapDialogStack: [{ kind: "place", selection: { kind: "node", id: "cen" } }, ...eventStack(1)],
    });
    render(
      <EventDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(useGameStore.getState().mapDialogStack).toEqual([]);
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
    useGameStore.setState({ mapDialogStack: eventStack(5) });
    render(
      <EventDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(screen.getByText(/"acct": "rider"/)).toBeDefined();
    expect(screen.getByText(/"account": "rider"/)).toBeDefined();
    expect(screen.queryByTestId("event-detail-evicted-note")).toBeNull();
  });

  it("shows the 'normalized detail no longer retained' state for a scored reading evicted from the inspector ring", () => {
    const ev = kioskWorldEvent({ id: 5, scored: true, scoredEventId: 42 });
    // The wider world ring still carries this row, but snapshot.events (the 256-entry
    // inspector ring) no longer does.
    setSnapshot({ worldEvents: [ev], events: [] });
    useGameStore.setState({ mapDialogStack: eventStack(5) });
    render(
      <EventDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(screen.getByTestId("event-detail-evicted-note").textContent).toMatch(
      /no longer retained/i,
    );
    // GH124 follow-up (bug fix): the evicted branch gets an "Open place" link too, not
    // just the raw/otherwise branch.
    expect(screen.getByRole("button", { name: "Open place" })).toBeDefined();
  });

  it("shows raw + source, resolving the placeId while keeping the actorId raw", () => {
    setSnapshot({ worldEvents: [fareGateWorldEvent({ id: 1, actorId: "R1", placeId: "cen" })] });
    useGameStore.setState({ mapDialogStack: eventStack(1) });
    render(
      <EventDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );
    expect(screen.getByText(/"card": "card-1"/)).toBeDefined();
    // `placeId` resolves to its real name; `actorId` stays raw (GH127-PLAN.md M2).
    expect(screen.getByText("R1 at Central")).toBeDefined();
    expect(screen.getByRole("button", { name: "Open place" })).toBeDefined();
  });

  it("the 'open place' link PUSHES a place entry, keeping the event entry underneath (Back returns to it)", () => {
    setSnapshot({ worldEvents: [fareGateWorldEvent({ id: 1, placeId: "cen" })] });
    useGameStore.setState({ mapDialogStack: eventStack(1) });
    render(
      <EventDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open place" }));

    expect(useGameStore.getState().mapDialogStack).toEqual([
      ...eventStack(1),
      { kind: "place", selection: { kind: "node", id: "cen" } },
    ]);
  });

  it("a scored kiosk event dialog also renders 'Open place', and clicking it pushes the place entry, leaving the event underneath (GH124 follow-up: bug fix)", () => {
    const ev = kioskWorldEvent({ id: 5, placeId: "cen", scored: true, scoredEventId: 42 });
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
    useGameStore.setState({ mapDialogStack: eventStack(5) });
    render(
      <EventDialog
        fallbackFocusRef={noFallback()}
        rootTriggerRef={noRootTrigger()}
        rootFallbackFocusRef={noRootFallback()}
      />,
    );

    const openPlace = screen.getByRole("button", { name: "Open place" });
    fireEvent.click(openPlace);

    expect(useGameStore.getState().mapDialogStack).toEqual([
      ...eventStack(5),
      { kind: "place", selection: { kind: "node", id: "cen" } },
    ]);
  });
});
