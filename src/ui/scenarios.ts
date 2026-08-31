/**
 * The UI-side Scenario slug map. The Scenario carries a stable `id` but no filename;
 * the local-IDE flow keys an algorithm file on the slug (`src/algorithms/<slug>.ts`), so
 * the app turns each Scenario id into a slug here. The map is explicit and injective:
 * every value matches the slug pattern (`^[a-z0-9-]{1,64}$`) and no two ids share a slug,
 * so distinct Scenarios never collide on one file. `sim/` never learns about files, so
 * this lives in `ui/`, not the Scenario.
 */
export const SCENARIO_SLUGS: Record<string, string> = {
  "pin-brute-force": "pin-brute-force",
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
 * The download filename for a slug: `<slug>.ts`, the name the local-IDE flow expects at
 * `src/algorithms/<slug>.ts`. So a Scenario downloaded from the game drops straight in as
 * the starting point a player then edits and types. The saved content is the current
 * in-game source (JavaScript, valid TypeScript); the player adds types from there.
 */
export function scenarioFileName(slug: string): string {
  return `${slug}.ts`;
}
