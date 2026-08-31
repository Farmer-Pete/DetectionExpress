/**
 * `LocalIdeToggle` is the presentational `.local-ide` control App used to inline,
 * dumb like `ModalHost`: no state, just the two-button branch on `localMode`.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LocalIdeToggle } from "./LocalIdeToggle";

describe("LocalIdeToggle", () => {
  it("renders nothing when not ready", () => {
    const { container } = render(
      <LocalIdeToggle ready={false} localMode={false} onEnter={vi.fn()} onStop={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders 'Edit in IDE' when ready and not in local mode, and clicking calls onEnter", () => {
    const onEnter = vi.fn();
    render(<LocalIdeToggle ready={true} localMode={false} onEnter={onEnter} onStop={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Edit in IDE" });
    fireEvent.click(button);
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it("renders 'Stop editing' in local mode, and clicking calls onStop", () => {
    const onStop = vi.fn();
    render(<LocalIdeToggle ready={true} localMode={true} onEnter={vi.fn()} onStop={onStop} />);
    const button = screen.getByRole("button", { name: "Stop editing" });
    fireEvent.click(button);
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
