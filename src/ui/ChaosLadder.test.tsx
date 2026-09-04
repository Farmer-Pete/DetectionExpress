import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defaultEntry } from "../game/registry";
import type { ChaosPhase } from "../sim/snapshot";
import { ChaosLadder } from "./ChaosLadder";
import { chaosLevels, liveScenarioFrom } from "./content/narrative";

const liveScenario = liveScenarioFrom(defaultEntry);
const idlePhase: ChaosPhase = { kind: "idle", selectedLevel: 0 };

function renderLadder(
  overrides: Partial<{
    selectedLevel: number;
    phase: ChaosPhase;
    onSelectLevel: (level: number) => void;
    disabled: boolean;
  }> = {},
) {
  const onSelectLevel = overrides.onSelectLevel ?? vi.fn();
  const utils = render(
    <ChaosLadder
      levels={chaosLevels}
      liveScenario={liveScenario}
      selectedLevel={overrides.selectedLevel ?? 0}
      phase={overrides.phase ?? idlePhase}
      onSelectLevel={onSelectLevel}
      disabled={overrides.disabled}
    />,
  );
  return { ...utils, onSelectLevel };
}

describe("ChaosLadder", () => {
  it("renders the six level labels in ladder order, level 0 through 5", () => {
    const { container } = renderLadder();
    const labels = [...container.querySelectorAll(".chaos-ladder-label")].map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(chaosLevels.map((level) => level.label));
  });

  it("renders the #chaos-ladder scroll anchor", () => {
    const { container } = renderLadder();
    expect(container.querySelector("#chaos-ladder")).not.toBeNull();
  });

  it("is a radio group with one radio per level", () => {
    renderLadder();
    expect(screen.getByRole("radiogroup")).toBeDefined();
    expect(screen.getAllByRole("radio")).toHaveLength(6);
  });

  it("marks level 1 playable and names the live scenario", () => {
    renderLadder();
    expect(screen.getByText(new RegExp(liveScenario.displayName))).toBeDefined();
  });

  it("selects level 0 by default; clicking level 1 calls onSelectLevel(1)", () => {
    const { onSelectLevel } = renderLadder({ selectedLevel: 0 });
    const level0Radio = screen.getByRole("radio", { name: /level 0/i });
    expect(level0Radio).toHaveProperty("checked", true);
    const level1Radio = screen.getByRole("radio", { name: /level 1/i });
    fireEvent.click(level1Radio);
    expect(onSelectLevel).toHaveBeenCalledWith(1);
  });

  it("indicates the currently selected level", () => {
    renderLadder({ selectedLevel: 1 });
    const level1Radio = screen.getByRole("radio", { name: /level 1/i });
    expect(level1Radio).toHaveProperty("checked", true);
    const level0Radio = screen.getByRole("radio", { name: /level 0/i });
    expect(level0Radio).toHaveProperty("checked", false);
  });

  it("disables levels 2-5 and never calls onSelectLevel for them, with a coming-soon affordance", () => {
    const { onSelectLevel } = renderLadder();
    for (const level of [2, 3, 4, 5]) {
      const radio = screen.getByRole("radio", {
        name: new RegExp(`level ${level}`, "i"),
      });
      expect(radio).toHaveProperty("disabled", true);
      fireEvent.click(radio);
    }
    expect(onSelectLevel).not.toHaveBeenCalled();
    expect(screen.getAllByText(/coming soon/i)).toHaveLength(4);
  });

  it("shows no phase indicator while idle", () => {
    renderLadder({ phase: idlePhase });
    expect(screen.queryByText(/wave active/i)).toBeNull();
    expect(screen.queryByText(/cooldown/i)).toBeNull();
  });

  it("shows a wave-active indicator while a wave is running", () => {
    renderLadder({
      selectedLevel: 1,
      phase: { kind: "wave", selectedLevel: 1, activeLevel: 1 },
    });
    expect(screen.getByText(/wave active/i)).toBeDefined();
  });

  it("shows a cooldown indicator, with the ticks remaining, during the cooldown gap", () => {
    renderLadder({
      selectedLevel: 1,
      phase: { kind: "cooldown", selectedLevel: 1, cooldownRemaining: 42 },
    });
    expect(screen.getByText(/cooldown/i)).toBeDefined();
    expect(screen.getByText(/42/)).toBeDefined();
  });

  // CodeRabbit (PR #130): a level-0 stop still runs its final cooldown out (see
  // `advanceChaosLoop` in `engine.ts`), but no wave follows it, so "next wave in..."
  // would be a lie. Matches `chaosWaveReading`'s own `selectedLevel > 0` gate.
  it("shows no phase indicator during the final cooldown after selecting level 0", () => {
    renderLadder({
      selectedLevel: 0,
      phase: { kind: "cooldown", selectedLevel: 0, cooldownRemaining: 42 },
    });
    expect(screen.queryByText(/cooldown/i)).toBeNull();
    expect(screen.queryByText(/wave active/i)).toBeNull();
  });

  // GH132-PLAN.md M2, "Step 2 drawer-open: Codex fixes (accepted)" rule 3: the tour
  // narrates the ladder, never lets the player click through it — `SidePanel` passes
  // `disabled` while it renders in tour mode, semantically disabling every level's
  // radio, playable or not (`disableActiveInteraction` on driver.js's own config is
  // only a CSS effect, not an AT-level disable).
  it("disables every level's radio, playable or not, when disabled is true", () => {
    const { onSelectLevel } = renderLadder({ disabled: true });
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toHaveProperty("disabled", true);
    }
    fireEvent.click(screen.getByRole("radio", { name: /level 0/i }));
    expect(onSelectLevel).not.toHaveBeenCalled();
  });
});
