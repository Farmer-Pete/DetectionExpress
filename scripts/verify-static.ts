/**
 * verify:static — prove the two-mode `define` splits the dev-kit code cleanly: the
 * CDN (static) build carries none of it, and the devkit build carries all of it.
 *
 * It rebuilds BOTH bundles in memory (`vite build --mode static` / `--mode devkit`,
 * each with `build.write: false` so nothing hits disk) and inspects their chunk
 * graphs.
 *
 * Static build (`inspectStatic`), three checks:
 *
 * 1. Module absence, from the build's chunk graph: neither `dev-host-client` nor
 *    `DevKitPanel` may be a rendered module of any static chunk. The dev-flag
 *    loaders gate their dynamic imports behind the folded `DEV_KIT` const, so both
 *    modules drop out entirely. The chunk graph lists real inputs, so this is exact.
 * 2. Endpoint markers, by scanning the emitted JS: the dev-host endpoint strings
 *    `api/algorithm` and `algorithm/events` live only in `dev-host-client`, so
 *    neither may appear. The module-absence check (1) is the primary proof; these
 *    codebase-specific strings are the backstop.
 * 3. Non-vacuous: the app entry module (`main.tsx`) must be a rendered module of
 *    some chunk. Without this, a build that emitted zero chunks — or nothing at all —
 *    would pass checks (1) and (2) trivially, proving nothing.
 *
 * Devkit build (`inspectDevkit`), one check: both `dev-host-client` and `DevKitPanel`
 * MUST be rendered modules. This confirms the static-omits result is the `define`
 * folding them out, not the code path having been deleted from both builds.
 *
 * Each build is reduced to a plain `ChunkView[]` (fileName, module ids, code) so the
 * pass/fail logic (`inspectStatic`, `inspectDevkit`) is pure and unit-tested with
 * synthetic chunks, and `verifyStatic` takes both builds as injectable seams.
 *
 * Run with `pnpm run verify:static`. It exits non-zero, with the leak or gap named,
 * when a check fails.
 */
import { build } from "vite";
import { isMainModule } from "./entry";

/**
 * The dev modules that gate on `DEV_KIT`: absent from the static bundle, present in
 * the devkit one.
 */
const DEV_MODULE_INPUTS = ["dev-host-client", "DevKitPanel"];

/** Dev-host endpoint strings that only `dev-host-client` carries. */
const DEV_ENDPOINT_MARKERS = ["api/algorithm", "algorithm/events"];

/**
 * The app entry module. Its presence proves the static build is non-vacuous — that
 * it actually bundled the app, so the dev-module-absence result means something.
 */
const APP_ENTRY_INPUT = "main.tsx";

/** A rendered JS chunk reduced to the fields the checks read. */
export interface ChunkView {
  fileName: string;
  moduleIds: string[];
  code: string;
}

/** The outcome of a verify run: clean, or a list of the leaks that failed it. */
export interface VerifyResult {
  ok: boolean;
  failures: string[];
}

/** Reduce a Vite/Rollup(-compatible) build result to the chunk views the checks read. */
function toChunkViews(result: Awaited<ReturnType<typeof build>>): ChunkView[] {
  const outputs = Array.isArray(result) ? result : [result];
  const chunks: ChunkView[] = [];
  for (const output of outputs) {
    if (!("output" in output)) {
      continue; // a RollupWatcher; never produced with write:false and no watch
    }
    for (const item of output.output) {
      if (item.type === "chunk") {
        chunks.push({
          fileName: item.fileName,
          moduleIds: Object.keys(item.modules),
          code: item.code,
        });
      }
    }
  }
  return chunks;
}

/** Build one mode in memory and reduce it to chunk views. */
async function buildMode(mode: "static" | "devkit"): Promise<ChunkView[]> {
  const result = await build({
    mode,
    logLevel: "silent",
    build: { write: false },
  });
  return toChunkViews(result);
}

/** The pure pass/fail logic for the static build: no dev-kit leak, and non-vacuous. */
export function inspectStatic(chunks: ChunkView[]): VerifyResult {
  const failures: string[] = [];

  const moduleIds = chunks.flatMap((chunk) => chunk.moduleIds);
  for (const marker of DEV_MODULE_INPUTS) {
    const leaked = moduleIds.filter((id) => id.includes(marker));
    if (leaked.length > 0) {
      failures.push(`dev module "${marker}" is a static input: ${leaked.join(", ")}`);
    }
  }

  const js = chunks.map((chunk) => chunk.code).join("");
  for (const marker of DEV_ENDPOINT_MARKERS) {
    if (js.includes(marker)) {
      failures.push(`dev endpoint marker "${marker}" appears in the static JS.`);
    }
  }

  if (!moduleIds.some((id) => id.includes(APP_ENTRY_INPUT))) {
    failures.push(
      `static build is vacuous: no chunk carries the app entry (expected a module matching "${APP_ENTRY_INPUT}")`,
    );
  }

  return { ok: failures.length === 0, failures };
}

/** The pure pass/fail logic for the devkit build: both dev modules must be present. */
export function inspectDevkit(chunks: ChunkView[]): VerifyResult {
  const failures: string[] = [];

  const moduleIds = chunks.flatMap((chunk) => chunk.moduleIds);
  for (const marker of DEV_MODULE_INPUTS) {
    if (!moduleIds.some((id) => id.includes(marker))) {
      failures.push(
        `dev module "${marker}" is absent from the devkit build (expected it as a rendered module)`,
      );
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Build (or take injected builds of) both modes and inspect each: the static build
 * must carry no dev-kit code and be non-vacuous; the devkit build must carry all of
 * it. Failures are prefixed with the mode they came from.
 */
export async function verifyStatic(
  runStaticBuild: () => Promise<ChunkView[]> = () => buildMode("static"),
  runDevkitBuild: () => Promise<ChunkView[]> = () => buildMode("devkit"),
): Promise<VerifyResult> {
  const staticResult = inspectStatic(await runStaticBuild());
  const devkitResult = inspectDevkit(await runDevkitBuild());
  const failures = [
    ...staticResult.failures.map((failure) => `[static] ${failure}`),
    ...devkitResult.failures.map((failure) => `[devkit] ${failure}`),
  ];
  return { ok: failures.length === 0, failures };
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const result = await verifyStatic();
  if (result.ok) {
    console.log("verify:static — static carries no dev-kit code; devkit carries all of it.");
  } else {
    console.error("verify:static — the two-mode dev-kit split is wrong:");
    for (const failure of result.failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
}
