import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { LegendDialog } from "./LegendDialog";

describe("LegendDialog", () => {
  it("renders as a labelled modal dialog holding the Lines/Actors/Sensors sections", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    render(<LegendDialog onClose={() => {}} triggerRef={triggerRef} />);

    const dialog = screen.getByRole("dialog", { name: "Legend" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("Lines")).toBeDefined();
    expect(screen.getByText("Actors")).toBeDefined();
    expect(screen.getByText("Sensors")).toBeDefined();
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    const triggerRef = createRef<HTMLButtonElement>();
    render(<LegendDialog onClose={onClose} triggerRef={triggerRef} />);

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Legend" }), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose from the close button", () => {
    const onClose = vi.fn();
    const triggerRef = createRef<HTMLButtonElement>();
    render(<LegendDialog onClose={onClose} triggerRef={triggerRef} />);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog on mount and restores it to the trigger ref on unmount", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    const triggerRef = { current: trigger };

    const { unmount } = render(<LegendDialog onClose={() => {}} triggerRef={triggerRef} />);
    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Legend" }));

    unmount();
    expect(document.activeElement).toBe(trigger);

    trigger.remove();
  });
});
