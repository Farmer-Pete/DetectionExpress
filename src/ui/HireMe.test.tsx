import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { hireMe } from "./content/narrative";
import { HireMe } from "./HireMe";

describe("HireMe", () => {
  it("toggles the card open and closed", () => {
    render(<HireMe copy={hireMe} />);
    const toggle = screen.getByRole("button", { name: hireMe.heading });

    expect(screen.queryByText(/25 years/)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText(/25 years/)).toBeDefined();
    fireEvent.click(toggle);
    expect(screen.queryByText(/25 years/)).toBeNull();
  });

  it("shows the pitch and a mailto link when open", () => {
    render(<HireMe copy={hireMe} />);
    fireEvent.click(screen.getByRole("button", { name: hireMe.heading }));

    expect(screen.getByText(/open to work/)).toBeDefined();
    const link = screen.getByRole("link", { name: hireMe.email });
    expect(link.getAttribute("href")).toBe(`mailto:${hireMe.email}`);
  });
});
