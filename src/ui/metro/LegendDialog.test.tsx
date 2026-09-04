import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { LegendDialog } from "./LegendDialog";

/** A no-op fallback ref, for the tests that never exercise the fallback branch. */
function noFallback() {
  return createRef<HTMLElement>();
}

describe("LegendDialog", () => {
  it("renders as a labelled modal dialog holding the Lines/Actors/Sensors sections", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    render(
      <LegendDialog onClose={() => {}} triggerRef={triggerRef} fallbackFocusRef={noFallback()} />,
    );

    const dialog = screen.getByRole("dialog", { name: "Legend" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("Lines")).toBeDefined();
    expect(screen.getByText("Actors")).toBeDefined();
    expect(screen.getByText("Sensors")).toBeDefined();
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    const triggerRef = createRef<HTMLButtonElement>();
    render(
      <LegendDialog onClose={onClose} triggerRef={triggerRef} fallbackFocusRef={noFallback()} />,
    );

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Legend" }), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose from the close button", () => {
    const onClose = vi.fn();
    const triggerRef = createRef<HTMLButtonElement>();
    render(
      <LegendDialog onClose={onClose} triggerRef={triggerRef} fallbackFocusRef={noFallback()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps Tab within the dialog", () => {
    render(
      <LegendDialog onClose={() => {}} triggerRef={createRef()} fallbackFocusRef={noFallback()} />,
    );
    const dialog = screen.getByRole("dialog", { name: "Legend" });
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();

    // The close button is the dialog's only focusable control, so a Tab from it wraps
    // back to it — proving `trapTab` is wired into onKeyDown and keeps focus inside.
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
  });

  it("dismisses on an outside pointer gesture on the backdrop", () => {
    const onClose = vi.fn();
    render(
      <LegendDialog onClose={onClose} triggerRef={createRef()} fallbackFocusRef={noFallback()} />,
    );
    const backdrop = document.querySelector(".legend-dialog-backdrop");
    if (backdrop === null) {
      throw new Error("backdrop not found");
    }

    fireEvent.pointerDown(backdrop);
    fireEvent.pointerUp(backdrop);
    fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss on a click inside the dialog", () => {
    const onClose = vi.fn();
    render(
      <LegendDialog onClose={onClose} triggerRef={createRef()} fallbackFocusRef={noFallback()} />,
    );

    fireEvent.pointerDown(screen.getByText("Lines"));
    fireEvent.pointerUp(screen.getByText("Lines"));
    fireEvent.click(screen.getByText("Lines"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves focus into the dialog on mount and restores it to the trigger ref on unmount", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    const triggerRef = { current: trigger };

    const { unmount } = render(
      <LegendDialog onClose={() => {}} triggerRef={triggerRef} fallbackFocusRef={noFallback()} />,
    );
    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Legend" }));

    unmount();
    expect(document.activeElement).toBe(trigger);

    trigger.remove();
  });

  it("restores focus to the fallback ref when the trigger cannot take focus", () => {
    // A detached button stands in for the chip once it is `display: none` at desktop
    // width (the resize-to-desktop close, Codex round 3): focusing it is a no-op, so
    // the restore must fall back to a visible element instead of stranding focus.
    const trigger = document.createElement("button");
    const fallback = document.createElement("div");
    fallback.tabIndex = -1;
    document.body.append(fallback);

    const { unmount } = render(
      <LegendDialog
        onClose={() => {}}
        triggerRef={{ current: trigger }}
        fallbackFocusRef={{ current: fallback }}
      />,
    );

    unmount();
    expect(document.activeElement).toBe(fallback);

    fallback.remove();
  });
});
