import { describe, expect, it } from "vitest";
import { type ChunkView, inspectDevkit, inspectStatic, verifyStatic } from "./verify-static";

/** A clean main chunk: carries the app entry, no dev-kit module or endpoint marker. */
const cleanChunk: ChunkView = {
  fileName: "assets/index-abc.js",
  moduleIds: ["src/main.tsx", "src/ui/App.tsx"],
  code: "console.log('detection express');",
};

/** A devkit build: the app entry chunk plus the two dev-only chunks. */
const devkitChunks: ChunkView[] = [
  cleanChunk,
  { fileName: "assets/DevKitPanel-x.js", moduleIds: ["src/ui/DevKitPanel.tsx"], code: "" },
  {
    fileName: "assets/dev-host-client-y.js",
    moduleIds: ["src/game/dev-host-client.ts"],
    code: "",
  },
];

describe("inspectStatic", () => {
  it("passes a non-vacuous bundle with no dev module and no endpoint marker", () => {
    const result = inspectStatic([cleanChunk]);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails when a dev module is a rendered input", () => {
    const result = inspectStatic([
      {
        fileName: "index.js",
        moduleIds: ["src/main.tsx", "src/game/dev-host-client.ts"],
        code: "",
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/dev-host-client/);
  });

  it("fails when a dev endpoint marker appears in the emitted JS", () => {
    const result = inspectStatic([
      { fileName: "index.js", moduleIds: ["src/main.tsx"], code: 'fetch("/api/algorithm")' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/api\/algorithm/);
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

describe("inspectDevkit", () => {
  it("passes when both dev modules are rendered inputs", () => {
    const result = inspectDevkit(devkitChunks);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails when the devkit build is missing a dev module", () => {
    const withoutPanel = devkitChunks.filter((c) => !c.fileName.includes("DevKitPanel"));
    const result = inspectDevkit(withoutPanel);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/DevKitPanel/);
  });

  it("fails when the devkit build carries neither dev module", () => {
    const result = inspectDevkit([cleanChunk]);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/dev-host-client/);
    expect(result.failures.join(" ")).toMatch(/DevKitPanel/);
  });
});

describe("verifyStatic", () => {
  it("passes a clean static build alongside a complete devkit build", async () => {
    const result = await verifyStatic(
      () => Promise.resolve([cleanChunk]),
      () => Promise.resolve(devkitChunks),
    );
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails, tagged [static], when the static build leaks a dev module", async () => {
    const result = await verifyStatic(
      () =>
        Promise.resolve([
          { fileName: "x.js", moduleIds: ["src/main.tsx", "src/ui/DevKitPanel.tsx"], code: "" },
        ]),
      () => Promise.resolve(devkitChunks),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/\[static\].*DevKitPanel/);
  });

  it("fails, tagged [static], when the static build is vacuous", async () => {
    const result = await verifyStatic(
      () => Promise.resolve([]),
      () => Promise.resolve(devkitChunks),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/\[static\].*vacuous/);
  });

  it("fails, tagged [devkit], when the devkit build omits the dev modules", async () => {
    const result = await verifyStatic(
      () => Promise.resolve([cleanChunk]),
      () => Promise.resolve([cleanChunk]),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/\[devkit\].*dev-host-client/);
  });
});
