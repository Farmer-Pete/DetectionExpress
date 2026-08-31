import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useGameStore } from "../../game/store";
import type { LiveFinding } from "../../sim/correctness";
import type { Context, Finding } from "../../sim/finding";
import type { RingEvent } from "../../sim/inspector";
import { emptySnapshot, type SimSnapshot } from "../../sim/snapshot";
import { InspectorShell } from "./InspectorShell";

// The zustand store is a singleton shared across test files, so reset every field this
// file reads or writes before each test, or a leaked value would bleed across.
beforeEach(() => {
  useGameStore.setState({
    snapshot: emptySnapshot(),
    selection: null,
    transport: { frozen: false, speed: 1 },
  });
});

/** One ring event, distinguishable by id. */
function ringEvent(id: number, over: Partial<RingEvent> = {}): RingEvent {
  return {
    id,
    ts: id * 10,
    endpoint: "kiosk-v1",
    raw: { acct: `raw-${id}` },
    normalized: { account: `norm-${id}` },
    ...over,
  };
}

interface LiveOverrides {
  seq: number;
  eventIds: number[];
  entity?: string;
  reason?: string;
  state?: "hit" | "watch";
  at?: number;
  context?: Context;
}

/** One LiveFinding, grouped on "account" when `entity` is given, matching FindingsPanel's
 *  own fixture shape so a real click on its row works end to end. */
function live(over: LiveOverrides): LiveFinding {
  const reason = over.reason ?? "pin_brute_force";
  const finding: Finding = {
    alert: { eventIds: over.eventIds, reason, at: 999 },
    eventId: over.eventIds[0] ?? 0,
    ...(over.entity !== undefined ? { subjectType: "account" } : {}),
    ...(over.context !== undefined ? { context: over.context } : {}),
  };
  const result: LiveFinding = {
    finding,
    state: over.state ?? "hit",
    reason,
    eventIds: over.eventIds,
    at: over.at ?? 5,
    seq: over.seq,
  };
  if (over.entity !== undefined) {
    result.entity = over.entity;
  }
  return result;
}

/** Publish a snapshot carrying the given findings and ring events. */
function publish(findings: LiveFinding[], events: RingEvent[] = []): void {
  const snapshot: SimSnapshot = { ...emptySnapshot(), findings, events };
  useGameStore.setState({ snapshot });
}

/** Render the shell, click the named finding's row, and hand back the row element (the
 *  trigger a real click would focus, native-button default focus behavior). */
function openTraceByClick(name: RegExp): HTMLElement {
  render(<InspectorShell />);
  const row = screen.getByRole("button", { name });
  row.focus();
  fireEvent.click(row);
  return row;
}

describe("TraceOverlay", () => {
  it("renders nothing when no finding is selected", () => {
    publish([live({ seq: 1, eventIds: [0], entity: "acct-1" })], [ringEvent(0)]);
    render(<InspectorShell />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a dialog on selection with the header, both nodes, and a hit verdict", () => {
    publish(
      [live({ seq: 1, eventIds: [0], entity: "acct-1", reason: "pin_brute_force" })],
      [ringEvent(0)],
    );
    openTraceByClick(/pin brute force/i);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeDefined();
    const inDialog = within(dialog);
    expect(inDialog.getByText("acct-1")).toBeDefined();
    expect(inDialog.getByText(/ingest \+ normalize/i)).toBeDefined();
    expect(inDialog.getByText(/judge/i)).toBeDefined();
    expect(inDialog.getByText("finding raised")).toBeDefined();
  });

  it("renders the watch verdict when the finding is a watch, not a hit", () => {
    publish([live({ seq: 1, eventIds: [0], entity: "acct-1", state: "watch" })], [ringEvent(0)]);
    openTraceByClick(/pin brute force/i);
    expect(screen.getByText("watching, no finding yet")).toBeDefined();
  });

  it("renders one card per cited event, raw over normalized, with its endpoint and time", () => {
    publish(
      [live({ seq: 1, eventIds: [3], entity: "acct-1" })],
      [
        ringEvent(3, {
          ts: 30,
          endpoint: "kiosk-v1",
          raw: { acct: "amy" },
          normalized: { account: "amy" },
        }),
      ],
    );
    openTraceByClick(/pin brute force/i);
    const inDialog = within(screen.getByRole("dialog"));
    expect(inDialog.getByText("kiosk-v1")).toBeDefined();
    expect(inDialog.getByText(JSON.stringify({ acct: "amy" }))).toBeDefined();
    expect(inDialog.getByText(JSON.stringify({ account: "amy" }))).toBeDefined();
  });

  it("renders an aged-out placeholder card for a cited id evicted from the ring", () => {
    publish([live({ seq: 1, eventIds: [0, 1], entity: "acct-1" })], [ringEvent(1)]);
    openTraceByClick(/pin brute force/i);
    expect(screen.getByText(/aged out of the recent stream/i)).toBeDefined();
  });

  it("renders the finding's kv context widget under the Judge node", () => {
    publish(
      [
        live({
          seq: 1,
          eventIds: [0],
          entity: "acct-1",
          context: [
            {
              type: "kv",
              entries: [{ label: "wrong PINs", value: 5 }],
            },
          ],
        }),
      ],
      [ringEvent(0)],
    );
    openTraceByClick(/pin brute force/i);
    expect(screen.getByText("wrong PINs")).toBeDefined();
  });

  it("closes on Esc, clearing the selection", () => {
    publish([live({ seq: 1, eventIds: [0], entity: "acct-1" })], [ringEvent(0)]);
    openTraceByClick(/pin brute force/i);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("closes on a backdrop click but not on a click inside the dialog", () => {
    publish([live({ seq: 1, eventIds: [0], entity: "acct-1" })], [ringEvent(0)]);
    openTraceByClick(/pin brute force/i);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    const backdrop = dialog.parentElement;
    if (backdrop === null) {
      throw new Error("the dialog has no backdrop");
    }
    fireEvent.click(backdrop);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("has a close button that clears the selection", () => {
    publish([live({ seq: 1, eventIds: [0], entity: "acct-1" })], [ringEvent(0)]);
    openTraceByClick(/pin brute force/i);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("moves focus into the dialog on open", () => {
    publish([live({ seq: 1, eventIds: [0], entity: "acct-1" })], [ringEvent(0)]);
    openTraceByClick(/pin brute force/i);
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("restores focus to the trigger row on close, when it is still connected", () => {
    publish([live({ seq: 1, eventIds: [0], entity: "acct-1" })], [ringEvent(0)]);
    const row = openTraceByClick(/pin brute force/i);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(document.activeElement).toBe(row);
  });

  it("falls back to the findings panel container when the trigger row was evicted by reconciliation", () => {
    publish([live({ seq: 1, eventIds: [0], entity: "acct-1" })], [ringEvent(0)]);
    openTraceByClick(/pin brute force/i);
    // A run restart (Apply, hot reload, or stop-then-restart) publishes emptySnapshot():
    // the finding, and its row, are both gone. The store's own reconciliation clears the
    // selection, so the dialog closes; the trigger is no longer connected.
    act(() => {
      useGameStore.getState().setSnapshot(emptySnapshot());
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(document.querySelector(".findings-panel"));
  });

  it("freezes on open when not already frozen, and unfreezes on close", () => {
    publish([live({ seq: 1, eventIds: [0], entity: "acct-1" })], [ringEvent(0)]);
    expect(useGameStore.getState().transport.frozen).toBe(false);
    openTraceByClick(/pin brute force/i);
    expect(useGameStore.getState().transport.frozen).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(useGameStore.getState().transport.frozen).toBe(false);
  });

  it("respects a manual pre-freeze: it neither re-freezes nor unfreezes on close", () => {
    publish([live({ seq: 1, eventIds: [0], entity: "acct-1" })], [ringEvent(0)]);
    useGameStore.getState().setFrozen(true);
    openTraceByClick(/pin brute force/i);
    expect(useGameStore.getState().transport.frozen).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(useGameStore.getState().transport.frozen).toBe(true);
  });

  it("forfeits its freeze claim once transport.frozen goes false while open, permanently", () => {
    publish([live({ seq: 1, eventIds: [0], entity: "acct-1" })], [ringEvent(0)]);
    openTraceByClick(/pin brute force/i);
    expect(useGameStore.getState().transport.frozen).toBe(true); // the overlay froze it

    // The player unfreezes manually (e.g. Space) while the dialog is open: the overlay's
    // claim is forfeited from this point on, permanently, per GH34-35-PLAN.md decision 5.
    act(() => {
      useGameStore.getState().setFrozen(false);
    });
    // The player re-freezes manually. The overlay must not treat this as its own claim.
    act(() => {
      useGameStore.getState().setFrozen(true);
    });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    // Closing must NOT undo the player's own re-freeze.
    expect(useGameStore.getState().transport.frozen).toBe(true);
  });

  it("closes via reconciliation on a snapshot reset, resolving a freeze claim it still held", () => {
    publish([live({ seq: 1, eventIds: [0], entity: "acct-1" })], [ringEvent(0)]);
    openTraceByClick(/pin brute force/i);
    expect(useGameStore.getState().transport.frozen).toBe(true);

    act(() => {
      useGameStore.getState().setSnapshot(emptySnapshot());
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useGameStore.getState().transport.frozen).toBe(false);
  });

  it("survives a stop-then-restart cycle, then runs a clean freeze cycle on the next selection", () => {
    publish([live({ seq: 1, eventIds: [0], entity: "acct-1" })], [ringEvent(0)]);
    openTraceByClick(/pin brute force/i);
    // The engine stops and restarts: a fresh scorer publishes an empty snapshot first.
    act(() => {
      useGameStore.getState().setSnapshot(emptySnapshot());
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useGameStore.getState().transport.frozen).toBe(false);

    // The restarted run raises a fresh finding at a fresh seq. Selecting it must run a
    // clean freeze cycle: no state from the last dialog's forfeit or claim leaks over.
    act(() => {
      publish([live({ seq: 1, eventIds: [0], entity: "acct-2" })], [ringEvent(0)]);
    });
    const row = screen.getByRole("button", { name: /pin brute force/i });
    row.focus();
    fireEvent.click(row);
    expect(useGameStore.getState().transport.frozen).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(useGameStore.getState().transport.frozen).toBe(false);
  });

  it("leaves the dialog and freeze untouched by an unrelated store update (a failed dry run)", () => {
    publish([live({ seq: 1, eventIds: [0], entity: "acct-1" })], [ringEvent(0)]);
    openTraceByClick(/pin brute force/i);
    expect(useGameStore.getState().transport.frozen).toBe(true);

    // A failed dry run reports an error but never touches the snapshot: the live engine
    // (and this dialog) is untouched.
    act(() => {
      useGameStore.getState().setError({ phase: "load", message: "boom" });
    });

    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(useGameStore.getState().transport.frozen).toBe(true);
  });
});
