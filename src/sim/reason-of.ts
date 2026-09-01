/**
 * The hunt-id -> alert-reason transform (GH42-PLAN.md "the rename (reason
 * mapping)"). Two id forms stay, by decision: the hunt id is hyphenated (e.g.
 * `"pin-brute-force"`), matching the catalogue; the alert reason stays
 * underscored (e.g. `"pin_brute_force"`), because a reason reads as a wire token
 * elsewhere (the scorer, the Alert JSON). This is the one documented mapping
 * between the two; `game/drift-guard.test.ts` checks every registered scenario
 * against it.
 */
export function reasonOf(id: string): string {
  return id.replaceAll("-", "_");
}
