/**
 * The chaos ladder: the five levels of rising chaos, each with its authored blurb.
 * The one live scenario is marked playable inside its level and named there. The
 * other levels are described, not yet playable.
 *
 * It renders a stable `#chaos-ladder` anchor. The intro's "Cause chaos" action
 * scrolls to it after the overlay dismisses.
 */
import type { ChaosLevel, LiveScenario } from "./content/narrative";

interface ChaosLadderProps {
  levels: readonly ChaosLevel[];
  liveScenario: LiveScenario;
}

export function ChaosLadder({ levels, liveScenario }: ChaosLadderProps) {
  return (
    <section
      id="chaos-ladder"
      className="chaos-ladder"
      aria-labelledby="chaos-ladder-title"
      tabIndex={-1}
    >
      <h2 id="chaos-ladder-title" className="chaos-ladder-title">
        The chaos ladder
      </h2>
      <ol className="chaos-ladder-list">
        {levels.map((level) => {
          const live = level.playable && level.level === liveScenario.level;
          const className = live ? "chaos-level chaos-level-playable" : "chaos-level";
          return (
            <li key={level.level} className={className}>
              <span className="chaos-ladder-rung">Level {level.level}</span>
              <span className="chaos-ladder-label">{level.label}</span>
              <p className="chaos-ladder-blurb">{level.blurb}</p>
              {live ? (
                <p className="chaos-ladder-live">Playable now: {liveScenario.displayName}</p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
