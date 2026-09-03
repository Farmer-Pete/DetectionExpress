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
  const onReopenIntro = overrides.onReopenIntro ?? vi.fn();
  const mapShown = overrides.mapShown ?? true;
  const tab = overrides.tab ?? "chaos";
  const utils = render(
    <SidePanel
      tab={tab}
      onSelectTab={onSelectTab}
      onClose={onClose}
      onApply={onApply}
      mapShown={mapShown}
      onToggleMap={onToggleMap}
      onReopenIntro={onReopenIntro}
      fallbackFocusRef={overrides.fallbackFocusRef}
    />,
  );
  return { ...utils, onSelectTab, onClose, onApply, onToggleMap, onReopenIntro };
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
    const onReopenIntro = vi.fn();
    const baseProps = {
      onSelectTab,
      onClose,
      onApply,
      mapShown: true,
      onToggleMap,
      onReopenIntro,
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
    const setChaosLevel = vi.spyOn(useGameStore.getState(), "setChaosLevel");
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

  it("the options tab's How this works button calls onReopenIntro", () => {
    const { onReopenIntro } = renderPanel({ tab: "options" });
    fireEvent.click(screen.getByRole("button", { name: "How this works" }));
    expect(onReopenIntro).toHaveBeenCalledTimes(1);
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
});
