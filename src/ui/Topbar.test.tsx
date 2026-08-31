/**
 * `Topbar` is the extracted header (GH109-PLAN.md): title, slice tag, the Metro/
 * Pipeline view toggle, the "How this works" reopen button, and Hire Me. It consumes
 * `reopenRef`/`onReopen` from `useIntroOverlay` rather than owning them, so these
 * tests stub both.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { hireMe } from "./content/narrative";
import { Topbar } from "./Topbar";

describe("Topbar", () => {
  it("renders the title, slice tag, and Hire Me button", () => {
    render(
      <Topbar
        view="pipeline"
        onToggleView={vi.fn()}
        reopenRef={createRef<HTMLButtonElement>()}
        onReopen={vi.fn()}
      />,
    );
    const heading = screen.getByRole("heading", { name: "Detection Express" });
    expect(heading.textContent).toBe("Detection Express");
    expect(screen.getByText("Observe the Engine, then cause chaos")).toBeDefined();
    expect(screen.getByRole("button", { name: hireMe.heading })).toBeDefined();
  });

  it("labels the view toggle for the pipeline view and flips it for metro", () => {
    const { rerender } = render(
      <Topbar
        view="pipeline"
        onToggleView={vi.fn()}
        reopenRef={createRef<HTMLButtonElement>()}
        onReopen={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Metro view" })).toBeDefined();

    rerender(
      <Topbar
        view="metro"
        onToggleView={vi.fn()}
        reopenRef={createRef<HTMLButtonElement>()}
        onReopen={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Pipeline view" })).toBeDefined();
  });

  it("calls onToggleView when the view toggle is clicked", () => {
    const onToggleView = vi.fn();
    render(
      <Topbar
        view="pipeline"
        onToggleView={onToggleView}
        reopenRef={createRef<HTMLButtonElement>()}
        onReopen={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Metro view" }));
    expect(onToggleView).toHaveBeenCalledTimes(1);
  });

  it("wires the reopen button to reopenRef and calls onReopen when clicked", () => {
    const onReopen = vi.fn();
    const reopenRef = createRef<HTMLButtonElement>();
    render(
      <Topbar view="pipeline" onToggleView={vi.fn()} reopenRef={reopenRef} onReopen={onReopen} />,
    );
    const reopen = screen.getByRole("button", { name: /how this works/i });
    expect(reopenRef.current).toBe(reopen);
    fireEvent.click(reopen);
    expect(onReopen).toHaveBeenCalledTimes(1);
  });
});
