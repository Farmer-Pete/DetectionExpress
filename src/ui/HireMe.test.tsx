import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { hireMe } from "./content/narrative";
import { HireMe } from "./HireMe";

// The confetti burst is injected as a spy (the component's `celebrate` prop), so the
// real canvas-confetti — a full-screen canvas paced by rAF — never runs under test.
describe("HireMe", () => {
  it("toggles the card open and closed", () => {
    render(<HireMe copy={hireMe} celebrate={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: hireMe.heading });

    expect(screen.queryByText(/25 years/)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText(/25 years/)).toBeDefined();
    fireEvent.click(toggle);
    expect(screen.queryByText(/25 years/)).toBeNull();
  });

  it("shows the pitch, a mailto link, and the LinkedIn link when open", () => {
    render(<HireMe copy={hireMe} celebrate={vi.fn()} />);
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
    render(<HireMe copy={hireMe} celebrate={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: hireMe.heading });
    const controls = toggle.getAttribute("aria-controls");
    expect(controls).not.toBeNull();
    fireEvent.click(toggle);
    expect(document.getElementById(controls ?? "")).not.toBeNull();
  });

  it("fires a confetti burst on open, not on close", () => {
    const celebrate = vi.fn();
    render(<HireMe copy={hireMe} celebrate={celebrate} />);
    const toggle = screen.getByRole("button", { name: hireMe.heading });

    fireEvent.click(toggle);
    expect(celebrate).toHaveBeenCalledTimes(1);

    // Closing does not re-fire it.
    fireEvent.click(toggle);
    expect(celebrate).toHaveBeenCalledTimes(1);
  });

  it("renders a dimming scrim only while open, and closes on clicking it", () => {
    render(<HireMe copy={hireMe} celebrate={vi.fn()} />);
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
    render(<HireMe copy={hireMe} celebrate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: hireMe.heading }));
    expect(screen.getByText(/25 years/)).toBeDefined();

    // Escape from anywhere on the page closes the open card.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByText(/25 years/)).toBeNull();
  });

  it("closes the open card on a click outside it", () => {
    render(<HireMe copy={hireMe} celebrate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: hireMe.heading }));
    expect(screen.getByText(/25 years/)).toBeDefined();

    // A click outside the card closes it; a click inside would not.
    fireEvent.click(document.body);
    expect(screen.queryByText(/25 years/)).toBeNull();
  });

  it("leaves the card open when Escape is already handled", () => {
    render(<HireMe copy={hireMe} celebrate={vi.fn()} />);
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
