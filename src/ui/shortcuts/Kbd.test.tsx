import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Kbd, ShortcutHint } from "./Kbd";

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

describe("ShortcutHint", () => {
  it("renders each entry's badge(s) and label, joined with a separator (the tour footer's own text)", () => {
    const { container } = render(
      <ShortcutHint
        entries={[
          { keys: ["ArrowLeft", "ArrowRight"], label: "move" },
          { keys: ["Escape"], label: "exit" },
        ]}
      />,
    );
    expect(container.textContent).toBe("← → move · Esc exit");
  });

  it("carries the .shortcut-hint class on its root", () => {
    const { container } = render(<ShortcutHint entries={[{ keys: ["M"], label: "menu" }]} />);
    expect(container.querySelector(".shortcut-hint")).not.toBeNull();
  });

  it("renders every key as an aria-hidden .kbd badge", () => {
    render(<ShortcutHint entries={[{ keys: ["ArrowLeft", "ArrowRight"], label: "move" }]} />);
    const badges = screen.getAllByText(/←|→/);
    expect(badges).toHaveLength(2);
    for (const badge of badges) {
      expect(badge.tagName).toBe("KBD");
      expect(badge.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("omits the separator before the first entry", () => {
    const { container } = render(<ShortcutHint entries={[{ keys: ["M"], label: "menu" }]} />);
    expect(container.querySelectorAll(".shortcut-hint-sep")).toHaveLength(0);
  });
});
