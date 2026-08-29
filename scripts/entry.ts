import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when this module is the process entry point (was run directly, not
 * imported). A portable check that does not rely on `import.meta.main`.
 *
 * Compares `argv[1]` against the module's own file, canonicalizing both with
 * realpath first so a bin symlink (`pnpm dlx`, an npm bin shim) still matches.
 * Robust to realpath throwing on a vanished path: it falls back to `path.resolve`,
 * so a relative `argv[1]` is still absolutized before the compare (a raw-path
 * fallback could misclassify a direct run as an import).
 */
export function isMainModule(
  argv1: string | undefined,
  moduleUrl: string,
  realpath: (p: string) => string = realpathSync,
): boolean {
  if (argv1 == null) {
    return false;
  }
  const resolve = (p: string): string => {
    try {
      return realpath(p);
    } catch {
      return path.resolve(p);
    }
  };
  return resolve(argv1) === resolve(fileURLToPath(moduleUrl));
}
