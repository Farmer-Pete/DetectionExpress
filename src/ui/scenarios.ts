/**
 * The UI-side Scenario slug map. The Scenario carries a stable `id` but no filename;
 * the dev host writes `detection-express-<slug>.js` from a logical name, so the app
 * turns each Scenario id into a slug here. The map is explicit and injective: every
 * value matches the host's slug pattern (`^[a-z0-9-]{1,64}$`) and no two ids share a
 * slug, so distinct Scenarios never collide on one file. `sim/` never learns about
 * files, so this lives in `ui/`, not the Scenario.
 */
export const SCENARIO_SLUGS: Record<string, string> = {
  "kiosk-pin-attack": "kiosk-pin-attack",
};

/**
 * The slug for a Scenario id. Throws on an unknown id rather than invent a filename.
 */
export function scenarioSlug(id: string): string {
  const slug = SCENARIO_SLUGS[id];
  if (slug === undefined) {
    throw new Error(`No slug is registered for the scenario id "${id}".`);
  }
  return slug;
}

/**
 * The Algorithm filename for a slug. This is the exact name the dev host writes on
 * disk (`detection-express-<slug>.js`), so a Scenario downloaded from the static build
 * drops straight into a local dev kit.
 */
export function scenarioFileName(slug: string): string {
  return `detection-express-${slug}.js`;
}
