import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { referenceSource } from "../../game/engine-source";
import { useGameStore } from "../../game/store";
import { emptySnapshot } from "../../sim/snapshot";
import { SidePanel } from "./SidePanel";

beforeEach(() => {
  useGameStore.setState({
    runPending: false,
    error: null,
    chaosLevel: 0,
    snapshot: emptySnapshot(),
  });
  useGameStore.getState().setAlgorithmSource(referenceSource);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderPanel(overrides: Partial<Parameters<typeof SidePanel>[0]> = {}) {
  const onSelectTab = overrides.onSelectTab ?? vi.fn();
  const onClose = overrides.onClose ?? vi.fn();
  const onApply = overrides.onApply ?? vi.fn();
  const onToggleMap = overrides.onToggleMap ?? vi.fn();
  const onStartTour = overrides.onStartTour ?? vi.fn();
  const onToggleShortcuts = overrides.onToggleShortcuts ?? vi.fn();
  const mapShown = overrides.mapShown ?? true;
  const shortcutsEnabled = overrides.shortcutsEnabled ?? true;
  const tab = overrides.tab ?? "chaos";
  const utils = render(
    <SidePanel
      mode={overrides.mode}
      tab={tab}
      onSelectTab={onSelectTab}
      onClose={onClose}
      onApply={onApply}
      mapShown={mapShown}
      onToggleMap={onToggleMap}
      onStartTour={onStartTour}
      shortcutsEnabled={shortcutsEnabled}
      onToggleShortcuts={onToggleShortcuts}
      fallbackFocusRef={overrides.fallbackFocusRef}
    />,
  );
  return {
    ...utils,
    onSelectTab,
    onClose,
    onApply,
    onToggleMap,
    onStartTour,
    onToggleShortcuts,
  };
}

describe("SidePanel", () => {
  it("is a dialog, modal, with its own backdrop that has no .app-shell ancestor", () => {
    const { container } = renderPanel();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(container.querySelector(".app-shell")).toBeNull();
  });

  it("renders three tabs, chaos active when tab is chaos", () => {
    renderPanel({ tab: "chaos" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    const chaosTab = screen.getByRole("tab", { name: /chaos/i });
    const algorithmTab = screen.getByRole("tab", { name: /algorithm/i });
    const optionsTab = screen.getByRole("tab", { name: /options/i });
    expect(chaosTab.getAttribute("aria-selected")).toBe("true");
    expect(algorithmTab.getAttribute("aria-selected")).toBe("false");
    expect(optionsTab.getAttribute("aria-selected")).toBe("false");
  });

  it("marks the algorithm tab selected when tab is algorithm", () => {
    renderPanel({ tab: "algorithm" });
    expect(screen.getByRole("tab", { name: /algorithm/i }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("tab", { name: /chaos/i }).getAttribute("aria-selected")).toBe("false");
  });

  it("each tab has an associated tabpanel", () => {
    renderPanel({ tab: "chaos" });
    const tab = screen.getByRole("tab", { name: /chaos/i });
    const panel = screen.getByRole("tabpanel");
    expect(tab.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
  });

  it("renders all three tabpanels, hides the inactive ones, so every tab's aria-controls resolves", () => {
    const { container } = renderPanel({ tab: "chaos" });
    const panels = container.querySelectorAll<HTMLElement>('[role="tabpanel"]');
    expect(panels).toHaveLength(3);
    const chaosPanel = document.getElementById("sidepanel-tabpanel-chaos");
    const algorithmPanel = document.getElementById("sidepanel-tabpanel-algorithm");
    const optionsPanel = document.getElementById("sidepanel-tabpanel-options");
    expect(chaosPanel?.hasAttribute("hidden")).toBe(false);
    expect(algorithmPanel?.hasAttribute("hidden")).toBe(true);
    expect(optionsPanel?.hasAttribute("hidden")).toBe(true);
    for (const tab of screen.getAllByRole("tab")) {
      const controls = tab.getAttribute("aria-controls");
      expect(controls).not.toBeNull();
      expect(document.getElementById(controls ?? "")).not.toBeNull();
    }
  });

  it("opening on the algorithm tab moves focus to the algorithm tab, not the inactive chaos tab", () => {
    // The focus-trap fix: the inactive chaos tab carries tabIndex=-1 and must be skipped,
    // so open-focus lands on the selected algorithm tab, the first real focusable control.
    renderPanel({ tab: "algorithm" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /algorithm/i }));
  });

  it("clicking the algorithm tab calls onSelectTab", () => {
    const { onSelectTab } = renderPanel({ tab: "chaos" });
    fireEvent.click(screen.getByRole("tab", { name: /algorithm/i }));
    expect(onSelectTab).toHaveBeenCalledWith("algorithm");
  });

  it("ArrowRight/ArrowLeft move between all three tabs and move DOM focus with them", () => {
    const onSelectTab = vi.fn();
    const onClose = vi.fn();
    const onApply = vi.fn();
    const onToggleMap = vi.fn();
    const onStartTour = vi.fn();
    const onToggleShortcuts = vi.fn();
    const baseProps = {
      onSelectTab,
      onClose,
      onApply,
      mapShown: true,
      onToggleMap,
      onStartTour,
      shortcutsEnabled: true,
      onToggleShortcuts,
    };
    const { rerender } = render(<SidePanel tab="chaos" {...baseProps} />);
    const chaosTab = screen.getByRole("tab", { name: /chaos/i });
    chaosTab.focus();
    fireEvent.keyDown(chaosTab, { key: "ArrowRight" });
    expect(onSelectTab).toHaveBeenCalledWith("algorithm");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /algorithm/i }));

    // Simulate the controlling parent (use-side-panel.tsx) applying the reported tab.
    rerender(<SidePanel tab="algorithm" {...baseProps} />);
    const algorithmTab = screen.getByRole("tab", { name: /algorithm/i });
    fireEvent.keyDown(algorithmTab, { key: "ArrowRight" });
    expect(onSelectTab).toHaveBeenCalledWith("options");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /options/i }));

    // ArrowRight from the last tab wraps around to the first.
    rerender(<SidePanel tab="options" {...baseProps} />);
    const optionsTab = screen.getByRole("tab", { name: /options/i });
    fireEvent.keyDown(optionsTab, { key: "ArrowRight" });
    expect(onSelectTab).toHaveBeenCalledWith("chaos");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /chaos/i }));

    // ArrowLeft from the first tab wraps around to the last.
    rerender(<SidePanel tab="chaos" {...baseProps} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: /chaos/i }), { key: "ArrowLeft" });
    expect(onSelectTab).toHaveBeenCalledWith("options");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /options/i }));
  });

  it("renders the chaos ladder in the chaos tab", () => {
    renderPanel({ tab: "chaos" });
    expect(screen.getByRole("heading", { name: /chaos ladder/i })).toBeDefined();
  });

  it("wires the chaos ladder to the store: indicates the selected level and calling onSelectLevel writes it back", () => {
    useGameStore.setState({ chaosLevel: 1 });
    // Do not call through: this test only asserts the callback fires. Letting the real
    // action run would mutate the shared store mid-test and leak into the next one.
    const setChaosLevel = vi
      .spyOn(useGameStore.getState(), "setChaosLevel")
      .mockImplementation(() => {});
    renderPanel({ tab: "chaos" });

    const level1Radio = screen.getByRole("radio", { name: /level 1/i });
    expect(level1Radio).toHaveProperty("checked", true);

    fireEvent.click(screen.getByRole("radio", { name: /level 0/i }));
    expect(setChaosLevel).toHaveBeenCalledWith(0);
  });

  it("shows the chaos ladder's wave-phase indicator from the snapshot's chaosPhase", () => {
    useGameStore.setState({
      chaosLevel: 1,
      snapshot: {
        ...emptySnapshot(),
        chaosPhase: { kind: "wave", selectedLevel: 1, activeLevel: 1 },
      },
    });
    renderPanel({ tab: "chaos" });
    expect(screen.getByText(/wave active/i)).toBeDefined();
  });

  it("renders the algorithm editor in the algorithm tab, with no download button", () => {
    renderPanel({ tab: "algorithm" });
    expect(screen.getByRole("textbox", { name: /algorithm source/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
  });

  it("wires Apply in the algorithm tab to onApply", () => {
    const { onApply } = renderPanel({ tab: "algorithm" });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("the options tab shows a map toggle labeled Hide when mapShown is true, and calls onToggleMap", () => {
    const { onToggleMap } = renderPanel({ tab: "options", mapShown: true });
    const toggle = screen.getByRole("button", { name: "Hide metro view" });
    expect(screen.queryByRole("button", { name: "Show metro view" })).toBeNull();
    fireEvent.click(toggle);
    expect(onToggleMap).toHaveBeenCalledTimes(1);
  });

  it("the options tab's map toggle reads Show when mapShown is false", () => {
    renderPanel({ tab: "options", mapShown: false });
    expect(screen.getByRole("button", { name: "Show metro view" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Hide metro view" })).toBeNull();
  });

  it("the options tab's Retake tour button calls onStartTour", () => {
    const { onStartTour } = renderPanel({ tab: "options" });
    fireEvent.click(screen.getByRole("button", { name: "Retake tour" }));
    expect(onStartTour).toHaveBeenCalledTimes(1);
  });

  // GH137-PLAN.md code review fix 4: WCAG 2.1.4's "turn off" mechanism, surfaced as a
  // real, labeled, keyboard-operable checkbox — not a button (a toggle needs
  // checked-state semantics a plain button doesn't carry), and deliberately wired
  // through NO `useShortcut` call: giving the shortcuts on/off control its own
  // mnemonic would be circular (turning shortcuts off would disable the very control
  // that turns them back on).
  describe("the options tab's Keyboard shortcuts toggle", () => {
    it("is a real checkbox, labeled, reflecting shortcutsEnabled", () => {
      renderPanel({ tab: "options", shortcutsEnabled: true });
      const toggle = screen.getByRole("checkbox", { name: "Keyboard shortcuts" });
      expect(toggle).toHaveProperty("checked", true);
    });

    it("reflects shortcutsEnabled: false as unchecked", () => {
      renderPanel({ tab: "options", shortcutsEnabled: false });
      expect(screen.getByRole("checkbox", { name: "Keyboard shortcuts" })).toHaveProperty(
        "checked",
        false,
      );
    });

    it("clicking it calls onToggleShortcuts", () => {
      const { onToggleShortcuts } = renderPanel({ tab: "options", shortcutsEnabled: true });
      fireEvent.click(screen.getByRole("checkbox", { name: "Keyboard shortcuts" }));
      expect(onToggleShortcuts).toHaveBeenCalledTimes(1);
    });

    it("is keyboard-operable: Space toggles a focused checkbox via its native activation", () => {
      const { onToggleShortcuts } = renderPanel({ tab: "options", shortcutsEnabled: true });
      const toggle = screen.getByRole("checkbox", { name: "Keyboard shortcuts" });
      toggle.focus();
      // happy-dom's native checkbox activation fires a real click on Space, exactly
      // like a browser; the control needs no keydown handler of its own.
      fireEvent.click(toggle);
      expect(onToggleShortcuts).toHaveBeenCalledTimes(1);
    });

    it("carries no aria-keyshortcuts and no Kbd badge of its own (no mnemonic, avoiding circularity)", () => {
      renderPanel({ tab: "options", shortcutsEnabled: true });
      const toggle = screen.getByRole("checkbox", { name: "Keyboard shortcuts" });
      expect(toggle.hasAttribute("aria-keyshortcuts")).toBe(false);
      expect(toggle.closest("label")?.querySelector(".kbd")).toBeNull();
    });
  });

  it("Escape calls onClose", () => {
    const { onClose } = renderPanel();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the close button calls onClose", () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a backdrop click calls onClose", () => {
    const { onClose, container } = renderPanel();
    const backdrop = container.querySelector(".sidepanel-backdrop");
    expect(backdrop).not.toBeNull();
    if (backdrop) {
      fireEvent.click(backdrop);
    }
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog on mount and restores it to the trigger on unmount", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "open";
    document.body.append(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = renderPanel();
    expect(document.activeElement).not.toBe(trigger);
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("falls back to fallbackFocusRef when document.body, not a real element, holds focus on mount (the intro path)", () => {
    // The intro path (App.tsx): the intro's own button is already gone from the
    // document by the time this component mounts, so nothing holds focus and it has
    // already settled on document.body on its own.
    const fallback = document.createElement("div");
    fallback.tabIndex = -1;
    document.body.append(fallback);
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    expect(document.activeElement).toBe(document.body);

    const { unmount } = renderPanel({ fallbackFocusRef: { current: fallback } });
    unmount();
    expect(document.activeElement).toBe(fallback);
    fallback.remove();
  });

  it("falls back to fallbackFocusRef when the trigger is gone on unmount", () => {
    const fallback = document.createElement("div");
    fallback.tabIndex = -1;
    document.body.append(fallback);
    const fallbackFocusRef = { current: fallback };

    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    const { unmount } = renderPanel({ fallbackFocusRef });
    trigger.remove(); // the trigger is gone before close, e.g. the intro path (next stage)
    unmount();
    expect(document.activeElement).toBe(fallback);
    fallback.remove();
  });

  it("renders the chaos tabpanel content with the data-tour anchor the tour's step 2 targets", () => {
    renderPanel({ tab: "chaos" });
    expect(document.querySelector('[data-tour="chaos"]')).not.toBeNull();
  });
});

// GH137-PLAN.md M2: badge/aria-keyshortcuts data for the composite sidepanel:* scopes.
// Actual keyboard dispatch through a real ShortcutsProvider is covered at the App
// level (App.test.tsx), mirroring how Topbar.test.tsx only checks the M1 badge data.
describe("SidePanel keyboard shortcut badges (GH137-PLAN.md M2)", () => {
  it("shows an Esc badge on Close, aria-keyshortcuts set to the canonical Escape token, accessible name unchanged", () => {
    renderPanel({ tab: "chaos" });
    const close = screen.getByRole("button", { name: "Close panel" });
    expect(close.getAttribute("aria-keyshortcuts")).toBe("Escape");
    expect(close.querySelector(".kbd")?.textContent).toBe("Esc");
  });

  it("shows the same Escape aria-keyshortcuts on Close regardless of which tab is active", () => {
    renderPanel({ tab: "options" });
    const close = screen.getByRole("button", { name: "Close panel" });
    expect(close.getAttribute("aria-keyshortcuts")).toBe("Escape");
  });

  it("shows a T badge on Retake tour and a P badge on the map toggle, on the options tab", () => {
    renderPanel({ tab: "options" });
    const retake = screen.getByRole("button", { name: "Retake tour" });
    expect(retake.getAttribute("aria-keyshortcuts")).toBe("T");
    expect(retake.querySelector(".kbd")?.textContent).toBe("T");

    const mapToggle = screen.getByRole("button", { name: "Hide metro view" });
    expect(mapToggle.getAttribute("aria-keyshortcuts")).toBe("P");
    expect(mapToggle.querySelector(".kbd")?.textContent).toBe("P");
  });
});

// Code review finding (MAJOR): the plan lists the tab strip's ←/→ move as a badge-only
// entry (no dispatch: the roving-tabindex handler already owns the arrows), but the
// tabs had no visible badge and no aria-keyshortcuts to say so. One hint on the
// tablist itself (not per-tab, to avoid repeating it three times) plus
// aria-keyshortcuts="ArrowLeft ArrowRight" on each tab.
describe("SidePanel tab strip's arrow-key hint (GH137 review)", () => {
  it("shows one ←/→ badge hint on the tablist, aria-hidden, not per-tab", () => {
    renderPanel({ tab: "chaos" });
    const tablist = screen.getByRole("tablist", { name: /side panel tabs/i });
    const badges = tablist.querySelectorAll(".kbd");
    // Exactly two badges (← and →), not one per tab (which would be six for three tabs).
    expect(badges).toHaveLength(2);
    for (const badge of badges) {
      expect(badge.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it('sets aria-keyshortcuts="ArrowLeft ArrowRight" on every tab', () => {
    renderPanel({ tab: "chaos" });
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.getAttribute("aria-keyshortcuts")).toBe("ArrowLeft ArrowRight");
    }
  });

  it("never registers the arrows with the mnemonic dispatcher (RESERVED, badge-only) — roving nav still moves focus and reports the tab", () => {
    const onSelectTab = vi.fn();
    const onClose = vi.fn();
    const onApply = vi.fn();
    const onToggleMap = vi.fn();
    const onStartTour = vi.fn();
    const onToggleShortcuts = vi.fn();
    render(
      <SidePanel
        tab="chaos"
        onSelectTab={onSelectTab}
        onClose={onClose}
        onApply={onApply}
        mapShown={true}
        onToggleMap={onToggleMap}
        onStartTour={onStartTour}
        shortcutsEnabled={true}
        onToggleShortcuts={onToggleShortcuts}
      />,
    );
    const chaosTab = screen.getByRole("tab", { name: /chaos/i });
    chaosTab.focus();

    fireEvent.keyDown(chaosTab, { key: "ArrowRight" });

    expect(onSelectTab).toHaveBeenCalledWith("algorithm");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /algorithm/i }));
  });
});

// GH132-PLAN.md M2, "Tour redesign: 8 steps, drawer-open step 2" — "Step 2 drawer-open:
// Codex fixes (accepted)" rule 3. `mode="tour"` is how `use-tour.ts`'s `openForTour`
// renders this component mid-tour: open, but non-modal, with driver.js (not this
// component) owning focus and Escape.
describe("SidePanel in tour mode", () => {
  it("renders a labelled non-modal region, not a dialog: no role=dialog, no aria-modal", () => {
    renderPanel({ mode: "tour", tab: "chaos" });
    expect(screen.queryByRole("dialog")).toBeNull();
    const region = screen.getByRole("region", { name: "Side panel" });
    expect(region.hasAttribute("aria-modal")).toBe(false);
  });

  it("still exposes the chaos data-tour anchor, so the driver can spotlight it", () => {
    renderPanel({ mode: "tour", tab: "chaos" });
    expect(document.querySelector('[data-tour="chaos"]')).not.toBeNull();
  });

  it("semantically disables the tabs and the close button", () => {
    renderPanel({ mode: "tour", tab: "chaos" });
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab).toHaveProperty("disabled", true);
    }
    expect(screen.getByRole("button", { name: /close/i })).toHaveProperty("disabled", true);
  });

  it("clicking a disabled tab never calls onSelectTab", () => {
    const { onSelectTab } = renderPanel({ mode: "tour", tab: "chaos" });
    fireEvent.click(screen.getByRole("tab", { name: /algorithm/i }));
    expect(onSelectTab).not.toHaveBeenCalled();
  });

  it("clicking the disabled close button never calls onClose", () => {
    const { onClose } = renderPanel({ mode: "tour", tab: "chaos" });
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("semantically disables every chaos level, so the narrated ladder can't be clicked through", () => {
    const setChaosLevel = vi.spyOn(useGameStore.getState(), "setChaosLevel");
    renderPanel({ mode: "tour", tab: "chaos" });
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toHaveProperty("disabled", true);
    }
    fireEvent.click(screen.getByRole("radio", { name: /level 0/i }));
    expect(setChaosLevel).not.toHaveBeenCalled();
  });

  it("does not move focus into the panel on mount", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "open";
    document.body.append(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    renderPanel({ mode: "tour", tab: "chaos" });
    // driver.js, not this component, owns focus while the tour drives the panel.
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("does not restore focus on unmount (driver.js's own focus-restore runs instead)", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "open";
    document.body.append(trigger);
    trigger.focus();

    const other = document.createElement("button");
    document.body.append(other);

    const { unmount } = renderPanel({ mode: "tour", tab: "chaos" });
    other.focus(); // simulate driver.js moving focus onto its own popover control
    unmount();
    expect(document.activeElement).toBe(other);

    trigger.remove();
    other.remove();
  });

  it("Escape does not call onClose", () => {
    const { onClose } = renderPanel({ mode: "tour", tab: "chaos" });
    fireEvent.keyDown(screen.getByRole("region", { name: "Side panel" }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a backdrop click does not call onClose", () => {
    const { onClose, container } = renderPanel({ mode: "tour", tab: "chaos" });
    const backdrop = container.querySelector(".sidepanel-backdrop");
    expect(backdrop).not.toBeNull();
    if (backdrop) {
      fireEvent.click(backdrop);
    }
    expect(onClose).not.toHaveBeenCalled();
  });
});
