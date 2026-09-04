import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Kbd } from "./Kbd";

describe("Kbd", () => {
  it("renders a <kbd> carrying the glyph for the given key", () => {
    render(<Kbd shortcutKey="M" />);
    const badge = screen.getByText("M");
    expect(badge.tagName).toBe("KBD");
  });

  it("renders the Space glyph for the literal space key", () => {
    render(<Kbd shortcutKey=" " />);
    expect(screen.getByText("Space").tagName).toBe("KBD");
  });

  it("renders the Esc glyph for Escape", () => {
    render(<Kbd shortcutKey="Escape" />);
    expect(screen.getByText("Esc")).toBeDefined();
  });

  it("is aria-hidden, so it never enters the accessible name/description tree", () => {
    render(<Kbd shortcutKey="F" />);
    expect(screen.getByText("F").getAttribute("aria-hidden")).toBe("true");
  });

  it("carries the .kbd class", () => {
    render(<Kbd shortcutKey="F" />);
    expect(screen.getByText("F").className).toBe("kbd");
  });
});
