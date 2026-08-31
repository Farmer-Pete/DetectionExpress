/**
 * verify:static — a negative production check. There is one build now (86-PLAN.md M3):
 * the dev-only local-IDE code is gated on `import.meta.env.DEV`, which the production
 * build inlines to `false`, so it must tree-shake out entirely. This asserts that it did.
 *
 * It builds the single production bundle in memory (`vite build` with `build.write: false`
 * so nothing hits disk) and inspects its chunk graph, three checks:
 *
 * 1. Module absence, from the build's chunk graph: neither the `algorithms-dev-client`
 *    module nor its `algorithms-dev-flag` loader may be a rendered module of any chunk.
 *    Both sit behind the folded `import.meta.env.DEV` gate, so both drop out. The chunk
 *    graph lists real inputs, so this is exact.
 * 2. Event markers, by scanning the emitted JS: the custom HMR event identifiers
 *    `algo:changed` and `algo:hello` live only in the dev client, so neither may appear.
 *    The module-absence check (1) is the primary proof; these codebase-specific strings
 *    are the backstop.
 * 3. Non-vacuous: the app entry module (`main.tsx`) must be a rendered module of some
 *    chunk. Without this, a build that emitted zero chunks — or nothing at all — would
 *    pass checks (1) and (2) trivially, proving nothing.
 * 4. Assembled engine present (POSITIVE): the readable single engine the editor loads,
 *    served as the `virtual:engine-source` string, must ship in the production JS. Its
 *    marker comment survives minification inside the string literal, so its presence
 *    proves the assembler ran and its output is in the build.
 *
 * The build is reduced to a plain `ChunkView[]` (fileName, module ids, code) so the
 * pass/fail logic (`inspectStatic`) is pure and unit-tested with synthetic chunks, and
 * `verifyStatic` takes the build as an injectable seam.
 *
 * Run with `pnpm run verify:static`. It exits non-zero, with the leak named, on failure.
 */
import { build } from "vite";
import { isMainModule } from "./entry";

/**
 * The dev-only modules gated on `import.meta.env.DEV`: the local-IDE client and its
 * loader. Neither may be a rendered module of the production bundle.
 */
const DEV_MODULE_INPUTS = ["algorithms-dev-client", "algorithms-dev-flag"];

/** Custom HMR event identifiers that only the dev client carries. */
const DEV_EVENT_MARKERS = ["algo:changed", "algo:hello"];

/**
 * A distinctive marker the assembled engine source carries. The `assemble-engine`
 * plugin serves the editor default as the `virtual:engine-source` module, a string
 * literal whose contents survive minification, so this comment lands in the production
 * JS iff the assembled engine shipped. Its presence is a POSITIVE assertion: the one
 * readable engine the editor loads must be in the build, not tree-shaken away.
 */
const ASSEMBLED_ENGINE_MARKER = "teaching prop, unused by the logic";

/**
 * The app entry module. Its presence proves the build is non-vacuous — that it actually
 * bundled the app, so the dev-module-absence result means something.
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

/** Build the production bundle in memory and reduce it to chunk views. */
async function buildProduction(): Promise<ChunkView[]> {
  const result = await build({
    logLevel: "silent",
    build: { write: false },
  });
  return toChunkViews(result);
}

/** The pure pass/fail logic: no dev-only leak, and non-vacuous. */
export function inspectStatic(chunks: ChunkView[]): VerifyResult {
  const failures: string[] = [];

  const moduleIds = chunks.flatMap((chunk) => chunk.moduleIds);
  for (const marker of DEV_MODULE_INPUTS) {
    const leaked = moduleIds.filter((id) => id.includes(marker));
    if (leaked.length > 0) {
      failures.push(`dev module "${marker}" is a production input: ${leaked.join(", ")}`);
    }
  }

  const js = chunks.map((chunk) => chunk.code).join("");
  for (const marker of DEV_EVENT_MARKERS) {
    if (js.includes(marker)) {
      failures.push(`dev event marker "${marker}" appears in the production JS.`);
    }
  }

  if (!moduleIds.some((id) => id.includes(APP_ENTRY_INPUT))) {
    failures.push(
      `production build is vacuous: no chunk carries the app entry (expected a module matching "${APP_ENTRY_INPUT}")`,
    );
  }

  if (!js.includes(ASSEMBLED_ENGINE_MARKER)) {
    failures.push(
      `assembled engine is missing from the production build (expected the marker "${ASSEMBLED_ENGINE_MARKER}")`,
    );
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Build (or take an injected build of) the production bundle and inspect it: it must
 * carry no dev-only local-IDE code and be non-vacuous.
 */
export async function verifyStatic(
  runBuild: () => Promise<ChunkView[]> = buildProduction,
): Promise<VerifyResult> {
  return inspectStatic(await runBuild());
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const result = await verifyStatic();
  if (result.ok) {
    console.log("verify:static — the production build carries no dev-only local-IDE code.");
  } else {
    console.error("verify:static — dev-only code leaked into the production build:");
    for (const failure of result.failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
}
