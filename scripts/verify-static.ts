/**
 * verify:static — prove the CDN (static) build carries no dev-kit code.
 *
 * It rebuilds the static bundle in memory (`vite build --mode static`, with
 * `build.write: false` so nothing hits disk) and fails if any dev-kit code
 * survived. Two checks, one exact and one a backstop:
 *
 * 1. Module absence, from the build's chunk graph: neither `dev-host-client` nor
 *    `DevKitPanel` may be a rendered module of any static chunk. The dev-flag
 *    loaders gate their dynamic imports behind the folded `DEV_KIT` const, so both
 *    modules drop out entirely. The chunk graph lists real inputs, so this is exact.
 * 2. Endpoint markers, by scanning the emitted JS: the dev-host endpoint strings
 *    `api/algorithm` and `algorithm/events` live only in `dev-host-client`, so
 *    neither may appear. The module-absence check (1) is the primary proof; these
 *    codebase-specific strings are the backstop.
 *
 * The build is reduced to a plain `ChunkView[]` (fileName, module ids, code) so the
 * pass/fail logic (`inspectStatic`) is pure and unit-tested with synthetic chunks,
 * and `verifyStatic` takes the build as an injectable seam.
 *
 * Run with `pnpm run verify:static`. It exits non-zero, with the leak named, when a
 * check fails.
 */
import { build } from "vite";
import { isMainModule } from "./entry";

/** The dev modules that must never be a rendered module of the static bundle. */
const DEV_MODULE_INPUTS = ["dev-host-client", "DevKitPanel"];

/** Dev-host endpoint strings that only `dev-host-client` carries. */
const DEV_ENDPOINT_MARKERS = ["api/algorithm", "algorithm/events"];

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

/** Build the static bundle in memory and reduce it to chunk views. */
async function buildStatic(): Promise<ChunkView[]> {
  const result = await build({
    mode: "static",
    logLevel: "silent",
    build: { write: false },
  });
  return toChunkViews(result);
}

/** The pure pass/fail logic: collect every dev-kit leak the chunks carry. */
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

  return { ok: failures.length === 0, failures };
}

/** Build (or take an injected build) and inspect it for dev-kit leaks. */
export async function verifyStatic(
  runBuild: () => Promise<ChunkView[]> = buildStatic,
): Promise<VerifyResult> {
  return inspectStatic(await runBuild());
}

if (isMainModule(process.argv[1], import.meta.url)) {
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
