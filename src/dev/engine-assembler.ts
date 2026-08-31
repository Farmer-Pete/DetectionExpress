/**
 * The engine assembler: it reads the typed engine files (the core, the endpoint
 * normalizers, and the scenario rule factories) and assembles them into ONE readable
 * JavaScript module — the string the in-game editor shows as its default and the
 * browser run loads. Two ways to read or change one engine: import the registry (the
 * typed, native path), or read this assembled source.
 *
 * It is dependency-aware, not a naive import strip. A `rule.ts` imports `core.ts` for
 * `withinWindow` and its own `tuning.ts` for its constants; dropping either import
 * would leave an unresolved name. Instead the assembler inlines the graph: `core` once
 * at the top (shared by every rule and normalizer, in full), then each rule's or
 * normalizer's own dependency (its `tuning.ts`, say) inlined into that entry's own
 * block. A dependency reached this way is shaken to the declarations its importer
 * actually uses (transitively, within that dependency file), not inlined whole: a
 * scenario's `tuning.ts` importing a cross-cutting constant for a value the rule never
 * reads must not drag that whole cross-cutting file into the rule's block. It keeps URL
 * imports only (the teaching lodash line a player would write) — a relative import it
 * cannot parse as a plain named import throws, rather than silently leaving a broken
 * reference in the assembled module.
 *
 * It parses each file's real TypeScript AST (not a line-by-line guess) to find each
 * top-level declaration's name and which other top-level names its own code
 * references, type-strips the kept declarations with `tsc` (comments preserved), and
 * finally formats the whole module with Biome so the indent widths match house style. A
 * failure at any step — an unsupported import shape, a missing file, or Biome itself —
 * throws, rather than falling back to unformatted or broken output: a broken editor
 * default is worse than a build that fails loudly. This module is Node-only (it reads
 * the filesystem and runs the TypeScript compiler); the Vite plugin
 * `assemble-engine-plugin.ts` serves its output as the `virtual:engine-source` module
 * in both serve and build.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";

/** The teaching prop a player would write: a real URL import the logic never calls. */
const TEACHING_IMPORT =
  'import _ from "https://esm.sh/lodash@4.17.21"; // teaching prop, unused by the logic';

/** Type-strip one TS source snippet to JS, keeping comments. Run once, at the end, over
 * the already-selected declarations for one file, so a value declaration's own type
 * annotations (parameter types, `readonly number[]`, and so on) still get stripped. */
function transpile(src: string): string {
  return ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      removeComments: false,
    },
  }).outputText;
}

/** Strip a leading `export` keyword off one line, preserving its indentation. */
function stripExportKeyword(line: string): string {
  return line.replace(/^(\s*)export\s+/, "$1");
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

/** True for a relative specifier ("./x" or "../x"); false for a bare or URL import. */
function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith(".");
}

/** One top-level value declaration this file can select into the output: the names it
 * declares (empty when `alwaysInclude`, e.g. an unrecognized statement shape or a kept
 * bare/URL import), its own source text, and whether selection can ever skip it. */
interface ValueNode {
  kind: "value";
  names: string[];
  text: string;
  alwaysInclude: boolean;
}

/** One top-level import binding, tracked as its own graph node so a value declaration's
 * reference to it is enough to pull in its owning module. */
interface ImportNode {
  kind: "import";
  local: string;
  imported: string;
  modulePath: string;
}

type TopLevelNode = ValueNode | ImportNode;

/** The leading trivia (comments/blank lines) immediately before `node`, as source text. */
function leadingTrivia(node: ts.Node, sourceFile: ts.SourceFile): string {
  const full = node.getFullText(sourceFile);
  const own = node.getText(sourceFile);
  return full.slice(0, full.length - own.length);
}

/** True when `clause`'s named bindings are exactly `import { a, b as c } from ...`. */
function namedBindingsOf(clause: ts.ImportClause): readonly ts.ImportSpecifier[] | null {
  const bindings = clause.namedBindings;
  return bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements : null;
}

/**
 * Parse one file's top-level statements into the node graph the closure walk below
 * reads: an `ImportNode` per named binding (relative imports only; a bare or URL import
 * is instead kept verbatim as an always-included `ValueNode`), and a `ValueNode` per
 * other top-level declaration. Also returns the file's own leading header comment,
 * rescued separately when the very first statement is a relative import (whose own text
 * is never emitted directly, so its leading comment would otherwise be lost).
 *
 * Throws on a relative import whose shape this cannot parse (default or namespace
 * import): dropping it would leave an unresolved name in the assembled module.
 */
function parseTopLevel(path: string, source: string): { nodes: TopLevelNode[]; header: string } {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TS,
  );
  const nodes: TopLevelNode[] = [];
  let header = "";

  sourceFile.statements.forEach((stmt, index) => {
    if (ts.isImportDeclaration(stmt)) {
      const moduleSpecifier = stmt.moduleSpecifier;
      const modulePath = ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : null;
      const clause = stmt.importClause;
      const relative = modulePath !== null && isRelativeSpecifier(modulePath);

      if (!relative) {
        // A bare or URL import (the teaching prop, or a future one like it): kept
        // verbatim, not resolved. Nothing to recurse into, so it carries no names.
        nodes.push({
          kind: "value",
          names: [],
          text: stmt.getFullText(sourceFile),
          alwaysInclude: true,
        });
        return;
      }
      if (index === 0) {
        header = leadingTrivia(stmt, sourceFile).trim();
      }
      if (clause === undefined || clause.isTypeOnly) {
        return; // a type-only or side-effect-only relative import: nothing to inline
      }
      const elements = namedBindingsOf(clause);
      if (elements === null) {
        throw new Error(
          `engine-assembler: cannot inline the import \`${stmt.getText(sourceFile).trim()}\` in ` +
            `"${path}". Only a plain named import ("import { a, b as c } from "./x";") of a ` +
            "relative module can be inlined; dropping an import the assembler cannot parse " +
            "would leave an unresolved name in the assembled module.",
        );
      }
      for (const element of elements) {
        if (element.isTypeOnly) {
          continue; // an individually `type`-tagged specifier: no runtime value
        }
        nodes.push({
          kind: "import",
          imported: (element.propertyName ?? element.name).text,
          local: element.name.text,
          modulePath,
        });
      }
      return;
    }

    // Any other top-level statement: a value declaration if it names one, else an
    // unrecognized shape kept unconditionally (safer than guessing it away). Always its
    // own `getFullText()`, header included: when this is the first statement and no
    // import precedes it (e.g. `core.ts`, which imports nothing), the file's own header
    // comment is this node's leading trivia, and there is no import to rescue it from.
    const text = stmt.getFullText(sourceFile);
    if (ts.isVariableStatement(stmt)) {
      const names = stmt.declarationList.declarations
        .map((d) => (ts.isIdentifier(d.name) ? d.name.text : null))
        .filter((name): name is string => name !== null);
      const allSimple = names.length === stmt.declarationList.declarations.length;
      nodes.push({ kind: "value", names, text, alwaysInclude: !allSimple });
      return;
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) {
      nodes.push({ kind: "value", names: [stmt.name.text], text, alwaysInclude: false });
      return;
    }
    nodes.push({ kind: "value", names: [], text, alwaysInclude: true });
  });

  return { nodes, header };
}

/** The names a value declaration's own text visibly mentions, checked with a
 * word-boundary match per candidate name. Over-inclusion (a name mentioned only in a
 * comment) is harmless; under-inclusion would drop a real reference, so this only ever
 * widens the selection, never narrows it below what the code itself needs. */
function referencesName(text: string, name: string): boolean {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
}

/**
 * Select the transitive closure of top-level nodes this file's importer actually needs:
 * `want` is either "all" (a root entry — core, a rule, or a normalizer — whose every own
 * declaration is part of its block regardless of what anyone imports from it) or the
 * specific names an importer requested. A value node pulls in every other node its own
 * text references; an import node pulls in nothing further here (its owning module is
 * resolved by the caller). Throws when a specifically wanted name does not exist in this
 * file: a scenario importing a name its own tuning file never exports is a real bug.
 */
function selectClosure(
  nodes: readonly TopLevelNode[],
  want: "all" | ReadonlySet<string>,
): Set<number> {
  const nameToIndex = new Map<string, number>();
  nodes.forEach((node, i) => {
    for (const name of node.kind === "value" ? node.names : [node.local]) {
      nameToIndex.set(name, i);
    }
  });

  const included = new Set<number>();
  function include(i: number): void {
    if (included.has(i)) {
      return;
    }
    included.add(i);
    const node = nodes[i];
    if (node?.kind !== "value") {
      return;
    }
    for (const [name, otherIndex] of nameToIndex) {
      if (otherIndex !== i && referencesName(node.text, name)) {
        include(otherIndex);
      }
    }
  }

  nodes.forEach((node, i) => {
    if (node.kind === "value" && node.alwaysInclude) {
      include(i);
    }
  });

  if (want === "all") {
    nodes.forEach((node, i) => {
      if (node.kind === "value") {
        include(i);
      }
    });
    return included;
  }

  for (const name of want) {
    const i = nameToIndex.get(name);
    if (i === undefined) {
      throw new Error(`engine-assembler: nothing named "${name}" is declared or imported.`);
    }
    include(i);
  }
  return included;
}

/** Resolve a relative import specifier against the importing file's own path. */
function resolveRelativeImport(fromFile: string, spec: string): string {
  const resolved = join(dirname(fromFile), spec);
  return resolved.endsWith(".ts") ? resolved : `${resolved}.ts`;
}

/**
 * Inline one file into the assembled module: its own selected declarations (per `want`,
 * see `selectClosure`), preceded by whatever its own imports resolve to, recursively.
 * `visited` (absolute paths) dedupes within one top-level entry (the core, one
 * normalizer, or one rule): a module already inlined at an outer scope (the shared
 * `core`, seeded into `visited` before a rule or normalizer is inlined) is skipped here
 * entirely, so `core` truly lands once, at the top, in full.
 */
function inlineFile(path: string, want: "all" | ReadonlySet<string>, visited: Set<string>): string {
  if (visited.has(path)) {
    return "";
  }
  visited.add(path);

  const { nodes, header } = parseTopLevel(path, readFileSync(path, "utf8"));
  const included = selectClosure(nodes, want);

  const depsByModule = new Map<string, Set<string>>();
  const aliasLines: string[] = [];
  const ownTsBlocks: string[] = [];

  nodes.forEach((node, i) => {
    if (!included.has(i)) {
      return;
    }
    if (node.kind === "value") {
      ownTsBlocks.push(node.text);
      return;
    }
    const wanted = depsByModule.get(node.modulePath) ?? new Set<string>();
    wanted.add(node.imported);
    depsByModule.set(node.modulePath, wanted);
    if (node.imported !== node.local) {
      aliasLines.push(`const ${node.local} = ${node.imported};`);
    }
  });

  const ownTs = [header, ...ownTsBlocks].filter((block) => block.length > 0).join("\n\n");
  const ownJs =
    ownTs.length > 0
      ? transpile(ownTs)
          .split("\n")
          .map(stripExportKeyword)
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim()
      : "";

  const depBlocks = [...depsByModule.entries()].map(([modulePath, wanted]) =>
    inlineFile(resolveRelativeImport(path, modulePath), wanted, visited),
  );

  return [...depBlocks, ...aliasLines, ownJs].filter((block) => block.length > 0).join("\n\n");
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

/** Run Biome's formatter over the assembled source. Throws on any failure: a broken or
 * unformatted editor default must never ship silently. */
function biomeFormat(source: string, rootDir: string): string {
  const bin = join(rootDir, "node_modules", ".bin", "biome");
  try {
    return execFileSync(bin, ["format", "--stdin-file-path=engine.mjs"], {
      input: source,
      encoding: "utf8",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `engine-assembler: Biome failed to format the assembled engine source: ${reason}`,
    );
  }
}

/**
 * Assemble the engine files under `rootDir/src` into one readable JS module string.
 * The result exports `normalize(raw, endpoint)` and `detect(e)`, opens with the
 * teaching lodash import, and carries no other imports. Throws on any assembly or
 * formatting failure (a missing file, an unsupported import shape, or Biome itself),
 * rather than shipping broken or unformatted output.
 */
export function assembleEngineSource(rootDir: string): string {
  const simDir = join(rootDir, "src", "sim");

  // `core` is inlined once, at the top, in full ("all"): `visited` carries its own path
  // (and anything IT imports) into every rule's and normalizer's own inlining pass
  // below, so none of them re-inline it.
  const sharedVisited = new Set<string>();
  const coreJs = inlineFile(join(simDir, "engine", "core.ts"), "all", sharedVisited);

  const endpointsDir = join(simDir, "endpoints");
  const normalizerBlocks = subdirs(endpointsDir)
    .map((family) => ({ family, path: join(endpointsDir, family, "normalize.ts") }))
    .filter((e) => existsSync(e.path))
    .map((e) => normalizerBlock(e.family, inlineFile(e.path, "all", new Set(sharedVisited))));

  const scenariosDir = join(simDir, "scenarios");
  const ruleBlocks = subdirs(scenariosDir)
    .map((slug) => ({ slug, path: join(scenariosDir, slug, "rule.ts") }))
    .filter((e) => existsSync(e.path))
    .map((e) => ruleBlock(e.slug, inlineFile(e.path, "all", new Set(sharedVisited))));

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
