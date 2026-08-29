/**
 * verify:worker-build — prove Vite bundled and wired the profiler Web Worker.
 *
 * GH-22 was that Bun's HTML bundler never wired
 * `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`, so the
 * worker never loaded over http. Vite bundles it out of the box. This build-output
 * assertion proves that automatically: it builds each mode in memory and checks that
 *
 * 1. a worker file is emitted (Vite emits the worker bundle as `worker-<hash>.js`),
 *    and
 * 2. some emitted chunk references that worker file by its hashed name.
 *
 * Together those prove the worker is a real, separately-emitted module that the main
 * bundle loads by URL — exactly what was missing under Bun. Vite emits the worker as
 * an output asset (not a chunk), so the check scans both. The pure check
 * (`inspectWorkerWiring`) is unit-tested with synthetic files; the script runs it
 * against the real static and devkit builds.
 *
 * Run with `pnpm run verify:worker-build`. Exits non-zero on a failure in either
 * build.
 */
import { build } from "vite";
import { isMainModule } from "./entry";

const MODES = ["static", "devkit"];

/** Vite's emitted worker bundle: `worker-<hash>.js`, possibly under an assets dir. */
const WORKER_FILE = /(^|\/)worker-[A-Za-z0-9_-]+\.js$/;

/** An emitted output file reduced to the fields the check reads. */
export interface EmittedFile {
  fileName: string;
  /** The JS source for a chunk; empty for a non-chunk asset (unused by the check). */
  content: string;
  isChunk: boolean;
}

/** The outcome of a check: clean, or the reasons it failed. */
export interface VerifyResult {
  ok: boolean;
  failures: string[];
}

/** Reduce a Vite/Rollup(-compatible) build result to the emitted files. */
function toEmittedFiles(result: Awaited<ReturnType<typeof build>>): EmittedFile[] {
  const outputs = Array.isArray(result) ? result : [result];
  const files: EmittedFile[] = [];
  for (const output of outputs) {
    if (!("output" in output)) {
      continue; // a RollupWatcher; never produced with write:false and no watch
    }
    for (const item of output.output) {
      if (item.type === "chunk") {
        files.push({ fileName: item.fileName, content: item.code, isChunk: true });
      } else {
        files.push({ fileName: item.fileName, content: "", isChunk: false });
      }
    }
  }
  return files;
}

/** Build one mode in memory and reduce it to emitted files. */
async function buildMode(mode: string): Promise<EmittedFile[]> {
  const result = await build({
    mode,
    logLevel: "silent",
    build: { write: false },
  });
  return toEmittedFiles(result);
}

/** The pure check: a worker file is emitted and referenced by an emitted chunk. */
export function inspectWorkerWiring(files: EmittedFile[]): VerifyResult {
  const worker = files.find((file) => WORKER_FILE.test(file.fileName));
  if (!worker) {
    return { ok: false, failures: ["no worker file was emitted (expected worker-<hash>.js)"] };
  }
  const workerBase = worker.fileName.split("/").pop() ?? worker.fileName;
  const referenced = files.some(
    (file) =>
      file !== worker &&
      file.isChunk &&
      (file.content.includes(worker.fileName) || file.content.includes(workerBase)),
  );
  if (!referenced) {
    return {
      ok: false,
      failures: [`worker file "${worker.fileName}" is emitted but no chunk references it`],
    };
  }
  return { ok: true, failures: [] };
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const failures: string[] = [];
  for (const mode of MODES) {
    const result = inspectWorkerWiring(await buildMode(mode));
    for (const failure of result.failures) {
      failures.push(`[${mode}] ${failure}`);
    }
  }
  if (failures.length === 0) {
    console.log("verify:worker-build — the worker is emitted and wired in both builds.");
  } else {
    console.error("verify:worker-build — the worker is not wired:");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
}
