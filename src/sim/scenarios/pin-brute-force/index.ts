/**
 * The pin-brute-force scenario's public face, as the registry reads it. One glob over
 * `scenarios/*​/index.ts` feeds three consumers from here: the UI reads `scenario`, the
 * engine reads `buildRule` (the rule factory), and the profiler reads `corpus`.
 *
 * `corpus` re-exports the cast primitives the profiler already builds its calibration
 * corpus from; the fuller corpus contract is a later milestone.
 */
export * as corpus from "./cast";
export { buildRule } from "./rule";
export { pinBruteForce as scenario } from "./scenario";
