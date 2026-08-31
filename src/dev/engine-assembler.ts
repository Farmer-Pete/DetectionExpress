/**
 * The engine assembler: it reads the typed engine files (the core, the endpoint
 * normalizers, and the scenario rule factories) and assembles them into ONE readable
 * JavaScript module — the string the in-game editor shows as its default and the
 * browser run loads. Two ways to read or change one engine: import the registry (the
 * typed, native path), or read this assembled source.
 *
 * It builds a small synthetic entry module (never written to disk) that imports every
 * endpoint family's `normalizers` table and every scenario's `buildRule`, then composes
 * them with the real, already-tested `createEngine` from `engine/engine.ts` — dispatch
 * logic is never reimplemented here. That entry is handed to Rolldown (the Rust bundler
 * Vite itself vendors, with a Rollup-compatible programmatic API), which resolves and
 * inlines the real dependency graph from disk: a rule that imports `core.ts` and its own
 * `tuning.ts`, a `tuning.ts` that imports one constant out of a large cross-cutting file,
 * even an import cycle — all handled by Rolldown's own resolver and tree-shaker, not by
 * a hand-rolled reimplementation of any of that. The one URL import (the teaching lodash
 * line a player would write) is kept external, so it survives in the output as a real
 * import rather than erroring or getting inlined.
 *
 * Each real file is type- and comment-stripped on its way in (a `load` plugin hook runs
 * `ts.transpileModule` with `removeComments: true`), so the assembled output carries no
 * TypeScript syntax and no comments. Output stays unminified (no `minify`): the assembled
 * source is meant to be read, not shipped as bundler soup. This module is Node-only (it
 * reads the filesystem and runs Rolldown); the Vite plugin `assemble-engine-plugin.ts`
 * serves its output as the `virtual:engine-source` module in both serve and build.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "rolldown";
import { rolldown } from "rolldown";
import ts from "typescript";

/** The teaching prop a player would write: a real URL import the logic never calls. */
const TEACHING_IMPORT = 'import _ from "https://esm.sh/lodash@4.17.21";';

/** The synthetic entry module's id. Not a real file: our own plugin resolves and loads
 * it directly, so Rolldown never touches disk for it. */
const ENTRY_ID = "\0virtual:engine-entry";

/** True for an http(s) specifier: the teaching import, or a future one like it, that must
 * stay an external import in the assembled output rather than being resolved from disk. */
function isUrlSpecifier(spec: string): boolean {
  return /^https?:\/\//.test(spec);
}

/** Type- and comment-strip one TS source to JS, keeping ES module import/export syntax so
 * Rolldown's own resolver still has real specifiers to work with. Comments are dropped via
 * the compiler's own flag, not a minifier: the output stays readable, just comment-free. */
function stripTypesAndComments(src: string): string {
  return ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      removeComments: true,
    },
  }).outputText;
}

/** Two kinds of comment Rolldown's own codegen injects that the `comments` output option
 * does not fully suppress: a `//#region <path>` / `//#endregion` pair wrapping each
 * original file's code (a file-boundary marker, not a comment carried over from source),
 * and a `/* @__PURE__ *\/` annotation ahead of a handful of known-pure constructor calls
 * (`new Map()`, `new Set()`) even with `comments: false` passed to `generate()`. Neither
 * is a comment from our own sources; since comments must be fully stripped regardless of
 * origin, drop both mechanically here — plain text filters, not a minifier pass — then
 * collapse the blank lines the region-marker removal leaves behind. */
function stripBundlerComments(code: string): string {
  return code
    .replaceAll("/* @__PURE__ */ ", "")
    .split("\n")
    .filter((line) => !/^\s*\/\/#(region|endregion)\b/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** List the immediate subdirectories of `dir`, sorted, so assembly is deterministic. */
function subdirs(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Resolve a relative import specifier to a real file on disk, trying the plain path, a
 * ".ts" suffix, and an "index.ts" inside it — the shapes this codebase's own imports use.
 * Throws when none exist: silently dropping an unresolved import would leave a broken
 * reference in the assembled module. */
function resolveTsFile(fromDir: string, spec: string): string {
  const base = join(fromDir, spec);
  const candidates = [base, `${base}.ts`, join(base, "index.ts")];
  const found = candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  if (found === undefined) {
    throw new Error(
      `engine-assembler: cannot resolve "${spec}" from "${fromDir}" (tried ${candidates.join(", ")}).`,
    );
  }
  return found;
}

/**
 * The Rolldown plugin that makes the engine's real TS files buildable: it resolves the
 * synthetic entry id and every relative import against disk, and loads and type/comment
 * strips each real file on the way in. URL specifiers resolve as external, so Rolldown
 * keeps them as imports in the output instead of trying to fetch or inline them.
 */
function engineFilesPlugin(simDir: string, entrySource: string): Plugin {
  return {
    name: "engine-assembler:local-ts",
    resolveId(source, importer) {
      if (source === ENTRY_ID) {
        return ENTRY_ID;
      }
      if (isUrlSpecifier(source)) {
        return { id: source, external: true };
      }
      const fromDir = importer === undefined || importer === ENTRY_ID ? simDir : dirname(importer);
      return resolveTsFile(fromDir, source);
    },
    load(id) {
      if (id === ENTRY_ID) {
        // Already plain, comment-free JS (we built it ourselves): no TS syntax to strip.
        return entrySource;
      }
      return stripTypesAndComments(readFileSync(id, "utf8"));
    },
  };
}

/**
 * Build the synthetic engine entry source (never written to disk): it imports every
 * endpoint family's `normalizers` table and every scenario's `buildRule`, then composes
 * them with the real `createEngine` — the same composition the typed registry uses — so
 * dispatch-by-endpoint and per-rule state isolation come from that one tested function,
 * not a reimplementation here.
 */
function buildEntrySource(simDir: string): string {
  const endpointsDir = join(simDir, "endpoints");
  const families = subdirs(endpointsDir).filter((family) =>
    existsSync(join(endpointsDir, family, "normalize.ts")),
  );

  const scenariosDir = join(simDir, "scenarios");
  const slugs = subdirs(scenariosDir).filter((slug) =>
    existsSync(join(scenariosDir, slug, "rule.ts")),
  );

  const normalizerImports = families.map(
    (family, i) =>
      `import { normalizers as __normalizers${i} } from "./endpoints/${family}/normalize";`,
  );
  const ruleImports = slugs.map(
    (slug, i) => `import { buildRule as __buildRule${i} } from "./scenarios/${slug}/rule";`,
  );

  const normalizersSpread = families.map((_, i) => `...__normalizers${i}`).join(", ");
  const rulesList = slugs.map((_, i) => `__buildRule${i}`).join(", ");

  return [
    'import { createEngine } from "./engine/engine";',
    ...normalizerImports,
    ...ruleImports,
    "",
    "const __engine = createEngine({",
    `  normalizers: { ${normalizersSpread} },`,
    `  rules: [${rulesList}],`,
    "});",
    "",
    "export function normalize(raw, endpoint) {",
    "  return __engine.normalize(raw, endpoint);",
    "}",
    "export function detect(e) {",
    "  return __engine.detect(e);",
    "}",
    "",
  ].join("\n");
}

/**
 * Assemble the engine files under `rootDir/src/sim` into one readable JS module string.
 * The result exports `normalize(raw, endpoint)` and `detect(e)`, opens with the teaching
 * lodash import, and carries no other imports. Uses Rolldown's programmatic API to
 * resolve and inline the real dependency graph (handling re-exports, shared imports, and
 * cycles natively); no disk I/O of its own beyond reading the source files themselves —
 * the result is returned as a string, never written.
 *
 * The teaching import is prepended to Rolldown's output rather than run through it: a
 * bundler drops an unused named/default binding from an import even when the module
 * itself is kept external for its (assumed) side effects, which would silently turn
 * `import _ from "…"` into a bare `import "…"` — a real behavior change from the old
 * hand-rolled assembler's byte-for-byte copy. Splicing it in preserves the exact literal
 * a player would write. The `external` guard on the bundling step below is still real
 * machinery, not vestigial: it is what keeps a URL import inside an actual sim file (a
 * future one, alongside this one) from being inlined or erroring during resolution.
 */
export async function assembleEngineSource(rootDir: string): Promise<string> {
  const simDir = join(rootDir, "src", "sim");
  const entrySource = buildEntrySource(simDir);

  const bundle = await rolldown({
    input: ENTRY_ID,
    plugins: [engineFilesPlugin(simDir, entrySource)],
    external: (id: string) => isUrlSpecifier(id),
    logLevel: "silent",
    // Rolldown's default `smart` constant-inlining collapses an imported constant to its
    // literal value at every usage site and drops the declaration — correct, but it turns
    // a named tuning constant into a bare number wherever it's read. Off, so a constant
    // like `PIN_BRUTE_FORCE_THRESHOLD` stays a readable declaration in the output; module-
    // level tree-shaking (dropping a cross-cutting file's OTHER, unused exports) is a
    // separate mechanism and stays on regardless.
    optimization: { inlineConst: false },
  });

  try {
    const { output } = await bundle.generate({ format: "esm", minify: false, comments: false });
    const bundled = stripBundlerComments(output[0].code);
    return `${TEACHING_IMPORT}\n\n${bundled}`;
  } finally {
    await bundle.close();
  }
}
