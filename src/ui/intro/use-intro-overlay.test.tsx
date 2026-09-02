/**
 * `useIntroOverlay` owns the intro-overlay lifecycle App used to inline: the seen-flag
 * lazy init, the three dismiss actions, the post-close focus-return effect, and the
 * reopen control's ref/handler. Cause chaos and Edit the Engine no longer scroll
 * (GH118-PLAN.md): they report the requested side-panel tab through the injected
 * `onRequestPanel` callback instead, and this harness stubs it the way App will.
 */
import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { isValidElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { introCopy } from "../content/narrative";
import { hasSeenIntro, markIntroSeen } from "../onboarding-storage";
import type { SidePanelTab } from "../sidepanel/use-side-panel";
import { useIntroOverlay } from "./use-intro-overlay";

function Harness({ onRequestPanel }: { onRequestPanel?: (tab: SidePanelTab) => void } = {}) {
  const intro = useIntroOverlay({ onRequestPanel });
  return (
    <div>
      {intro.introOverlay}
      <button type="button" ref={intro.reopenRef} onClick={intro.onReopen}>
        How this works
      </button>
    </div>
  );
}

describe("useIntroOverlay", () => {
  let scrollTargets: string[];
  const originalScrollIntoView = Element.prototype.scrollIntoView;

  beforeEach(() => {
    localStorage.clear();
    scrollTargets = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrollTargets.push(this.id);
    };
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  it("shows the overlay when the intro is unseen", () => {
    render(<Harness />);
    expect(screen.getByRole("dialog", { name: introCopy.title })).toBeDefined();
  });

  it("hides the overlay when the intro was already seen", () => {
    markIntroSeen();
    render(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Observe closes the overlay, marks it seen, and returns focus to the reopen control", () => {
    render(<Harness />);
    const reopen = screen.getByRole("button", { name: "How this works" });
    fireEvent.click(screen.getByRole("button", { name: introCopy.observeLabel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hasSeenIntro()).toBe(true);
    expect(document.activeElement).toBe(reopen);
  });

  it("Cause chaos closes the overlay, marks it seen, and requests the chaos panel tab without scrolling", () => {
    const onRequestPanel = vi.fn();
    render(<Harness onRequestPanel={onRequestPanel} />);
    fireEvent.click(screen.getByRole("button", { name: introCopy.chaosLabel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hasSeenIntro()).toBe(true);
    expect(onRequestPanel).toHaveBeenCalledTimes(1);
    expect(onRequestPanel).toHaveBeenCalledWith("chaos");
    expect(scrollTargets).toEqual([]);
  });

  it("Edit engine closes the overlay, marks it seen, and requests the algorithm panel tab without scrolling", () => {
    const onRequestPanel = vi.fn();
    render(<Harness onRequestPanel={onRequestPanel} />);
    fireEvent.click(screen.getByRole("button", { name: introCopy.editLabel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hasSeenIntro()).toBe(true);
    expect(onRequestPanel).toHaveBeenCalledTimes(1);
    expect(onRequestPanel).toHaveBeenCalledWith("algorithm");
    expect(scrollTargets).toEqual([]);
  });

  it("reopen shows the overlay again without clearing the seen flag", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: introCopy.observeLabel }));
    expect(hasSeenIntro()).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "How this works" }));
    expect(screen.getByRole("dialog", { name: introCopy.title })).toBeDefined();
    expect(hasSeenIntro()).toBe(true);
  });

  it("keeps onObserve's identity stable across an unrelated rerender (F020)", () => {
    // Read the `onObserve` prop straight off the returned `introOverlay` element (a
    // plain object from JSX), rather than mounting it: comparing the element itself
    // would test the wrong thing, since JSX produces a fresh element every render
    // regardless of whether its props changed. `isValidElement` is a real type guard
    // (not an assertion), so this narrows `ReactNode` down to the props shape safely.
    const { result, rerender } = renderHook(() => useIntroOverlay());
    const overlay = result.current.introOverlay;
    if (!isValidElement<{ onObserve: () => void }>(overlay)) {
      throw new Error("expected introOverlay to render while the intro is unseen");
    }
    const first = overlay.props.onObserve;
    expect(first).toBeInstanceOf(Function);

    rerender();

    const overlayAfterRerender = result.current.introOverlay;
    if (!isValidElement<{ onObserve: () => void }>(overlayAfterRerender)) {
      throw new Error("expected introOverlay to still render after the rerender");
    }
    expect(overlayAfterRerender.props.onObserve).toBe(first);
  });
});
