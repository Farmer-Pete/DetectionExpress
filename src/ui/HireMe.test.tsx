import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ConfettiOrigin } from "./confetti";
import { hireMe } from "./content/narrative";
import { HireMe } from "./HireMe";
import { kbdGlyph } from "./shortcuts/shortcuts.data";
import type { ShortcutsAppState } from "./shortcuts/use-shortcuts";
import { ShortcutsProvider } from "./shortcuts/use-shortcuts";

const SHELL_STATE: ShortcutsAppState = {
  traceOpen: false,
  mapDialogKind: null,
  legendOpen: false,
  sidePanelOpen: false,
  sidePanelTab: "chaos",
  hireMeOpen: false,
};

/** GH137-PLAN.md M2: `HireMe` is now a controlled component (its `open` state was
 *  lifted into `App`). This wrapper owns `open` itself, mirroring `App.tsx`, so the
 *  behavior tests below exercise the same open/close flows through the new
 *  `open`/`onOpenChange` props instead of a retired internal `useState`. */
function ControlledHireMe({
  celebrate = vi.fn(),
}: {
  celebrate?: ((origin: ConfettiOrigin) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  return <HireMe copy={hireMe} open={open} onOpenChange={setOpen} celebrate={celebrate} />;
}

function renderHireMe(celebrate: (origin: ConfettiOrigin) => void = vi.fn()) {
  return render(<ControlledHireMe celebrate={celebrate} />);
}

describe("HireMe", () => {
  it("toggles the card open and closed", () => {
    renderHireMe();
    const toggle = screen.getByRole("button", { name: hireMe.heading });

    expect(screen.queryByText(/25 years/)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText(/25 years/)).toBeDefined();
    fireEvent.click(toggle);
    expect(screen.queryByText(/25 years/)).toBeNull();
  });

  it("shows the pitch, a mailto link, and the LinkedIn link when open", () => {
    renderHireMe();
    fireEvent.click(screen.getByRole("button", { name: hireMe.heading }));

    expect(screen.getByText(/love to chat/)).toBeDefined();

    const email = screen.getByRole("link", { name: hireMe.email });
    expect(email.getAttribute("href")).toBe(`mailto:${hireMe.email}`);

    const linkedin = screen.getByRole("link", { name: "LinkedIn" });
    expect(linkedin.getAttribute("href")).toBe(hireMe.linkedin);
    expect(linkedin.getAttribute("target")).toBe("_blank");
    expect(linkedin.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("points the toggle at the card it controls", () => {
    renderHireMe();
    const toggle = screen.getByRole("button", { name: hireMe.heading });
    const controls = toggle.getAttribute("aria-controls");
    expect(controls).not.toBeNull();
    fireEvent.click(toggle);
    expect(document.getElementById(controls ?? "")).not.toBeNull();
  });

  it("fires a confetti burst on open, not on close", () => {
    const celebrate = vi.fn();
    renderHireMe(celebrate);
    const toggle = screen.getByRole("button", { name: hireMe.heading });

    fireEvent.click(toggle);
    expect(celebrate).toHaveBeenCalledTimes(1);

    // Closing does not re-fire it.
    fireEvent.click(toggle);
    expect(celebrate).toHaveBeenCalledTimes(1);
  });

  it("renders a dimming scrim only while open, and closes on clicking it", () => {
    renderHireMe();
    const toggle = screen.getByRole("button", { name: hireMe.heading });

    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    fireEvent.click(toggle);

    const scrim = screen.getByRole("button", { name: "Dismiss" });
    expect(scrim).toBeDefined();
    fireEvent.click(scrim);
    expect(screen.queryByText(/25 years/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("closes the open card on Escape", () => {
    renderHireMe();
    fireEvent.click(screen.getByRole("button", { name: hireMe.heading }));
    expect(screen.getByText(/25 years/)).toBeDefined();

    // Escape from anywhere on the page closes the open card.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByText(/25 years/)).toBeNull();
  });

  it("closes the open card on a click outside it", () => {
    renderHireMe();
    fireEvent.click(screen.getByRole("button", { name: hireMe.heading }));
    expect(screen.getByText(/25 years/)).toBeDefined();

    // A click outside the card closes it; a click inside would not.
    fireEvent.click(document.body);
    expect(screen.queryByText(/25 years/)).toBeNull();
  });

  it("leaves the card open when Escape is already handled", () => {
    renderHireMe();
    fireEvent.click(screen.getByRole("button", { name: hireMe.heading }));
    expect(screen.getByText(/25 years/)).toBeDefined();

    // The intro overlay marks its own Escape handled. A handled Escape must not
    // also close this card.
    const handled = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
      bubbles: true,
    });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    expect(screen.getByText(/25 years/)).toBeDefined();
  });
});

// GH137-PLAN.md M2: the controlled conversion itself — `open`/`onOpenChange` drive the
// card with no internal state of HireMe's own.
describe("HireMe controlled conversion (GH137-PLAN.md M2)", () => {
  it("renders open when the open prop is true, with no state of its own", () => {
    render(<HireMe copy={hireMe} open={true} onOpenChange={vi.fn()} celebrate={vi.fn()} />);
    expect(screen.getByText(/25 years/)).toBeDefined();
  });

  it("renders closed when the open prop is false", () => {
    render(<HireMe copy={hireMe} open={false} onOpenChange={vi.fn()} celebrate={vi.fn()} />);
    expect(screen.queryByText(/25 years/)).toBeNull();
  });

  it("clicking the closed toggle calls onOpenChange(true) and fires confetti", () => {
    const onOpenChange = vi.fn();
    const celebrate = vi.fn();
    render(<HireMe copy={hireMe} open={false} onOpenChange={onOpenChange} celebrate={celebrate} />);
    fireEvent.click(screen.getByRole("button", { name: hireMe.heading }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(celebrate).toHaveBeenCalledTimes(1);
  });

  it("clicking the open toggle calls onOpenChange(false), without firing confetti again", () => {
    const onOpenChange = vi.fn();
    const celebrate = vi.fn();
    render(<HireMe copy={hireMe} open={true} onOpenChange={onOpenChange} celebrate={celebrate} />);
    fireEvent.click(screen.getByRole("button", { name: hireMe.heading }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(celebrate).not.toHaveBeenCalled();
  });

  it("Escape while open calls onOpenChange(false)", () => {
    const onOpenChange = vi.fn();
    render(<HireMe copy={hireMe} open={true} onOpenChange={onOpenChange} celebrate={vi.fn()} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a click outside while open calls onOpenChange(false)", () => {
    const onOpenChange = vi.fn();
    render(<HireMe copy={hireMe} open={true} onOpenChange={onOpenChange} celebrate={vi.fn()} />);
    fireEvent.click(document.body);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// GH137-PLAN.md M2: the shell-scope opener (H, card closed) and the hireMe-scope closer
// (H, card open), plus the badge-only Escape dismiss. Wired through a real
// ShortcutsProvider, mirroring how Topbar/LogPanel/FindingsPanel's M1 wiring tests are
// structured, since a bare render (no provider) only ever gets the no-op register.
describe("HireMe keyboard shortcuts (GH137-PLAN.md M2)", () => {
  function renderWithProvider(open: boolean, onOpenChange: (open: boolean) => void) {
    const appState: ShortcutsAppState = { ...SHELL_STATE, hireMeOpen: open };
    return render(
      <ShortcutsProvider appState={appState}>
        <HireMe copy={hireMe} open={open} onOpenChange={onOpenChange} celebrate={vi.fn()} />
      </ShortcutsProvider>,
    );
  }

  it("shows an H badge on the closed toggle, aria-keyshortcuts set, accessible name unchanged", () => {
    renderWithProvider(false, vi.fn());
    const toggle = screen.getByRole("button", { name: hireMe.heading });
    expect(toggle.getAttribute("aria-keyshortcuts")).toBe("H");
    expect(toggle.querySelector(".kbd")?.textContent).toBe("H");
  });

  it("pressing H while closed calls onOpenChange(true)", () => {
    const onOpenChange = vi.fn();
    renderWithProvider(false, onOpenChange);
    fireEvent.keyDown(document.body, { key: "h" });
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("shows an H badge on the open toggle too (the hireMe scope's own close entry)", () => {
    renderWithProvider(true, vi.fn());
    const toggle = screen.getByRole("button", { name: hireMe.heading });
    expect(toggle.getAttribute("aria-keyshortcuts")).toBe("H");
  });

  it("pressing H while open calls onOpenChange(false)", () => {
    const onOpenChange = vi.fn();
    renderWithProvider(true, onOpenChange);
    fireEvent.keyDown(document.body, { key: "h" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not fire the open scope's H while the card is already open (scope mismatch)", () => {
    // If the closed-scope "H" fired here too, onOpenChange would be called twice
    // (once true, once false) for a single keypress; assert exactly one call.
    const onOpenChange = vi.fn();
    renderWithProvider(true, onOpenChange);
    fireEvent.keyDown(document.body, { key: "h" });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it("shows an Esc badge on the Dismiss scrim, badge-only (no double dispatch alongside the component's own Escape listener)", () => {
    const onOpenChange = vi.fn();
    renderWithProvider(true, onOpenChange);
    const scrim = screen.getByRole("button", { name: "Dismiss" });
    expect(scrim.getAttribute("aria-keyshortcuts")).toBe(kbdGlyph("Escape"));
    expect(scrim.querySelector(".kbd")?.textContent).toBe("Esc");

    fireEvent.keyDown(document.body, { key: "Escape" });
    // The component's own Escape listener (not the dispatcher, which refuses a
    // RESERVED key) is what closes it — exactly once.
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
