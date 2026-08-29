import { describe, expect, it } from "vitest";
import { checkPack, referencedAssets } from "./verify-pack";

const INDEX_HTML = [
  '<link rel="icon" href="/favicon.svg" />',
  '<script type="module" src="/assets/index-abc.js"></script>',
  '<link rel="stylesheet" href="/assets/index-def.css">',
].join("\n");

/** A complete tarball listing that satisfies every requirement. */
const completeFiles = [
  "package.json",
  "dd-dev.mjs",
  "dist-devkit/index.html",
  "dist-devkit/favicon.svg",
  "dist-devkit/assets/index-abc.js",
  "dist-devkit/assets/index-def.css",
  "dist-devkit/assets/worker-xyz.js",
];

describe("referencedAssets", () => {
  it("extracts each rooted asset URL the index.html loads", () => {
    expect(referencedAssets(INDEX_HTML)).toEqual([
      "favicon.svg",
      "assets/index-abc.js",
      "assets/index-def.css",
    ]);
  });
});

describe("checkPack", () => {
  it("passes a complete, executable-bin tarball", () => {
    const result = checkPack(completeFiles, INDEX_HTML, true);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails when the bin is present but not executable", () => {
    const result = checkPack(completeFiles, INDEX_HTML, false);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/not executable/);
  });

  it("fails when the hashed worker chunk is absent", () => {
    const withoutWorker = completeFiles.filter((f) => !f.includes("worker-"));
    const result = checkPack(withoutWorker, INDEX_HTML, true);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/worker/);
  });

  it("fails when a referenced asset is not packed", () => {
    const withoutCss = completeFiles.filter((f) => !f.endsWith(".css"));
    const result = checkPack(withoutCss, INDEX_HTML, true);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/index-def\.css/);
  });

  it("fails when package.json or the bin is missing", () => {
    const result = checkPack(["dist-devkit/index.html"], INDEX_HTML, true);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/package\.json/);
    expect(result.failures.join(" ")).toMatch(/dd-dev\.mjs/);
  });
});
