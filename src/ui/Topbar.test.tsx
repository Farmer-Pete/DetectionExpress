/**
 * `Topbar` is the extracted header (GH109-PLAN.md): title, slice tag, the embedded
 * metro map's show/hide toggle, the two side-panel openers (GH118-PLAN.md), the "How
 * this works" reopen button, and Hire Me. It consumes `reopenRef`/`onReopen` from
 * `useIntroOverlay` and `onOpenChaos`/`onOpenAlgorithm` from `useSidePanel` rather
 * than owning either, so these tests stub all of it.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { hireMe } from "./content/narrative";
import { Topbar } from "./Topbar";

function renderTopbar(overrides: Partial<Parameters<typeof Topbar>[0]> = {}) {
  const props: Parameters<typeof Topbar>[0] = {
    mapShown: true,
    onToggleMap: vi.fn(),
    reopenRef: createRef<HTMLButtonElement>(),
    onReopen: vi.fn(),
    onOpenChaos: vi.fn(),
    onOpenAlgorithm: vi.fn(),
    chaosButtonRef: createRef<HTMLButtonElement>(),
    algorithmButtonRef: createRef<HTMLButtonElement>(),
    ...overrides,
  };
  return { ...render(<Topbar {...props} />), props };
}

describe("Topbar", () => {
  it("renders the title, slice tag, and Hire Me button", () => {
    renderTopbar();
    const heading = screen.getByRole("heading", { name: "Detection Express" });
    expect(heading.textContent).toBe("Detection Express");
    expect(screen.getByText("Observe the Engine, then cause chaos")).toBeDefined();
    expect(screen.getByRole("button", { name: hireMe.heading })).toBeDefined();
  });

  it("labels the map toggle for the hidden map and flips it once shown", () => {
    const { rerender, props } = renderTopbar({ mapShown: false });
    expect(screen.getByRole("button", { name: "Show metro view" })).toBeDefined();

    rerender(<Topbar {...props} mapShown={true} />);
    expect(screen.getByRole("button", { name: "Hide metro view" })).toBeDefined();
  });

  it("calls onToggleMap when the map toggle is clicked", () => {
    const onToggleMap = vi.fn();
    renderTopbar({ mapShown: false, onToggleMap });
    fireEvent.click(screen.getByRole("button", { name: "Show metro view" }));
    expect(onToggleMap).toHaveBeenCalledTimes(1);
  });

  it("wires the reopen button to reopenRef and calls onReopen when clicked", () => {
    const onReopen = vi.fn();
    const reopenRef = createRef<HTMLButtonElement>();
    renderTopbar({ onReopen, reopenRef });
    const reopen = screen.getByRole("button", { name: /how this works/i });
    expect(reopenRef.current).toBe(reopen);
    fireEvent.click(reopen);
    expect(onReopen).toHaveBeenCalledTimes(1);
  });

  it("shows the chaos ladder and algorithm openers, wired to their refs and callbacks", () => {
    const onOpenChaos = vi.fn();
    const onOpenAlgorithm = vi.fn();
    const chaosButtonRef = createRef<HTMLButtonElement>();
    const algorithmButtonRef = createRef<HTMLButtonElement>();
    renderTopbar({
      onOpenChaos,
      onOpenAlgorithm,
      chaosButtonRef,
      algorithmButtonRef,
    });

    const chaosButton = screen.getByRole("button", { name: "Chaos ladder" });
    const algorithmButton = screen.getByRole("button", { name: "Algorithm" });
    expect(chaosButtonRef.current).toBe(chaosButton);
    expect(algorithmButtonRef.current).toBe(algorithmButton);

    fireEvent.click(chaosButton);
    expect(onOpenChaos).toHaveBeenCalledTimes(1);
    fireEvent.click(algorithmButton);
    expect(onOpenAlgorithm).toHaveBeenCalledTimes(1);
  });
});
