/**
 * End-to-end browse-mode isolation (GH105-PLAN.md), at the real `App` seam: a real
 * click opens the trace dialog, and the shell goes `inert` while it is open. This is
 * the seam that proves `ModalHost`'s invariant actually wires up correctly in `App`,
 * not just in isolation (`ModalHost.test.tsx`) or under a bare `InspectorShell` +
 * `TraceOverlay` harness (`findings/TraceOverlay.test.tsx`). Stub controllers keep the
 * app from touching the real loader or engine, matching `App.test.tsx`'s pattern.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { referenceSource } from "../game/engine-source";
import type { RunController } from "../game/run-controller";
import { useGameStore } from "../game/store";
import type { LiveFinding } from "../sim/correctness";
import { emptySnapshot, type SimSnapshot } from "../sim/snapshot";
import { App } from "./App";
import { caughtDecision } from "./decisions/decision-fixtures";
import { markTourSeen } from "./onboarding-storage";

// The zustand store is a singleton shared across test files, so reset every field
// this file reads or writes before each test, or a leaked value would bleed across
// (mirrors App.test.tsx's own reset). The guided tour auto-starts on first load
// (GH132-PLAN.md M3); every test here seeds the seen flag so it never fires.
beforeEach(() => {
  useGameStore.setState({
    snapshot: emptySnapshot(),
    source: referenceSource,
    runPending: false,
    selection: null,
    decisionSelection: null,
    transport: { frozen: false, speed: 1 },
    overlayOpen: false,
  });
  markTourSeen();
});

/** A no-op pipeline controller: the app never touches the real loader or engine. */
function stubController(): RunController {
  return {
    run() {},
    setFrozen() {},
    setSpeed() {},
    triggerWave() {
      return null;
    },
    setChaosLevel() {},
    dispose() {},
  };
}

/** A hit LiveFinding fixture, grouped on "account" so it renders one clickable row. */
function live(seq: number, eventIds: number[]): LiveFinding {
  return {
    finding: { alert: { eventIds, reason: "pin_brute_force", at: 999 }, eventId: eventIds[0] ?? 0 },
    state: "hit",
    reason: "pin_brute_force",
    eventIds,
    at: 5,
    seq,
    entity: "acct-1",
    citedEvents: [],
  };
}

/** Publish a snapshot carrying the given finding, otherwise empty. */
function publishFinding(finding: LiveFinding): void {
  const snapshot: SimSnapshot = { ...emptySnapshot(), findings: [finding] };
  useGameStore.setState({ snapshot });
}

/** Publish a snapshot carrying the given decision, otherwise empty. */
function publishDecision(decision: ReturnType<typeof caughtDecision>): void {
  const snapshot: SimSnapshot = { ...emptySnapshot(), decisions: [decision] };
  useGameStore.setState({ snapshot });
}

/** True when `element` sits inside some `[inert]` ancestor (including itself). */
function isInInertSubtree(element: Element): boolean {
  return element.closest("[inert]") !== null;
}

describe("App browse-mode isolation (GH105)", () => {
  it("inerts the shell around .findings-panel while a finding's trace dialog is open, and keeps the dialog outside it", () => {
    publishFinding(live(1, [0]));
    render(<App createPipelineController={stubController} />);

    fireEvent.click(screen.getByRole("button", { name: /pin brute force/i }));

    const dialog = screen.getByRole("dialog");
    const findingsPanel = document.querySelector(".findings-panel");
    if (findingsPanel === null) {
      throw new Error("expected .findings-panel to render");
    }
    expect(isInInertSubtree(findingsPanel)).toBe(true);
    expect(isInInertSubtree(dialog)).toBe(false);
    expect(dialog.closest(".app-shell")).toBeNull();
  });

  it("inerts the shell around .decisions-panel while a decision's trace dialog is open, and keeps the dialog outside it", () => {
    publishDecision(caughtDecision({ seq: 1, eventIds: [0] }));
    render(<App createPipelineController={stubController} />);

    fireEvent.click(screen.getByRole("button", { name: /pin brute force/i }));

    const dialog = screen.getByRole("dialog");
    const decisionsPanel = document.querySelector(".decisions-panel");
    if (decisionsPanel === null) {
      throw new Error("expected .decisions-panel to render");
    }
    expect(isInInertSubtree(decisionsPanel)).toBe(true);
    expect(isInInertSubtree(dialog)).toBe(false);
    expect(dialog.closest(".app-shell")).toBeNull();
  });

  it("lifts the isolation on close: the shell is no longer inert and the dialog is gone", () => {
    publishFinding(live(1, [0]));
    render(<App createPipelineController={stubController} />);

    fireEvent.click(screen.getByRole("button", { name: /pin brute force/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });

    const shell = document.querySelector(".app-shell");
    if (shell === null) {
      throw new Error("expected an .app-shell element");
    }
    expect(shell.hasAttribute("inert")).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lifts the isolation on a backdrop dismiss: the shell is no longer inert and the dialog is gone", () => {
    publishFinding(live(1, [0]));
    render(<App createPipelineController={stubController} />);

    fireEvent.click(screen.getByRole("button", { name: /pin brute force/i }));
    const dialog = screen.getByRole("dialog");
    const backdrop = dialog.parentElement;
    if (backdrop === null) {
      throw new Error("expected the dialog to have a backdrop");
    }
    fireEvent.click(backdrop);

    const shell = document.querySelector(".app-shell");
    if (shell === null) {
      throw new Error("expected an .app-shell element");
    }
    expect(shell.hasAttribute("inert")).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lifts the isolation when reconciliation evicts the selection: the shell is no longer inert and the dialog is gone", () => {
    publishFinding(live(1, [0]));
    render(<App createPipelineController={stubController} />);

    fireEvent.click(screen.getByRole("button", { name: /pin brute force/i }));
    expect(screen.getByRole("dialog")).toBeDefined();

    // A run restart or horizon eviction publishes a snapshot without the selected finding;
    // the store reconciles the selection to null, closing the dialog through the same path
    // Esc and the backdrop take, so the shell's inert lifts here too.
    act(() => {
      useGameStore.getState().setSnapshot(emptySnapshot());
    });

    const shell = document.querySelector(".app-shell");
    if (shell === null) {
      throw new Error("expected an .app-shell element");
    }
    expect(shell.hasAttribute("inert")).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("restores focus only after the shell's inert attribute is already removed (the ordering, not just the end state)", () => {
    publishFinding(live(1, [0]));
    render(<App createPipelineController={stubController} />);

    const row = screen.getByRole("button", { name: /pin brute force/i });
    // Record the shell's inert state at the moment each `focus()` call runs, not just
    // the final DOM snapshot: a plain post-hoc assertion could pass even if the real
    // ordering were wrong, since happy-dom does not itself enforce inert-blocks-focus.
    const inertAtFocusCalls: Array<boolean | undefined> = [];
    const originalFocus = row.focus.bind(row);
    row.focus = () => {
      inertAtFocusCalls.push(document.querySelector(".app-shell")?.hasAttribute("inert"));
      originalFocus();
    };

    fireEvent.click(row); // opens the dialog; the row's own click handler focuses it first
    // Drop the open-time focus call(s), which the shell records while still non-inert:
    // only the close-time restore should count. Mutate in place so the reassigned
    // `row.focus` closure keeps writing to the same array.
    inertAtFocusCalls.length = 0;
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" }); // closes it; the close effect restores focus

    // Exactly one close-time restore must fire, and at that moment the shell must already
    // be un-inerted: React applies the `inert={false}` DOM mutation during commit, before
    // the passive-effect cleanup that calls focus() runs. Asserting the single call (not
    // just `.at(-1)`) also proves the restore actually happened — a regression that skipped
    // it could not pass on a leftover open-time reading — and the focus lands on the row.
    expect(inertAtFocusCalls).toEqual([false]);
    expect(document.activeElement).toBe(row);
  });

  it("keeps the finding trace open and its freeze held: the hamburger is exclusive with it and never opens the panel (GH117 + GH132-PLAN.md M1)", () => {
    // Pre-GH117, "Metro view" swapped controllers and the pipeline's teardown closed
    // the dialog and released its freeze (freeze lifecycle 7a). GH132-PLAN.md M1
    // (design revision) then moved the map toggle into the side panel's Options
    // tab, which is a real modal — exclusive with the trace dialog, the same
    // one-modal-at-a-time rule `useSidePanel`'s own tests cover. So the map
    // toggle is unreachable via the hamburger while a trace dialog is open;
    // this only checks that reaching for it (a no-op) never disturbs the
    // trace dialog or its freeze.
    publishFinding(live(1, [0]));
    render(<App createPipelineController={stubController} />);

    fireEvent.click(screen.getByRole("button", { name: /pin brute force/i }));
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(useGameStore.getState().transport.frozen).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /side panel/i }));

    expect(screen.queryByRole("dialog", { name: "Side panel" })).toBeNull();
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(useGameStore.getState().transport.frozen).toBe(true);
  });
});
