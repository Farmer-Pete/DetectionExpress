/**
 * pack:check — prove the published dev-kit tarball is complete and runnable.
 *
 * It runs `pnpm pack --dry-run --json` (with scripts off, so the already-built
 * `dist-devkit` is inspected as-is, not rebuilt) and asserts the tarball carries
 * everything the `detection-express` bin needs to serve the dev build:
 *
 * - `package.json` and the `dd-dev.mjs` bin, with `dd-dev.mjs` executable (mode +x),
 * - `dist-devkit/index.html`,
 * - a hashed worker chunk (`dist-devkit/assets/worker-<hash>.js`), and
 * - every asset the built `index.html` references (the entry JS, the CSS, favicon).
 *
 * The pure check (`checkPack`) is unit-tested with a synthetic file list; the script
 * feeds it the real pack output, the built `index.html`, and the on-disk bin mode.
 *
 * Run with `pnpm run pack:check` (after `build:devkit`). Exits non-zero, with the
 * gap named, when a required member is missing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isMainModule } from "./entry";

const DEVKIT_DIR = "dist-devkit";
const WORKER_CHUNK = /^dist-devkit\/assets\/worker-[A-Za-z0-9_-]+\.js$/;

/** The parsed shape of `pnpm pack --dry-run --json`. */
interface PackResult {
  files: { path: string }[];
}

/** The outcome of a check: clean, or the gaps that failed it. */
export interface CheckResult {
  ok: boolean;
  failures: string[];
}

/** The paths (relative to the devkit root) the built index.html loads by URL. */
export function referencedAssets(indexHtml: string): string[] {
  const refs: string[] = [];
  for (const match of indexHtml.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    const url = match[1];
    if (url !== undefined) {
      refs.push(url.replace(/^\//, ""));
    }
  }
  return refs;
}

/** The pure check: does the packed file list carry every required member? */
export function checkPack(
  packedFiles: string[],
  indexHtml: string,
  binExecutable: boolean,
): CheckResult {
  const failures: string[] = [];
  const has = (candidate: string): boolean => packedFiles.includes(candidate);

  if (!has("package.json")) {
    failures.push("package.json is missing from the tarball");
  }
  if (!has("dd-dev.mjs")) {
    failures.push("dd-dev.mjs is missing from the tarball");
  } else if (!binExecutable) {
    failures.push("dd-dev.mjs is in the tarball but not executable (mode is not +x)");
  }
  if (!has(`${DEVKIT_DIR}/index.html`)) {
    failures.push(`${DEVKIT_DIR}/index.html is missing from the tarball`);
  }
  if (!packedFiles.some((file) => WORKER_CHUNK.test(file))) {
    failures.push(`no hashed worker chunk (${DEVKIT_DIR}/assets/worker-<hash>.js) in the tarball`);
  }
  for (const ref of referencedAssets(indexHtml)) {
    const packedPath = path.posix.join(DEVKIT_DIR, ref);
    if (!has(packedPath)) {
      failures.push(`index.html references /${ref}, but ${packedPath} is not in the tarball`);
    }
  }

  return { ok: failures.length === 0, failures };
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const raw = execFileSync(
    "pnpm",
    ["pack", "--dry-run", "--json", "--config.ignore-scripts=true"],
    { encoding: "utf8" },
  );
  const parsed: PackResult = JSON.parse(raw);
  const packedFiles = parsed.files.map((file) => file.path);
  const indexHtml = readFileSync(path.join(DEVKIT_DIR, "index.html"), "utf8");
  const binExecutable = (statSync("dd-dev.mjs").mode & 0o111) !== 0;

  const result = checkPack(packedFiles, indexHtml, binExecutable);
  if (result.ok) {
    console.log("pack:check — the dev-kit tarball carries every required member.");
  } else {
    console.error("pack:check — the dev-kit tarball is incomplete:");
    for (const failure of result.failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
}
