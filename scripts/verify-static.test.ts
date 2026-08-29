import { describe, expect, it } from "vitest";
import { type ChunkView, inspectStatic, verifyStatic } from "./verify-static";

/** A clean main chunk with no dev-kit module or endpoint marker. */
const cleanChunk: ChunkView = {
  fileName: "assets/index-abc.js",
  moduleIds: ["src/main.tsx", "src/ui/App.tsx"],
  code: "console.log('detection express');",
};

describe("inspectStatic", () => {
  it("passes a bundle with no dev module and no endpoint marker", () => {
    const result = inspectStatic([cleanChunk]);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails when a dev module is a rendered input", () => {
    const result = inspectStatic([
      { fileName: "index.js", moduleIds: ["src/game/dev-host-client.ts"], code: "" },
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
});

describe("verifyStatic", () => {
  it("runs the injected build seam and passes a clean output", async () => {
    const result = await verifyStatic(() => Promise.resolve([cleanChunk]));
    expect(result.ok).toBe(true);
  });

  it("runs the injected build seam and fails a leaked output", async () => {
    const result = await verifyStatic(() =>
      Promise.resolve([{ fileName: "x.js", moduleIds: ["src/ui/DevKitPanel.tsx"], code: "" }]),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/DevKitPanel/);
  });
});
