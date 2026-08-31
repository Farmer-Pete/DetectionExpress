import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useGameStore } from "../../game/store";
import { URGENT_HITS } from "../../game/tuning";
import type { LiveFinding } from "../../sim/correctness";
import type { Finding } from "../../sim/finding";
import { emptySnapshot } from "../../sim/snapshot";
import { InspectorShell } from "./InspectorShell";

// The zustand store is a singleton shared across test files, so reset the fields this
// file reads before each test, or a leaked snapshot or selection would bleed across.
beforeEach(() => {
  useGameStore.setState({ snapshot: emptySnapshot(), selection: null });
});

/** Build a LiveFinding; `subjectType` lands on the emitted (Anchored) Finding. */
function live(
  over: { seq: number; subjectType?: string; entity?: string } & Partial<LiveFinding>,
): LiveFinding {
  const { subjectType, entity, ...rest } = over;
  const reason = rest.reason ?? "pin_brute_force";
  // A real anchor in BOTH the nested alert.eventIds and the top-level snapshot keeps the
  // fixture consistent; the no-subject branch still carries the now-required eventId.
  const finding: Finding =
    subjectType !== undefined
      ? { alert: { eventIds: [over.seq], reason, at: 0 }, eventId: over.seq, subjectType }
      : { alert: { eventIds: [over.seq], reason, at: 0 }, eventId: over.seq };
  const result: LiveFinding = {
    finding,
    state: rest.state ?? "hit",
    reason,
    eventIds: rest.eventIds ?? [over.seq],
    at: rest.at ?? 0,
    seq: over.seq,
  };
  // `exactOptionalPropertyTypes`: only set `entity` when present, never to `undefined`.
  if (entity !== undefined) {
    result.entity = entity;
  }
  return result;
}

/** Publish a snapshot carrying the given findings. */
function publish(findings: LiveFinding[]): void {
  useGameStore.setState({ snapshot: { ...emptySnapshot(), findings } });
}

describe("FindingsPanel", () => {
  it("renders a group with its entity chip and agreement badge", () => {
    publish([
      live({ seq: 1, subjectType: "account", entity: "acct-7", reason: "pin_brute_force" }),
      live({ seq: 2, subjectType: "account", entity: "acct-7", reason: "impossible_travel" }),
    ]);
    render(<InspectorShell />);
    expect(screen.getByText("acct-7")).toBeDefined();
    expect(screen.getByText("account")).toBeDefined();
    expect(screen.getByText("Agreement")).toBeDefined();
    expect(screen.getByText("Pin brute force")).toBeDefined();
    expect(screen.getByText("Impossible travel")).toBeDefined();
  });

  it("renders each row as a button carrying aria-pressed", () => {
    publish([live({ seq: 1, subjectType: "account", entity: "a" })]);
    render(<InspectorShell />);
    const row = screen.getByRole("button", { name: /pin brute force/i });
    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("aria-pressed")).toBe("false");
  });

  it("exposes rows as native buttons the browser activates on Enter or Space", () => {
    publish([live({ seq: 5, subjectType: "account", entity: "a" })]);
    render(<InspectorShell />);
    const row = screen.getByRole("button", { name: /pin brute force/i });
    // A native <button> fires a click on Enter and Space, so its onClick IS the keyboard
    // activation path. happy-dom does not synthesize that click from a raw keydown, so we
    // assert the semantic-button contract and drive its activation directly.
    expect(row.tagName).toBe("BUTTON");
    row.focus();
    expect(document.activeElement).toBe(row); // focusable, so keyboard can reach it
    fireEvent.click(row); // the event a browser dispatches for Enter/Space on a button
    expect(useGameStore.getState().selection).toEqual({ seq: 5 });
  });

  it("selects and highlights a row on click, and deselects on re-click", () => {
    publish([live({ seq: 5, subjectType: "account", entity: "a" })]);
    render(<InspectorShell />);
    const row = screen.getByRole("button", { name: /pin brute force/i });
    fireEvent.click(row);
    expect(useGameStore.getState().selection).toEqual({ seq: 5 });
    expect(
      screen.getByRole("button", { name: /pin brute force/i }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /pin brute force/i }));
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("clears the selection on Esc from inside the shell", () => {
    publish([live({ seq: 5, subjectType: "account", entity: "a" })]);
    render(<InspectorShell />);
    const row = screen.getByRole("button", { name: /pin brute force/i });
    fireEvent.click(row);
    expect(useGameStore.getState().selection).toEqual({ seq: 5 });
    fireEvent.keyDown(row, { key: "Escape" });
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("does not clear on Esc that a child already handled (defaultPrevented)", () => {
    publish([live({ seq: 5, subjectType: "account", entity: "a" })]);
    const { container } = render(<InspectorShell />);
    useGameStore.getState().selectFinding(5);
    const shell = container.querySelector(".inspector-shell");
    if (!shell) {
      throw new Error("expected the inspector shell");
    }
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    event.preventDefault(); // a nested widget consumed it first
    shell.dispatchEvent(event);
    expect(useGameStore.getState().selection).toEqual({ seq: 5 });
  });

  it("clears the selection on a click on the panel background", () => {
    publish([live({ seq: 5, subjectType: "account", entity: "a" })]);
    const { container } = render(<InspectorShell />);
    useGameStore.getState().selectFinding(5);
    const panel = container.querySelector<HTMLElement>(".findings-panel");
    if (!panel) {
      throw new Error("expected the findings panel");
    }
    fireEvent.click(panel);
    expect(useGameStore.getState().selection).toBeNull();
  });

  it("shows the empty state when there are no findings", () => {
    publish([]);
    render(<InspectorShell />);
    expect(screen.getByText(/no findings yet/i)).toBeDefined();
  });

  it("shows the active hit count in the header, ignoring watches", () => {
    publish([
      live({ seq: 1, subjectType: "account", entity: "a", state: "hit" }),
      live({ seq: 2, subjectType: "account", entity: "b", state: "watch" }),
      live({ seq: 3, subjectType: "account", entity: "c", state: "hit" }),
    ]);
    render(<InspectorShell />);
    expect(screen.getByText("⚠ 2 active")).toBeDefined();
  });

  it("carries no urgent class below URGENT_HITS", () => {
    const findings = Array.from({ length: URGENT_HITS - 1 }, (_, i) =>
      live({ seq: i + 1, subjectType: "account", entity: `e${i}`, state: "hit" }),
    );
    publish(findings);
    const { container } = render(<InspectorShell />);
    expect(container.querySelector(".findings-panel")?.className).not.toMatch(/urgent/);
  });

  it("gains the urgent class at URGENT_HITS live hits", () => {
    const findings = Array.from({ length: URGENT_HITS }, (_, i) =>
      live({ seq: i + 1, subjectType: "account", entity: `e${i}`, state: "hit" }),
    );
    publish(findings);
    const { container } = render(<InspectorShell />);
    expect(screen.getByText(`⚠ ${URGENT_HITS} active`)).toBeDefined();
    expect(container.querySelector(".findings-panel")?.className).toMatch(/urgent/);
  });

  it("carries the status region always, with no 'urgent' text below URGENT_HITS", () => {
    const findings = Array.from({ length: URGENT_HITS - 1 }, (_, i) =>
      live({ seq: i + 1, subjectType: "account", entity: `e${i}`, state: "hit" }),
    );
    publish(findings);
    const { container } = render(<InspectorShell />);
    const panel = container.querySelector<HTMLElement>(".findings-panel");
    if (!panel) {
      throw new Error("expected the findings panel");
    }
    const status = within(panel).getByRole("status");
    expect(status.className).toMatch(/visually-hidden/);
    expect(status.textContent).not.toMatch(/urgent/i);
  });

  it("carries 'urgent' in the status region's text at URGENT_HITS, so the state is perceivable without the border pulse", () => {
    const findings = Array.from({ length: URGENT_HITS }, (_, i) =>
      live({ seq: i + 1, subjectType: "account", entity: `e${i}`, state: "hit" }),
    );
    publish(findings);
    const { container } = render(<InspectorShell />);
    const panel = container.querySelector<HTMLElement>(".findings-panel");
    if (!panel) {
      throw new Error("expected the findings panel");
    }
    const status = within(panel).getByRole("status");
    expect(status.className).toMatch(/visually-hidden/);
    expect(status.textContent).toMatch(/urgent/i);
    // The visible counter's own text stays exactly as before; the status region is a
    // separate node, so its text never leaks into the visible string.
    expect(screen.getByText(`⚠ ${URGENT_HITS} active`)).toBeDefined();
  });

  it("shows a +N more line past the cap and expands it", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      live({ seq: i + 1, subjectType: "account", entity: `e${i}`, at: 15 - i }),
    );
    publish(many);
    render(<InspectorShell />);
    const more = screen.getByRole("button", { name: /\+3 more/i });
    expect(more).toBeDefined();
    // Before expanding, the 13th-ranked group (entity e12) is hidden.
    expect(screen.queryByText("e12")).toBeNull();
    fireEvent.click(more);
    expect(screen.getByText("e12")).toBeDefined();
  });
});

describe("FindingsPanel persistent status region (GH38 review round 3, F002+F012)", () => {
  it("mounts the status node even with zero findings, silent", () => {
    publish([]);
    const { container } = render(<InspectorShell />);
    const panel = container.querySelector<HTMLElement>(".findings-panel");
    if (!panel) {
      throw new Error("expected the findings panel");
    }
    expect(within(panel).getByRole("status").textContent).toBe("");
  });

  it("mutates the SAME status node's text to the complete urgent phrase once a burst crosses URGENT_HITS", () => {
    publish([]);
    const { container } = render(<InspectorShell />);
    const panel = container.querySelector<HTMLElement>(".findings-panel");
    if (!panel) {
      throw new Error("expected the findings panel");
    }
    const status = within(panel).getByRole("status");
    expect(status.textContent).toBe("");

    const burst = Array.from({ length: URGENT_HITS }, (_, i) =>
      live({ seq: i + 1, subjectType: "account", entity: `e${i}`, state: "hit" }),
    );
    act(() => {
      publish(burst);
    });

    // The SAME DOM node, only its text mutated — a node that mounts pre-filled
    // announces nothing, so identity is what makes the announcement fire.
    expect(within(panel).getByRole("status")).toBe(status);
    expect(status.textContent).toBe(`findings urgent, ${URGENT_HITS} active`);
    expect(status.textContent?.startsWith(",")).toBe(false);
  });

  it("keeps the status text empty below URGENT_HITS", () => {
    const findings = Array.from({ length: URGENT_HITS - 1 }, (_, i) =>
      live({ seq: i + 1, subjectType: "account", entity: `e${i}`, state: "hit" }),
    );
    publish(findings);
    const { container } = render(<InspectorShell />);
    const panel = container.querySelector<HTMLElement>(".findings-panel");
    if (!panel) {
      throw new Error("expected the findings panel");
    }
    expect(within(panel).getByRole("status").textContent).toBe("");
  });

  it("leaves the visible '⚠ N active' count text unchanged by the status region", () => {
    const findings = Array.from({ length: URGENT_HITS }, (_, i) =>
      live({ seq: i + 1, subjectType: "account", entity: `e${i}`, state: "hit" }),
    );
    publish(findings);
    render(<InspectorShell />);
    expect(screen.getByText(`⚠ ${URGENT_HITS} active`)).toBeDefined();
  });
});

describe("FindingsPanel active-count glyph (GH38 review round 3, F017)", () => {
  it("omits the ⚠ glyph when the active count is zero, keeping the count and 'active' text", () => {
    publish([live({ seq: 1, subjectType: "account", entity: "a", state: "watch" })]);
    render(<InspectorShell />);
    expect(screen.getByText("0 active")).toBeDefined();
    expect(screen.queryByText(/⚠/)).toBeNull();
  });

  it("shows the ⚠ glyph once the active count is above zero", () => {
    publish([live({ seq: 1, subjectType: "account", entity: "a", state: "hit" })]);
    render(<InspectorShell />);
    expect(screen.getByText("⚠ 1 active")).toBeDefined();
  });
});

describe("FindingsPanel urgent pulse gates on run conclusion (GH38 review round 3, F004+F006)", () => {
  function publishUrgent(status: "running" | "failed" | "won"): void {
    const findings = Array.from({ length: URGENT_HITS }, (_, i) =>
      live({ seq: i + 1, subjectType: "account", entity: `e${i}`, state: "hit" }),
    );
    useGameStore.setState({ snapshot: { ...emptySnapshot(), findings, status } });
  }

  it("keeps the static urgent border but drops the pulse class once the run has failed", () => {
    publishUrgent("failed");
    const { container } = render(<InspectorShell />);
    const panelClass = container.querySelector(".findings-panel")?.className ?? "";
    expect(panelClass).toMatch(/\burgent\b/);
    expect(panelClass).not.toMatch(/urgent-pulse/);
  });

  it("carries the pulse class while the run is running", () => {
    publishUrgent("running");
    const { container } = render(<InspectorShell />);
    expect(container.querySelector(".findings-panel")?.className).toMatch(/urgent-pulse/);
  });
});
