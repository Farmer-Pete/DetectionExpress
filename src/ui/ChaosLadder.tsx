/**
 * The chaos ladder: a repeating LEVEL SELECTOR (GH126-PLAN.md M3, Q7), not a one-shot
 * trigger. Level 0 is calm (no chaos, the loop off); level 1 runs the one live hunt,
 * pin-brute-force; levels 2-5 are locked, described but not yet playable. Selecting a
 * playable rung reports the level up through `onSelectLevel`; the caller (`SidePanel`)
 * owns the store write.
 *
 * Purely presentational: `levels`, `liveScenario`, `selectedLevel`, and `phase` are
 * props, sourced by the mount site from one narrow `useGameStore` selector each
 * (ARCHITECTURE.md). Rendered as a native radio group, so Tab/Space/arrow-key
 * navigation and the disabled state on locked rungs come from the browser, not
 * hand-rolled keyboard handling.
 *
 * It renders a stable `#chaos-ladder` id, a harmless section landmark. It is the
 * side panel's default tab (GH118-PLAN.md); the intro no longer scrolls to it.
 */
import type { ChaosPhase } from "../sim/snapshot";
import type { ChaosLevel, LiveScenario } from "./content/narrative";

interface ChaosLadderProps {
  levels: readonly ChaosLevel[];
  liveScenario: LiveScenario;
  /** The currently selected level (0-5), read from the store's `chaosLevel`. */
  selectedLevel: number;
  /** The live chaos-loop phase, read from the snapshot's `chaosPhase`. */
  phase: ChaosPhase;
  /** Reports a click on a playable rung. Never called for a locked rung. */
  onSelectLevel: (level: number) => void;
  /** Semantically disables every radio, playable or not (GH132-PLAN.md M2, "Step 2
   *  drawer-open: Codex fixes (accepted)" rule 3): `SidePanel` sets this while it
   *  renders in tour mode, so the narrated ladder can never be clicked through.
   *  Defaults to false. */
  disabled?: boolean | undefined;
}

const RADIO_GROUP_NAME = "chaos-level";

/**
 * The phase line shown above the ladder while a cycle is running, or null while
 * idle. A `cooldown` phase with `selectedLevel === 0` is the final cooldown after a
 * level-0 stop (`engine.ts`'s `advanceChaosLoop` still lets that cooldown run out;
 * no wave follows it), so "next wave in..." would be false — treat it like idle.
 * Mirrors `chaosWaveReading`'s own `selectedLevel > 0` gate (`sim/wave-state.ts`).
 */
function phaseText(phase: ChaosPhase): string | null {
  if (phase.kind === "wave") {
    return `Wave active: level ${phase.activeLevel}`;
  }
  if (phase.kind === "cooldown" && phase.selectedLevel > 0) {
    return `Cooldown: next wave in ${phase.cooldownRemaining} ticks`;
  }
  return null;
}

export function ChaosLadder({
  levels,
  liveScenario,
  selectedLevel,
  phase,
  onSelectLevel,
  disabled = false,
}: ChaosLadderProps) {
  const phaseLine = phaseText(phase);
  return (
    <section
      id="chaos-ladder"
      className="chaos-ladder"
      aria-labelledby="chaos-ladder-title"
      tabIndex={-1}
      data-tour="chaos"
    >
      <h2 id="chaos-ladder-title" className="chaos-ladder-title">
        The chaos ladder
      </h2>
      {phaseLine !== null ? (
        <p className="chaos-ladder-phase" role="status">
          {phaseLine}
        </p>
      ) : null}
      <div className="chaos-ladder-list" role="radiogroup" aria-labelledby="chaos-ladder-title">
        {levels.map((level) => {
          const locked = !level.playable;
          // Guards the handler itself, not just the native `disabled` attribute: a
          // click on the ALREADY-selected radio (the common case for level 0, the
          // default) fires no native state change to gate on, so the guard must be
          // explicit rather than leaning on the browser's disabled-click suppression.
          const isDisabled = locked || disabled;
          const selected = level.level === selectedLevel;
          const isLiveRung = level.playable && level.level === liveScenario.level;
          const className = [
            "chaos-level",
            level.playable ? "chaos-level-playable" : "chaos-level-locked",
            selected ? "chaos-level-selected" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const inputId = `chaos-level-${level.level}`;
          return (
            <div key={level.level} className={className}>
              <label className="chaos-ladder-option" htmlFor={inputId}>
                <input
                  id={inputId}
                  type="radio"
                  name={RADIO_GROUP_NAME}
                  value={level.level}
                  checked={selected}
                  disabled={isDisabled}
                  onChange={() => {
                    if (!isDisabled) {
                      onSelectLevel(level.level);
                    }
                  }}
                  aria-label={`Level ${level.level}: ${level.label}`}
                />
                <span className="chaos-ladder-rung">Level {level.level}</span>
                <span className="chaos-ladder-label">{level.label}</span>
              </label>
              <p className="chaos-ladder-blurb">{level.blurb}</p>
              {isLiveRung ? (
                <p className="chaos-ladder-live">Playable now: {liveScenario.displayName}</p>
              ) : null}
              {locked ? <p className="chaos-ladder-locked-note">Coming soon</p> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
