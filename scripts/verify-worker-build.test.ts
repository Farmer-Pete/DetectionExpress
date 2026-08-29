import { describe, expect, it } from "vitest";
import { type EmittedFile, inspectWorkerWiring } from "./verify-worker-build";

const mainChunk = (code: string): EmittedFile => ({
  fileName: "assets/index-abc.js",
  content: code,
  isChunk: true,
});

const workerAsset: EmittedFile = {
  fileName: "assets/worker-xyz.js",
  content: "",
  isChunk: false,
};

describe("inspectWorkerWiring", () => {
  it("passes when a worker file is emitted and referenced by its hashed name", () => {
    const result = inspectWorkerWiring([
      mainChunk('new Worker(new URL("assets/worker-xyz.js", import.meta.url));'),
      workerAsset,
    ]);
    expect(result.ok).toBe(true);
  });

  it("passes when the reference uses only the worker's base file name", () => {
    const result = inspectWorkerWiring([
      mainChunk('new Worker(new URL("worker-xyz.js", import.meta.url));'),
      workerAsset,
    ]);
    expect(result.ok).toBe(true);
  });

  it("fails when no worker file is emitted", () => {
    const result = inspectWorkerWiring([mainChunk("console.log(1);")]);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/no worker file/);
  });

  it("fails when the worker file is emitted but never referenced", () => {
    const result = inspectWorkerWiring([mainChunk("console.log(1);"), workerAsset]);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/no chunk references it/);
  });
});
