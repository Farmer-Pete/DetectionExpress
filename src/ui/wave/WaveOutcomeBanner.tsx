/**
 * The wave outcome banner (GH126-PLAN.md M3b): a transient held/breach reading, fed
 * by the sampler's `SimSnapshot.waveOutcome` (M3a). It rides from a wave's
 * resolution through the cooldown gap until the next wave triggers, since the
 * engine clears `waveOutcome` the instant a fresh wave starts (`game/engine.ts`
 * `triggerWave`) — so this banner naturally shows during the calm gap and
 * disappears the moment a new wave begins. `role="status"`/`aria-live="polite"`
 * announces the change without stealing focus.
 *
 * Replaces the retired won/lost end screen (`MetroView.tsx`'s old `EndedOverlay`):
 * the endless baseline never reaches won or lost, so a per-wave reading is the
 * outcome that matters now.
 */
import { useGameStore } from "../../game/store";

export function WaveOutcomeBanner() {
  const waveOutcome = useGameStore((state) => state.snapshot.waveOutcome);
  if (waveOutcome === null) {
    return null;
  }
  const { outcome, caughtCount, attackCount } = waveOutcome;
  const text =
    outcome === "held"
      ? `Threat contained: ${caughtCount}/${attackCount} caught`
      : `Breach: ${caughtCount}/${attackCount} caught`;
  return (
    <div
      className={`wave-outcome-banner wave-outcome-banner-${outcome}`}
      role="status"
      aria-live="polite"
    >
      {text}
    </div>
  );
}
