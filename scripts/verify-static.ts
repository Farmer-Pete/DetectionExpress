/**
 * verify:static — a production-build check. It builds the single production bundle in
 * memory (`vite build` with `build.write: false` so nothing hits disk) and inspects its
 * chunk graph, two checks:
 *
 * 1. Non-vacuous: the app entry module (`main.tsx`) must be a rendered module of some
 *    chunk. Without this, a build that emitted zero chunks — or nothing at all — would
 *    pass check (2) trivially, proving nothing.
 * 2. Assembled engine present: the readable single engine the editor loads, served as
 *    the `virtual:engine-source` string, must ship in the production JS. Its marker
 *    survives minification inside the string literal, so its presence proves the
 *    assembler ran and its output is in the build.
 *
 * The build is reduced to a plain `ChunkView[]` (fileName, module ids, code) so the
 * pass/fail logic (`inspectStatic`) is pure and unit-tested with synthetic chunks, and
 * `verifyStatic` takes the build as an injectable seam.
 *
 * Run with `pnpm run verify:static`. It exits non-zero, with the failure named, on
 * failure.
 */
import { build } from "vite";
import { isMainModule } from "./entry";

/**
 * A distinctive marker the assembled engine source carries. The `assemble-engine`
 * plugin serves the editor default as the `virtual:engine-source` module, a string
 * literal whose contents survive minification, so this marker lands in the production
 * JS iff the assembled engine shipped. Its presence is a POSITIVE assertion: the one
 * readable engine the editor loads must be in the build, not tree-shaken away.
 *
 * A string literal, not a comment: the assembler now strips every comment from the
 * assembled source (its Rolldown `load` hook runs `ts.transpileModule` with
 * `removeComments: true`), so a comment-based marker would no longer survive. This must
 * also be a literal ONLY the assembled source emits: the pin-brute-force rule's own
 * `REASON` value ships from the typed detection path too (`rule.ts`, `attacks.ts`), so
 * it cannot prove the assembler ran. The teaching import (`engine-assembler.ts`'s
 * `TEACHING_IMPORT`) is unique to the assembled output, so it is the marker instead.
 */
const ASSEMBLED_ENGINE_MARKER = "https://esm.sh/lodash@4.17.21";

/**
 * The app entry module. Its presence proves the build is non-vacuous — that it actually
 * bundled the app, so the assembled-engine check below means something.
 */
const APP_ENTRY_INPUT = "main.tsx";

/** A rendered JS chunk reduced to the fields the checks read. */
export interface ChunkView {
  fileName: string;
  moduleIds: string[];
  code: string;
}

/** The outcome of a verify run: clean, or a list of the failures found. */
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

/** The pure pass/fail logic: the build must be non-vacuous and carry the assembled engine. */
export function inspectStatic(chunks: ChunkView[]): VerifyResult {
  const failures: string[] = [];

  const moduleIds = chunks.flatMap((chunk) => chunk.moduleIds);
  const js = chunks.map((chunk) => chunk.code).join("");

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
 * be non-vacuous and carry the assembled engine.
 */
export async function verifyStatic(
  runBuild: () => Promise<ChunkView[]> = buildProduction,
): Promise<VerifyResult> {
  return inspectStatic(await runBuild());
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const result = await verifyStatic();
  if (result.ok) {
    console.log(
      "verify:static — the production build carries the assembled engine and is non-vacuous.",
    );
  } else {
    console.error("verify:static failed:");
    for (const failure of result.failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
}
