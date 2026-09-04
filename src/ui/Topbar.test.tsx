/**
 * `Topbar` is the extracted header (GH109-PLAN.md): title, slice tag, the
 * hamburger button, and Hire Me. GH132-PLAN.md M1 (design revision): the
 * hamburger is a plain icon button that opens the side panel directly
 * (`onOpenMenu`) — it renders no popup of its own, so these tests only assert it
 * exists, is wired to the given ref, and fires `onOpenMenu` on click.
 *
 * GH132-PLAN.md M2 (8-step tour redesign): the run-status pill (`StatusPill`,
 * the "RUNNING" badge) is gone.
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
    onOpenMenu: vi.fn(),
    hamburgerTriggerRef: createRef<HTMLButtonElement>(),
    ...overrides,
  };
  return { ...render(<Topbar {...props} />), props };
}

describe("Topbar", () => {
  it("renders the title, slice tag, and Hire Me button", () => {
    renderTopbar();
    const heading = screen.getByRole("heading", { name: "Detection Express" });
    expect(heading.textContent).toBe("Detection Express");
    expect(
      screen.getByText("The Engine brings the detections. You bring the chaos."),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: hireMe.heading })).toBeDefined();
  });

  it("renders the hamburger button, wired to hamburgerTriggerRef, with no popup of its own", () => {
    const hamburgerTriggerRef = createRef<HTMLButtonElement>();
    renderTopbar({ hamburgerTriggerRef });
    const trigger = screen.getByRole("button", { name: /side panel/i });
    expect(hamburgerTriggerRef.current).toBe(trigger);
    expect(trigger.getAttribute("aria-haspopup")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("clicking the hamburger calls onOpenMenu", () => {
    const onOpenMenu = vi.fn();
    renderTopbar({ onOpenMenu });
    fireEvent.click(screen.getByRole("button", { name: /side panel/i }));
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
  });

  it("the hamburger is the last, rightmost child of the topbar actions row, after Hire Me", () => {
    const { container } = renderTopbar();
    const actions = container.querySelector(".topbar-actions");
    expect(actions).not.toBeNull();
    const children = actions ? [...actions.children] : [];
    expect(children.at(-1)).toBe(screen.getByRole("button", { name: /side panel/i }));
  });

  it("shows an M badge on the hamburger, with aria-keyshortcuts set and its accessible name unchanged (GH137-PLAN.md M1)", () => {
    renderTopbar();
    const trigger = screen.getByRole("button", { name: /side panel/i });
    expect(trigger.getAttribute("aria-label")).toBe("Open side panel");
    expect(trigger.getAttribute("aria-keyshortcuts")).toBe("M");
    expect(trigger.querySelector(".kbd")?.textContent).toBe("M");
  });

  it("no longer renders a standalone map toggle or How this works button", () => {
    renderTopbar();
    expect(screen.queryByRole("button", { name: /metro view/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /how this works/i })).toBeNull();
  });

  it("no longer renders a Metrics opener", () => {
    renderTopbar();
    expect(screen.queryByRole("button", { name: "Metrics" })).toBeNull();
  });

  it("renders no run-status pill (GH132-PLAN.md M2: the RUNNING badge is gone)", () => {
    renderTopbar();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
