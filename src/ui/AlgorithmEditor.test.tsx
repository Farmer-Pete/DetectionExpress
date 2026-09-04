import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { referenceSource } from "../game/engine-source";
import { useGameStore } from "../game/store";
import { AlgorithmEditor } from "./AlgorithmEditor";

beforeEach(() => {
  useGameStore.setState({ runPending: false });
  useGameStore.getState().setAlgorithmSource(referenceSource);
});

describe("AlgorithmEditor", () => {
  it("starts on the naive default source", () => {
    expect(useGameStore.getState().source).toBe(referenceSource);
  });

  it("is editable, with Apply and Reset buttons always shown", () => {
    render(<AlgorithmEditor onRun={() => {}} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea.hasAttribute("readonly")).toBe(false);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDefined();
    expect(screen.getByRole("button", { name: /reset to default/i })).toBeDefined();
  });

  it("resets the source to the reference default when Reset to default is clicked", () => {
    useGameStore.getState().setAlgorithmSource("// a broken edit");
    render(<AlgorithmEditor onRun={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /reset to default/i }));
    expect(useGameStore.getState().source).toBe(referenceSource);
  });

  it("runs the current source when Apply is clicked", () => {
    let ran = 0;
    render(<AlgorithmEditor onRun={() => (ran += 1)} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(ran).toBe(1);
  });

  it("disables Apply and reads Checking... while a run is pending", () => {
    useGameStore.setState({ runPending: true });
    render(<AlgorithmEditor onRun={() => {}} />);
    const apply = screen.getByRole("button", { name: "Checking..." });
    expect(apply).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("enables Apply and reads Apply when no run is pending", () => {
    render(<AlgorithmEditor onRun={() => {}} />);
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toHaveProperty("disabled", false);
  });

  it("shows the error line bound to the store error", () => {
    useGameStore.setState({ error: { phase: "load", message: "bad syntax" } });
    render(<AlgorithmEditor onRun={() => {}} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("load");
    expect(alert.textContent).toContain("bad syntax");
    useGameStore.setState({ error: null });
  });

  it("has no download button", () => {
    render(<AlgorithmEditor onRun={() => {}} />);
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
  });
});

// GH137-PLAN.md M2: Reset ("R") and Apply ("A") carry the sidepanel:algorithm scope's
// badges. Actual keyboard dispatch (through a real ShortcutsProvider + SidePanel's own
// scope) is covered at the App level; these check the badge/aria-keyshortcuts data and
// that neither control's accessible name changes.
describe("AlgorithmEditor keyboard shortcut badges (GH137-PLAN.md M2)", () => {
  it("shows an R badge on Reset and an A badge on Apply, aria-keyshortcuts set, names unchanged", () => {
    render(<AlgorithmEditor onRun={() => {}} />);
    const reset = screen.getByRole("button", { name: /reset to default/i });
    expect(reset.getAttribute("aria-keyshortcuts")).toBe("R");
    expect(reset.querySelector(".kbd")?.textContent).toBe("R");

    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply.getAttribute("aria-keyshortcuts")).toBe("A");
    expect(apply.querySelector(".kbd")?.textContent).toBe("A");
  });

  // Code review MINOR fix: the badge used to be hidden while runPending, which hid the
  // discovery hint exactly when a player might wonder whether "A" still does anything.
  // The badge is a static hint about the control's assigned key, not a live "it will
  // fire right now" indicator (compare Reset's own badge, shown even though nothing
  // stops a player from pressing it) — `enabled={active && !runPending}` on the
  // `useShortcut` call is what actually keeps the dispatcher from firing while pending.
  it("still shows the A badge while Checking... (Apply disabled, badge stays for discovery)", () => {
    useGameStore.setState({ runPending: true });
    render(<AlgorithmEditor onRun={() => {}} />);
    const apply = screen.getByRole("button", { name: "Checking..." });
    expect(apply.getAttribute("aria-keyshortcuts")).toBe("A");
    expect(apply.querySelector(".kbd")?.textContent).toBe("A");
  });
});
