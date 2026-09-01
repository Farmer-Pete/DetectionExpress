import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { defaultEntry } from "../game/registry";
import { Briefing } from "./Briefing";
import { liveScenarioFrom } from "./content/narrative";

const liveScenario = liveScenarioFrom(defaultEntry);
// Display text comes from the catalogue join (GH42-PLAN.md "Registry and
// catalogue metadata"): one source, not a drifting sim-side copy.
const briefingText = defaultEntry.catalogue.security.briefing;

function renderBriefing() {
  render(<Briefing tagline={liveScenario.tagline} text={briefingText} />);
}

describe("Briefing", () => {
  it("renders the scenario's briefing text", () => {
    renderBriefing();
    expect(screen.getByText(briefingText)).toBeDefined();
  });

  it("shows the tagline above the briefing", () => {
    renderBriefing();
    const tagline = screen.getByText(liveScenario.tagline);
    const briefing = screen.getByText(briefingText);
    // The briefing follows the tagline in the DOM, so the tagline sits above it.
    const position = tagline.compareDocumentPosition(briefing);
    expect(Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("describes the burst raising one Alert, in the new voice", () => {
    renderBriefing();
    expect(screen.getByText(/one Alert for the whole burst/)).toBeDefined();
  });

  it("states the 5-in-5-minutes pattern plainly", () => {
    renderBriefing();
    expect(screen.getByText(/five[\s-]minutes?|5[\s-]minutes?/i)).toBeDefined();
  });
});
