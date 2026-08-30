import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { kioskPinAttack } from "../sim/scenarios/kiosk-pin-attack/scenario";
import { Briefing } from "./Briefing";
import { liveScenario } from "./content/narrative";

function renderBriefing() {
  render(<Briefing tagline={liveScenario.tagline} text={kioskPinAttack.briefing} />);
}

describe("Briefing", () => {
  it("renders the scenario's briefing text", () => {
    renderBriefing();
    expect(screen.getByText(kioskPinAttack.briefing)).toBeDefined();
  });

  it("shows the tagline above the briefing", () => {
    renderBriefing();
    expect(screen.getByText(liveScenario.tagline)).toBeDefined();
  });

  it("describes the burst raising one Alert, in the new voice", () => {
    renderBriefing();
    expect(screen.getByText(/one Alert for the whole burst/)).toBeDefined();
  });

  it("states the 5-in-5-minutes pattern plainly", () => {
    renderBriefing();
    expect(screen.getByText(/five.*minutes|5.*minutes/i)).toBeDefined();
  });
});
