import { describe, expect, it } from "vitest";
import { kioskPinAttack } from "../../sim/scenarios/kiosk-pin-attack/scenario";
import { chaosLevels, hireMe, introCopy, liveScenario, REPO_URL } from "./narrative";

// Stale phrases from the old "you build the engine" voice. None may survive in the
// shipped prose. The live briefing string lives on the sim scenario, so it is checked
// here alongside the narrative copy.
const STALE_PHRASES = ["you write the rule", "you are hired", "write the Match Rule"];

function allProse(): string {
  return [
    introCopy.title,
    ...introCopy.paragraphs,
    introCopy.invitation,
    introCopy.observeLabel,
    introCopy.chaosLabel,
    introCopy.sourceLabel,
    introCopy.editLabel,
    hireMe.heading,
    ...hireMe.body,
    ...chaosLevels.map((level) => `${level.label} ${level.blurb}`),
    liveScenario.displayName,
    liveScenario.tagline,
    kioskPinAttack.briefing,
  ]
    .join(" ")
    .toLowerCase();
}

describe("narrative content", () => {
  it("holds exactly five chaos levels, sorted by level, with unique labels", () => {
    expect(chaosLevels).toHaveLength(5);
    const levels = chaosLevels.map((level) => level.level);
    expect(levels).toEqual([1, 2, 3, 4, 5]);
    const labels = new Set(chaosLevels.map((level) => level.label));
    expect(labels.size).toBe(5);
  });

  it("names the top level Nightmare and marks only Level 1 playable", () => {
    expect(chaosLevels[4]?.label).toBe("Nightmare");
    const playable = chaosLevels.filter((level) => level.playable);
    expect(playable).toHaveLength(1);
    expect(playable[0]?.level).toBe(1);
  });

  it("describes the one live scenario", () => {
    expect(liveScenario.id).toBe("kiosk-pin-attack");
    expect(liveScenario.displayName).toBe("PIN Brute Force");
    expect(liveScenario.level).toBe(1);
    expect(liveScenario.tagline.length).toBeGreaterThan(0);
  });

  it("carries Peter's contact and the source repo", () => {
    expect(hireMe.email).toBe("peter@naud.us");
    expect(REPO_URL).toBe("https://github.com/Farmer-Pete/DetectionExpress");
  });

  it("states the 25 years of experience in the Hire Me body", () => {
    expect(hireMe.body.join(" ")).toContain("25 years");
  });

  it("leaks no stale phrase from the old voice", () => {
    const prose = allProse();
    for (const phrase of STALE_PHRASES) {
      expect(prose).not.toContain(phrase.toLowerCase());
    }
  });
});
