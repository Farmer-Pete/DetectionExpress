import { describe, expect, it } from "vitest";
import { type ChunkView, inspectStatic, verifyStatic } from "./verify-static";

/**
 * A clean main chunk: carries the app entry and the assembled-engine marker, with no
 * dev module or event marker. The marker stands in for the `virtual:engine-source`
 * string literal the real build ships: the teaching import's URL, a runtime string
 * literal only the assembled source emits (unlike the pin-brute-force rule's own
 * `REASON` value, which the typed detection path also ships) that survives both
 * minification and the assembler's own comment-stripping.
 */
const cleanChunk: ChunkView = {
  fileName: "assets/index-abc.js",
  moduleIds: ["src/main.tsx", "src/ui/App.tsx"],
  code: "console.log('detection express');import _ from \"https://esm.sh/lodash@4.17.21\";",
};

describe("inspectStatic", () => {
  it("passes a non-vacuous bundle with no dev module and no event marker", () => {
    const result = inspectStatic([cleanChunk]);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails when the dev client is a rendered input", () => {
    const result = inspectStatic([
      {
        fileName: "index.js",
        moduleIds: ["src/main.tsx", "src/game/algorithms-dev-client.ts"],
        code: "",
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/algorithms-dev-client/);
  });

  it("fails when the dev-flag loader is a rendered input", () => {
    const result = inspectStatic([
      {
        fileName: "index.js",
        moduleIds: ["src/main.tsx", "src/game/algorithms-dev-flag.ts"],
        code: "",
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/algorithms-dev-flag/);
  });

  it("fails when a dev event marker appears in the emitted JS", () => {
    const result = inspectStatic([
      { fileName: "index.js", moduleIds: ["src/main.tsx"], code: 'channel.send("algo:hello")' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/algo:hello/);
  });

  it("fails when the assembled engine is missing from the production JS", () => {
    const result = inspectStatic([
      { fileName: "index.js", moduleIds: ["src/main.tsx"], code: "console.log('no engine here')" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/assembled engine is missing/);
  });

  it("fails a vacuous build that carries no app entry chunk", () => {
    const result = inspectStatic([]);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/vacuous/);
  });

  it("fails a build whose only chunk lacks the app entry", () => {
    const result = inspectStatic([
      { fileName: "assets/vendor.js", moduleIds: ["src/ui/App.tsx"], code: "" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/vacuous/);
  });
});

describe("verifyStatic", () => {
  it("passes a clean production build", async () => {
    const result = await verifyStatic(() => Promise.resolve([cleanChunk]));
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails when the production build leaks the dev client", async () => {
    const result = await verifyStatic(() =>
      Promise.resolve([
        {
          fileName: "x.js",
          moduleIds: ["src/main.tsx", "src/game/algorithms-dev-client.ts"],
          code: "",
        },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/algorithms-dev-client/);
  });

  it("fails when the production build is vacuous", async () => {
    const result = await verifyStatic(() => Promise.resolve([]));
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/vacuous/);
  });
});
