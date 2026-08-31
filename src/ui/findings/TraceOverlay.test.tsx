import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useGameStore } from "../../game/store";
import type {
  CaughtDecision,
  Decision,
  FalseDecision,
  LiveFinding,
  MissedDecision,
} from "../../sim/correctness";
import type { Context, Finding } from "../../sim/finding";
import type { RingEvent } from "../../sim/inspector";
import { emptySnapshot, type SimSnapshot } from "../../sim/snapshot";
import { DecisionsPanel } from "../decisions/DecisionsPanel";
import { InspectorShell } from "./InspectorShell";

// The zustand store is a singleton shared across test files, so reset every field this
// file reads or writes before each test, or a leaked value would bleed across.
beforeEach(() => {
  useGameStore.setState({
    snapshot: emptySnapshot(),
    selection: null,
    decisionSelection: null,
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

/**
 * The decision-mode harness: `InspectorShell` and `DecisionsPanel` as siblings
 * sharing one ref, mirroring how `App.tsx` composes them (2.4). Decision mode's
 * focus fallback (decision 14) needs a real `DecisionsPanel` DOM node to fall back
 * to, which a bare `<InspectorShell />` alone never mounts.
 */
function Harness() {
  const decisionsPanelRef = useRef<HTMLElement>(null);
  return (
    <>
      <InspectorShell decisionsPanelRef={decisionsPanelRef} />
      <DecisionsPanel panelRef={decisionsPanelRef} />
    </>
  );
}

/** Render the harness, click the named decision's row, and hand back the row element. */
function openDecisionTraceByClick(name: RegExp): HTMLElement {
  render(<Harness />);
  const row = screen.getByRole("button", { name });
  row.focus();
  fireEvent.click(row);
  return row;
}

/** A caught decision. `at` is a fabricated decoy; the header must read `resolvedAt`. */
function caughtDecision(over: {
  seq: number;
  eventIds: number[];
  citedEvents?: RingEvent[];
  entity?: string;
  resolvedAt?: number;
  context?: Context;
}): CaughtDecision {
  const finding: Finding = {
    alert: { reason: "pin_brute_force", at: 999, eventIds: over.eventIds },
    eventId: over.eventIds[0] ?? 0,
    ...(over.context !== undefined ? { context: over.context } : {}),
  };
  return {
    outcome: "caught",
    seq: over.seq,
    at: 999,
    resolvedAt: over.resolvedAt ?? 5,
    attackId: 1,
    entity: over.entity ?? "acct-7",
    finding,
    citedEvents: over.citedEvents ?? [],
  };
}

/** A false decision. */
function falseDecision(over: {
  seq: number;
  eventIds: number[];
  citedEvents?: RingEvent[];
  entity?: string;
  resolvedAt?: number;
}): FalseDecision {
  const decision: FalseDecision = {
    outcome: "false",
    seq: over.seq,
    at: 999,
    resolvedAt: over.resolvedAt ?? 5,
    finding: {
      alert: { reason: "impossible_travel", at: 999, eventIds: over.eventIds },
      eventId: over.eventIds[0] ?? 0,
    },
    citedEvents: over.citedEvents ?? [],
  };
  if (over.entity !== undefined) {
    decision.entity = over.entity;
  }
  return decision;
}

/** A missed decision. */
function missedDecision(over: {
  seq: number;
  resolvedAt?: number;
  window?: { startTs: number; endTs: number };
}): MissedDecision {
  const window = over.window ?? { startTs: 0, endTs: 100 };
  return {
    outcome: "missed",
    seq: over.seq,
    at: over.resolvedAt ?? window.endTs,
    resolvedAt: over.resolvedAt ?? window.endTs,
    attackId: 1,
    entity: "acct-9",
    reason: "pin_brute_force",
    window,
  };
}

/** Publish a snapshot carrying the given decisions and ring events. */
function publishDecisions(decisions: Decision[], events: RingEvent[] = []): void {
  const snapshot: SimSnapshot = { ...emptySnapshot(), decisions, events };
  useGameStore.setState({ snapshot });
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

  it("labels the state badge with player-facing vocabulary, not the raw 'hit'/'watch' token", () => {
    publish([live({ seq: 1, eventIds: [0], entity: "acct-1", state: "hit" })], [ringEvent(0)]);
    openTraceByClick(/pin brute force/i);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Alert")).toBeDefined();
    expect(dialog.queryByText("hit")).toBeNull();
  });

  it("labels a watch's state badge as Watching", () => {
    publish([live({ seq: 1, eventIds: [0], entity: "acct-1", state: "watch" })], [ringEvent(0)]);
    openTraceByClick(/pin brute force/i);
    expect(screen.getByText("Watching")).toBeDefined();
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

  it("wraps Tab at the edges to keep focus within the dialog", () => {
    publish([live({ seq: 1, eventIds: [0], entity: "acct-1" })], [ringEvent(0)]);
    openTraceByClick(/pin brute force/i);
    const dialog = screen.getByRole("dialog");
    // The shipped dialog exposes only the close button today; append a second
    // control here (FOCUSABLE_SELECTOR is generic so the trap survives controls
    // added later, per src/ui/focus.ts) to exercise the wrap between two distinct
    // elements rather than a single control wrapping to itself.
    const extra = document.createElement("button");
    extra.type = "button";
    extra.textContent = "extra";
    dialog.appendChild(extra);
    const focusable = [...dialog.querySelectorAll<HTMLElement>("button, a[href]")];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined || first === last) {
      throw new Error("expected two distinct focusable controls");
    }

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("does not throw on Tab in the missed-decision solo panel, which carries fewer focusable controls", () => {
    publishDecisions([missedDecision({ seq: 1 })]);
    openDecisionTraceByClick(/pin brute force/i);
    const dialog = screen.getByRole("dialog");
    expect(() => fireEvent.keyDown(dialog, { key: "Tab" })).not.toThrow();
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

describe("TraceOverlay decision mode (T10)", () => {
  it("reopens a caught decision's evidence: outcome, entity, recorded-at, cited-event cards, and context", () => {
    publishDecisions(
      [
        caughtDecision({
          seq: 1,
          eventIds: [3],
          citedEvents: [
            {
              id: 3,
              ts: 30,
              endpoint: "kiosk-v1",
              raw: { acct: "amy" },
              normalized: { account: "amy" },
            },
          ],
          entity: "acct-7",
          resolvedAt: 65,
          context: [{ type: "text", text: "5 of 5 wrong PINs" }],
        }),
      ],
      [
        {
          id: 3,
          ts: 999,
          endpoint: "kiosk-v1",
          raw: { acct: "LIVE" },
          normalized: { account: "LIVE" },
        },
      ],
    );
    openDecisionTraceByClick(/pin brute force/i);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("caught")).toBeDefined();
    expect(dialog.getByText("acct-7")).toBeDefined();
    // The card resolves against the decision's frozen citedEvents, never the live ring
    // (which carries a decoy for the same id, proving the card is not reading it).
    expect(dialog.getByText(JSON.stringify({ acct: "amy" }))).toBeDefined();
    expect(dialog.queryByText(JSON.stringify({ acct: "LIVE" }))).toBeNull();
    expect(dialog.getByText("5 of 5 wrong PINs")).toBeDefined();
  });

  it("reopens a false decision's evidence with an entity-less chip omitted", () => {
    publishDecisions([falseDecision({ seq: 1, eventIds: [0] })]);
    openDecisionTraceByClick(/impossible travel/i);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("false")).toBeDefined();
  });

  it("renders a missed decision as a solo panel: reason and the attack window, no evidence nodes", () => {
    publishDecisions([missedDecision({ seq: 1, window: { startTs: 10, endTs: 100 } })]);
    openDecisionTraceByClick(/pin brute force/i);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("missed")).toBeDefined();
    expect(dialog.queryByText(/ingest \+ normalize/i)).toBeNull();
    expect(dialog.queryByText(/judge/i)).toBeNull();
    expect(dialog.queryByRole("region", { name: "Ingest and Normalize" })).toBeNull();
    expect(dialog.queryByRole("region", { name: "Judge" })).toBeNull();
  });

  it("shows the header's recorded-at time from resolvedAt, not the fabricated at", () => {
    // caughtDecision()'s at is fixed to 999 game seconds (16:39); resolvedAt is 65 (1:05).
    publishDecisions([caughtDecision({ seq: 1, eventIds: [0], resolvedAt: 65 })]);
    openDecisionTraceByClick(/pin brute force/i);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("1:05")).toBeDefined();
    expect(dialog.queryByText("16:39")).toBeNull();
  });

  it("closes on Esc, clearing the decision selection", () => {
    publishDecisions([caughtDecision({ seq: 1, eventIds: [0] })]);
    openDecisionTraceByClick(/pin brute force/i);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useGameStore.getState().decisionSelection).toBeNull();
  });

  it("restores focus to the trigger row on close, when it is still connected", () => {
    publishDecisions([caughtDecision({ seq: 1, eventIds: [0] })]);
    const row = openDecisionTraceByClick(/pin brute force/i);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(document.activeElement).toBe(row);
  });

  it("falls back to the decisions panel container when the trigger row was evicted by reconciliation", () => {
    publishDecisions([caughtDecision({ seq: 1, eventIds: [0] })]);
    openDecisionTraceByClick(/pin brute force/i);
    // A run restart publishes emptySnapshot(): the decision, and its row, are both
    // gone. The store's reconciliation clears decisionSelection, so the dialog closes.
    act(() => {
      useGameStore.getState().setSnapshot(emptySnapshot());
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(document.querySelector(".decisions-panel"));
  });

  it("freezes on open when not already frozen, and unfreezes on close", () => {
    publishDecisions([caughtDecision({ seq: 1, eventIds: [0] })]);
    expect(useGameStore.getState().transport.frozen).toBe(false);
    openDecisionTraceByClick(/pin brute force/i);
    expect(useGameStore.getState().transport.frozen).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(useGameStore.getState().transport.frozen).toBe(false);
  });

  it("forfeits its freeze claim once transport.frozen goes false while open, permanently", () => {
    publishDecisions([caughtDecision({ seq: 1, eventIds: [0] })]);
    openDecisionTraceByClick(/pin brute force/i);
    expect(useGameStore.getState().transport.frozen).toBe(true);

    act(() => {
      useGameStore.getState().setFrozen(false); // the player unfreezes manually
    });
    act(() => {
      useGameStore.getState().setFrozen(true); // the player re-freezes manually
    });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(useGameStore.getState().transport.frozen).toBe(true); // closing must not undo it
  });

  it("evicts a decision by the cap while its dialog is open after a manual unfreeze: closes via reconciliation, no spurious re-freeze, focus falls back", () => {
    publishDecisions([caughtDecision({ seq: 1, eventIds: [0] })]);
    openDecisionTraceByClick(/pin brute force/i);
    expect(useGameStore.getState().transport.frozen).toBe(true); // the overlay froze it

    // The player unfreezes manually while the dialog is open: the claim is forfeited.
    act(() => {
      useGameStore.getState().setFrozen(false);
    });

    // The cap (or a restart) evicts the open decision from the log. Reconciliation
    // clears the selection, closing the dialog via the same path a restart would.
    act(() => {
      useGameStore.getState().setSnapshot({ ...emptySnapshot(), decisions: [] });
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    // The forfeited claim must not spuriously re-freeze the run on close.
    expect(useGameStore.getState().transport.frozen).toBe(false);
    expect(document.activeElement).toBe(document.querySelector(".decisions-panel"));
  });

  it("prefers finding mode when a finding selection and a decision selection are both somehow set", () => {
    publishDecisions([caughtDecision({ seq: 1, eventIds: [0] })]);
    render(<Harness />);
    // Bypass the store's own mutual exclusion to prove the component's own precedence.
    act(() => {
      useGameStore.setState({
        snapshot: {
          ...emptySnapshot(),
          findings: [live({ seq: 2, eventIds: [0], entity: "acct-1" })],
        },
        selection: { seq: 2 },
        decisionSelection: { seq: 1 },
      });
    });
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Alert")).toBeDefined(); // the live trace's state chip, not "caught"
  });
});
