/**
 * The Rule error the pipeline raises when player code misbehaves at a boundary.
 *
 * It lives in its own module so both `tasks.ts` (which throws it from `normalize`
 * and the detect fold) and `parse-findings.ts` (which throws it from the boundary
 * parser) import it without an import cycle. A throwing or bad-shaped
 * `normalize`/`detect` becomes one of these, so the supervisor reports it cleanly
 * through `onError` instead of a raw player exception crashing the app.
 */

/** The pipeline phase a RuleError came from: normalization, or detection. */
export type RulePhase = "normalize" | "detect";

export class RuleError extends Error {
  readonly phase: RulePhase;
  constructor(phase: RulePhase, message: string) {
    super(message);
    this.name = "RuleError";
    this.phase = phase;
  }
}
