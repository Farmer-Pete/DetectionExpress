/**
 * The engine assembler: it reads the typed engine files (the core, the endpoint
 * normalizers, and the scenario rule factories) and assembles them into ONE readable
 * JavaScript module — the string the in-game editor shows as its default and the
 * browser run loads. Two ways to read or change one engine: import the registry (the
 * typed, native path), or read this assembled source.
 *
 * It is dependency-aware, not a naive import strip. A `rule.ts` imports `core.ts` for
 * `withinWindow`; dropping that import would leave an unresolved name. Instead the
 * assembler inlines the graph: `core` once at the top, then each normalizer and rule
 * in its own block that registers into a shared table, then a generated `createEngine`
 * entry. It keeps URL imports only (the teaching lodash line a player would write).
 *
 * It type-strips each file with `tsc` (comments kept), drops the relative imports and
 * the `export` keyword, and finally formats the whole module with Biome so the indent
 * widths match house style. This module is Node-only (it reads the filesystem and runs
 * the TypeScript compiler); the Vite plugin `assemble-engine-plugin.ts` serves its
 * output as the `virtual:engine-source` module in both serve and build.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** The teaching prop a player would write: a real URL import the logic never calls. */
const TEACHING_IMPORT =
  'import _ from "https://esm.sh/lodash@4.17.21"; // teaching prop, unused by the logic';

/** Type-strip one TS source to JS, keeping comments and ES module syntax. */
function transpile(src: string): string {
  return ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      removeComments: false,
    },
  }).outputText;
}

/** Drop relative imports (URL imports stay) and strip the `export` keyword. */
function stripModuleSyntax(js: string): string {
  return js
    .split("\n")
    .filter((line) => !/^\s*import\b.*from\s+["']\.[^"']*["'];?\s*$/.test(line))
    .map((line) => line.replace(/^(\s*)export\s+/, "$1"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Read a TS file and reduce it to inlinable JS (type-stripped, imports/exports gone). */
function readStripped(path: string): string {
  return stripModuleSyntax(transpile(readFileSync(path, "utf8")));
}

/** Indent every non-empty line of a block by two spaces. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join("\n");
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

/** One endpoint's normalizer block: its code, then merge its `normalizers` into the table. */
function normalizerBlock(family: string, js: string): string {
  const inner = indent(
    [`// endpoint normalizers: ${family}`, js, "Object.assign(NORMALIZERS, normalizers);"].join(
      "\n",
    ),
  );
  return `{\n${inner}\n}`;
}

/** One rule block: its inlined code, then register its factory into the builders table. */
function ruleBlock(slug: string, js: string): string {
  const inner = indent([`// rule: ${slug}`, js, "BUILDERS.push(buildRule);"].join("\n"));
  return `{\n${inner}\n}`;
}

/** The generated engine entry: build fresh rules, dispatch normalize, route detect. */
const ENTRY = `// The engine entry. createEngine builds fresh rule instances, dispatches
// normalize by endpoint, then routes each event to every rule that owns its endpoint.
function createEngine() {
  const rules = BUILDERS.map((build) => build());
  return {
    normalize(raw, endpoint) {
      const normalizer = NORMALIZERS[endpoint];
      if (normalizer === undefined) {
        throw new Error('No normalizer is registered for endpoint "' + endpoint + '".');
      }
      return normalizer(raw);
    },
    detect(e) {
      const findings = [];
      for (const rule of rules) {
        if (rule.endpoints.includes(e.endpoint)) {
          findings.push(...rule.detect(e));
        }
      }
      return findings;
    },
  };
}

const __engine = createEngine();
export function normalize(raw, endpoint) {
  return __engine.normalize(raw, endpoint);
}
export function detect(e) {
  return __engine.detect(e);
}`;

/** Run Biome's formatter over the assembled source. Falls back to the input on failure. */
function biomeFormat(source: string, rootDir: string): string {
  try {
    const bin = join(rootDir, "node_modules", ".bin", "biome");
    return execFileSync(bin, ["format", "--stdin-file-path=engine.mjs"], {
      input: source,
      encoding: "utf8",
    });
  } catch {
    // Missing binary or a formatter error must never break the build; the tsc
    // indentation is already readable, so ship it unformatted.
    return source;
  }
}

/**
 * Assemble the engine files under `rootDir/src` into one readable JS module string.
 * The result exports `normalize(raw, endpoint)` and `detect(e)`, opens with the
 * teaching lodash import, and carries no other imports.
 */
export function assembleEngineSource(rootDir: string): string {
  const simDir = join(rootDir, "src", "sim");

  const coreJs = readStripped(join(simDir, "engine", "core.ts"));

  const endpointsDir = join(simDir, "endpoints");
  const normalizerBlocks = subdirs(endpointsDir)
    .map((family) => ({ family, path: join(endpointsDir, family, "normalize.ts") }))
    .filter((e) => existsSync(e.path))
    .map((e) => normalizerBlock(e.family, readStripped(e.path)));

  const scenariosDir = join(simDir, "scenarios");
  const ruleBlocks = subdirs(scenariosDir)
    .map((slug) => ({ slug, path: join(scenariosDir, slug, "rule.ts") }))
    .filter((e) => existsSync(e.path))
    .map((e) => ruleBlock(e.slug, readStripped(e.path)));

  const body = [
    TEACHING_IMPORT,
    "",
    "// ---- core ----",
    coreJs,
    "",
    "// ---- endpoint normalizers ----",
    "const NORMALIZERS = {};",
    ...normalizerBlocks,
    "",
    "// ---- rules ----",
    "const BUILDERS = [];",
    ...ruleBlocks,
    "",
    "// ---- entry ----",
    ENTRY,
    "",
  ].join("\n\n");

  return biomeFormat(body, rootDir);
}
