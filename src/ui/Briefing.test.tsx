import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import { kioskPinAttack } from "../sim/scenarios/kiosk-pin-attack/scenario";
import { Briefing } from "./Briefing";

describe("Briefing", () => {
  it("renders the scenario's briefing text", () => {
    render(<Briefing text={kioskPinAttack.briefing} />);
    expect(screen.getByText(kioskPinAttack.briefing)).toBeDefined();
  });

  it("hints one Alert per Attack", () => {
    render(<Briefing text={kioskPinAttack.briefing} />);
    expect(screen.getByText(/one Alert per Attack/)).toBeDefined();
  });

  it("states the 5-in-5-minutes Hunt plainly", () => {
    render(<Briefing text={kioskPinAttack.briefing} />);
    expect(screen.getByText(/five.*minutes|5.*minutes/i)).toBeDefined();
  });
});
