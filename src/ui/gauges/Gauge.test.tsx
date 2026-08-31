import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Gauge } from "./Gauge";

describe("Gauge pulse", () => {
  it("adds the pulse class to the fill when pulse is true", () => {
    render(<Gauge label="Queue" value={10} max={20} unit="" fill="var(--threat)" pulse />);
    expect(screen.getByTestId("gauge-fill").className).toMatch(/gauge-fill-pulse/);
  });

  it("omits the pulse class when pulse is false or absent", () => {
    const { rerender } = render(
      <Gauge label="Queue" value={10} max={20} unit="" fill="var(--ok)" />,
    );
    expect(screen.getByTestId("gauge-fill").className).not.toMatch(/gauge-fill-pulse/);
    rerender(<Gauge label="Queue" value={10} max={20} unit="" fill="var(--ok)" pulse={false} />);
    expect(screen.getByTestId("gauge-fill").className).not.toMatch(/gauge-fill-pulse/);
  });
});
