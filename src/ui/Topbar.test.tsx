/**
 * `Topbar` is the extracted header (GH109-PLAN.md): title, slice tag, the run-status
 * pill, the embedded metro map's show/hide toggle, the three side-panel openers
 * (GH118-PLAN.md, GH124-PLAN.md Checkpoint 2), the "How this works" reopen button,
 * and Hire Me. It consumes `reopenRef`/`onReopen` from `useIntroOverlay` and
 * `onOpenChaos`/`onOpenAlgorithm`/`onOpenMetrics` from `useSidePanel` rather than
 * owning either, so these tests stub all of it. `StatusPill` reads the game store
 * itself (like `Hud` used to), so these tests seed the store rather than a prop.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGameStore } from "../game/store";
import { emptySnapshot } from "../sim/snapshot";
import { hireMe } from "./content/narrative";
import { Topbar } from "./Topbar";

beforeEach(() => {
  useGameStore.setState({ snapshot: emptySnapshot() });
});

function renderTopbar(overrides: Partial<Parameters<typeof Topbar>[0]> = {}) {
  const props: Parameters<typeof Topbar>[0] = {
    mapShown: true,
    onToggleMap: vi.fn(),
    reopenRef: createRef<HTMLButtonElement>(),
    onReopen: vi.fn(),
    onOpenChaos: vi.fn(),
    onOpenAlgorithm: vi.fn(),
    onOpenMetrics: vi.fn(),
    chaosButtonRef: createRef<HTMLButtonElement>(),
    algorithmButtonRef: createRef<HTMLButtonElement>(),
    metricsButtonRef: createRef<HTMLButtonElement>(),
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

  it("shows the chaos ladder, algorithm, and metrics openers, wired to their refs and callbacks", () => {
    const onOpenChaos = vi.fn();
    const onOpenAlgorithm = vi.fn();
    const onOpenMetrics = vi.fn();
    const chaosButtonRef = createRef<HTMLButtonElement>();
    const algorithmButtonRef = createRef<HTMLButtonElement>();
    const metricsButtonRef = createRef<HTMLButtonElement>();
    renderTopbar({
      onOpenChaos,
      onOpenAlgorithm,
      onOpenMetrics,
      chaosButtonRef,
      algorithmButtonRef,
      metricsButtonRef,
    });

    const chaosButton = screen.getByRole("button", { name: "Chaos ladder" });
    const algorithmButton = screen.getByRole("button", { name: "Algorithm" });
    const metricsButton = screen.getByRole("button", { name: "Metrics" });
    expect(chaosButtonRef.current).toBe(chaosButton);
    expect(algorithmButtonRef.current).toBe(algorithmButton);
    expect(metricsButtonRef.current).toBe(metricsButton);

    fireEvent.click(chaosButton);
    expect(onOpenChaos).toHaveBeenCalledTimes(1);
    fireEvent.click(algorithmButton);
    expect(onOpenAlgorithm).toHaveBeenCalledTimes(1);
    fireEvent.click(metricsButton);
    expect(onOpenMetrics).toHaveBeenCalledTimes(1);
  });

  it("renders the run-status pill, reading the store directly", () => {
    useGameStore.setState({
      snapshot: { ...emptySnapshot(), status: "won", failureReason: null },
    });
    renderTopbar();
    expect(screen.getByRole("status").textContent).toBe("Won");
  });
});
