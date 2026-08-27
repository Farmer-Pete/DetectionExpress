/**
 * bindVisibility: the whole tab-switch story. It reads `document.hidden` first,
 * so a hidden-tab start begins paused, then keeps the Clock in sync with the
 * visibility state. Hidden pauses the Clock (ticks stop, tasks hold, the sampler
 * skips); visible resumes it. Nothing catches up, because ticks did not advance
 * while hidden. Returns a detach function.
 */
import type { Clock } from "./clock";

export function bindVisibility(clock: Clock): () => void {
  const sync = (): void => {
    if (document.hidden) {
      clock.pause();
    } else {
      clock.resume();
    }
  };
  sync();
  document.addEventListener("visibilitychange", sync);
  return () => {
    document.removeEventListener("visibilitychange", sync);
  };
}
