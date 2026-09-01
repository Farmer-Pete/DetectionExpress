/**
 * The in-process reference twin the deterministic tests drive. It is a thin
 * single-endpoint view over the shared source of truth: `normalizeKiosk` for the
 * kiosk wire format and `buildRule()` for the detect logic. So the twin, the composed
 * default engine, and the assembled editor source all derive from the same two files
 * and stay in parity by construction.
 *
 * The twin is single-endpoint on purpose: its `normalize(raw)` takes only the raw
 * payload (no endpoint dispatch), because the tests feed it kiosk-v1 readings and read
 * the normalized record straight back. State lives per instance, so a fresh
 * `buildReferenceAlgorithm()` replays a run cleanly.
 *
 * The editor's default source string is no longer a hand-maintained constant here; it
 * is assembled from these files by the Vite virtual module (`virtual:engine-source`,
 * re-exported from `src/game/engine-source.ts`).
 */
import type { RawKioskV1 } from "../../endpoints/kiosk/formats/kiosk-v1";
import { type NormalizedKiosk, normalizeKiosk } from "../../endpoints/kiosk/normalize";
import type { Finding } from "../../finding";
import { buildRule } from "./rule";

/** The flat view Detect hands the Rule: the normalized payload plus engine fields. */
interface KioskDetectView extends NormalizedKiosk {
  id: number;
  ts: number;
  endpoint: string;
}

export interface ReferenceAlgorithm {
  normalize(raw: RawKioskV1): NormalizedKiosk;
  detect(e: KioskDetectView): Finding[];
}

/**
 * The in-process twin. `normalize` is the kiosk normalizer; `detect` is one fresh
 * pin-brute-force rule instance, so its `fails`/`firing` state starts clean. The
 * concrete kiosk view is projected onto the engine's `DetectView` (its normalized
 * payload rides the index signature) at the single-endpoint boundary here.
 */
export function buildReferenceAlgorithm(): ReferenceAlgorithm {
  const rule = buildRule();
  return {
    normalize: normalizeKiosk,
    // Spread the concrete kiosk view into a fresh literal so it satisfies the engine's
    // `DetectView` (its index signature) at the seam, with no assertion.
    detect: (e) => rule.detect({ ...e }),
  };
}
