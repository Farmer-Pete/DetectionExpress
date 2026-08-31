import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { defaultEntry } from "../game/registry";
import { ChaosLadder } from "./ChaosLadder";
import { chaosLevels, liveScenarioFrom } from "./content/narrative";

const liveScenario = liveScenarioFrom(defaultEntry);

function renderLadder() {
  const { container } = render(<ChaosLadder levels={chaosLevels} liveScenario={liveScenario} />);
  return container;
}

describe("ChaosLadder", () => {
  it("renders the five level labels in ladder order", () => {
    const container = renderLadder();
    const labels = [...container.querySelectorAll(".chaos-ladder-label")].map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(["First Cracks", "Under Load", "Heavy Load", "Overload", "Nightmare"]);
  });

  it("renders the #chaos-ladder scroll anchor", () => {
    const container = renderLadder();
    expect(container.querySelector("#chaos-ladder")).not.toBeNull();
  });

  it("marks Level 1 playable and names the live scenario", () => {
    renderLadder();
    expect(screen.getByText(new RegExp(liveScenario.displayName))).toBeDefined();
    const playable = document.querySelector(".chaos-level-playable");
    expect(playable).not.toBeNull();
    expect(playable?.textContent).toContain("First Cracks");
    expect(playable?.textContent).toContain(liveScenario.displayName);
  });
});
