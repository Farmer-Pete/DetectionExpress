import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { referenceSource } from "../../game/engine-source";
import { useGameStore } from "../../game/store";
import { SidePanel } from "./SidePanel";

beforeEach(() => {
  useGameStore.setState({ runPending: false, error: null });
  useGameStore.getState().setAlgorithmSource(referenceSource);
});

function renderPanel(overrides: Partial<Parameters<typeof SidePanel>[0]> = {}) {
  const onSelectTab = overrides.onSelectTab ?? vi.fn();
  const onClose = overrides.onClose ?? vi.fn();
  const onApply = overrides.onApply ?? vi.fn();
  const tab = overrides.tab ?? "chaos";
  const utils = render(
    <SidePanel tab={tab} onSelectTab={onSelectTab} onClose={onClose} onApply={onApply} />,
  );
  return { ...utils, onSelectTab, onClose, onApply };
}

describe("SidePanel", () => {
  it("is a dialog, modal, with its own backdrop that has no .app-shell ancestor", () => {
    const { container } = renderPanel();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(container.querySelector(".app-shell")).toBeNull();
  });

  it("renders two tabs, chaos active when tab is chaos", () => {
    renderPanel({ tab: "chaos" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    const chaosTab = screen.getByRole("tab", { name: /chaos/i });
    const algorithmTab = screen.getByRole("tab", { name: /algorithm/i });
    expect(chaosTab.getAttribute("aria-selected")).toBe("true");
    expect(algorithmTab.getAttribute("aria-selected")).toBe("false");
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

  it("clicking the algorithm tab calls onSelectTab", () => {
    const { onSelectTab } = renderPanel({ tab: "chaos" });
    fireEvent.click(screen.getByRole("tab", { name: /algorithm/i }));
    expect(onSelectTab).toHaveBeenCalledWith("algorithm");
  });

  it("ArrowRight/ArrowLeft move between tabs and move DOM focus with them", () => {
    const onSelectTab = vi.fn();
    const onClose = vi.fn();
    const onApply = vi.fn();
    const { rerender } = render(
      <SidePanel tab="chaos" onSelectTab={onSelectTab} onClose={onClose} onApply={onApply} />,
    );
    const chaosTab = screen.getByRole("tab", { name: /chaos/i });
    chaosTab.focus();
    fireEvent.keyDown(chaosTab, { key: "ArrowRight" });
    expect(onSelectTab).toHaveBeenCalledWith("algorithm");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /algorithm/i }));

    // Simulate the controlling parent (use-side-panel.tsx) applying the reported tab.
    rerender(
      <SidePanel tab="algorithm" onSelectTab={onSelectTab} onClose={onClose} onApply={onApply} />,
    );
    const algorithmTab = screen.getByRole("tab", { name: /algorithm/i });
    fireEvent.keyDown(algorithmTab, { key: "ArrowLeft" });
    expect(onSelectTab).toHaveBeenCalledWith("chaos");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /chaos/i }));
  });

  it("renders the chaos ladder in the chaos tab", () => {
    renderPanel({ tab: "chaos" });
    expect(screen.getByRole("heading", { name: /chaos ladder/i })).toBeDefined();
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

    const { unmount } = render(
      <SidePanel
        tab="chaos"
        onSelectTab={() => {}}
        onClose={() => {}}
        onApply={() => {}}
        fallbackFocusRef={{ current: fallback }}
      />,
    );
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

    const { unmount } = render(
      <SidePanel
        tab="chaos"
        onSelectTab={() => {}}
        onClose={() => {}}
        onApply={() => {}}
        fallbackFocusRef={fallbackFocusRef}
      />,
    );
    trigger.remove(); // the trigger is gone before close, e.g. the intro path (next stage)
    unmount();
    expect(document.activeElement).toBe(fallback);
    fallback.remove();
  });
});
