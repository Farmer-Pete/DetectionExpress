/**
 * verify:static — prove the CDN (static) build carries no dev-kit code.
 *
 * It rebuilds the static bundle in memory with `process.env.PUBLIC_DEV_KIT="false"`
 * (the exact define `build:static` uses) and fails if any dev-kit code survived. Two
 * checks, one exact and one a backstop:
 *
 * 1. Module absence, from Bun's build metafile: neither `dev-host-client` nor
 *    `DevKitPanel` may be an input of the static bundle. The dev-flag loaders gate
 *    their dynamic imports behind the folded `DEV_KIT` const, so both modules drop out
 *    entirely. The metafile lists real inputs, so this is exact.
 * 2. Endpoint markers, by grepping the emitted JS: the dev-host endpoint strings
 *    `api/algorithm` and `algorithm/events` live only in `dev-host-client`, so neither
 *    may appear. The generic global `EventSource` is deliberately NOT a marker: any
 *    dependency may reference it, so grepping it risks a false-positive CI failure. The
 *    module-absence check (1) is the primary proof; these codebase-specific strings are
 *    the backstop. This also does NOT grep `createDevHostClient`: that property name
 *    survives in App's inert, null-guarded call-site (it ships no dev behavior), so
 *    grepping it would false-fail. See 12-PLAN.md, "The build flag".
 *
 * Run it with `bun run verify:static`. It exits non-zero, with the leak named, when a
 * check fails. The build stays in memory, so it writes nothing to disk.
 */

/** The dev modules that must never be an input of the static bundle. */
const DEV_MODULE_INPUTS = ["dev-host-client", "DevKitPanel"];

/** Dev-host endpoint strings that only `dev-host-client` carries. */
const DEV_ENDPOINT_MARKERS = ["api/algorithm", "algorithm/events"];

/** The outcome of a verify run: clean, or a list of the leaks that failed it. */
interface VerifyResult {
  ok: boolean;
  failures: string[];
}

/** Build the static bundle in memory and collect every dev-kit leak it carries. */
export async function verifyStatic(): Promise<VerifyResult> {
  const build = await Bun.build({
    entrypoints: ["./index.html"],
    define: { "process.env.PUBLIC_DEV_KIT": '"false"' },
    minify: true,
    metafile: true,
    throw: true,
  });

  const failures: string[] = [];

  const metafile = build.metafile;
  if (metafile === undefined) {
    return {
      ok: false,
      failures: ["Bun.build returned no metafile; cannot prove module absence."],
    };
  }

  const inputs = Object.keys(metafile.inputs);
  for (const marker of DEV_MODULE_INPUTS) {
    const leaked = inputs.filter((input) => input.includes(marker));
    if (leaked.length > 0) {
      failures.push(`dev module "${marker}" is a static input: ${leaked.join(", ")}`);
    }
  }

  let js = "";
  for (const output of build.outputs) {
    if (output.path.endsWith(".js")) {
      js += await output.text();
    }
  }
  for (const marker of DEV_ENDPOINT_MARKERS) {
    if (js.includes(marker)) {
      failures.push(`dev endpoint marker "${marker}" appears in the static JS.`);
    }
  }

  return { ok: failures.length === 0, failures };
}

if (import.meta.main) {
  const result = await verifyStatic();
  if (result.ok) {
    console.log("verify:static — the CDN build carries no dev-kit code.");
  } else {
    console.error("verify:static — dev-kit code leaked into the static build:");
    for (const failure of result.failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
}
