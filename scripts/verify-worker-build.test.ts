import { describe, expect, it } from "vitest";
import { type EmittedFile, inspectWorkerWiring } from "./verify-worker-build";

const entryChunk = (code: string): EmittedFile => ({
  fileName: "assets/index-abc.js",
  content: code,
  isChunk: true,
  isEntry: true,
});

const nonEntryChunk = (code: string): EmittedFile => ({
  fileName: "assets/lazy-def.js",
  content: code,
  isChunk: true,
  isEntry: false,
});

const workerAsset: EmittedFile = {
  fileName: "assets/worker-xyz.js",
  content: "",
  isChunk: false,
  isEntry: false,
};

describe("inspectWorkerWiring", () => {
  it("passes when a worker file is emitted and referenced by an entry chunk's hashed name", () => {
    const result = inspectWorkerWiring([
      entryChunk('new Worker(new URL("assets/worker-xyz.js", import.meta.url));'),
      workerAsset,
    ]);
    expect(result.ok).toBe(true);
  });

  it("passes when the entry reference uses only the worker's base file name", () => {
    const result = inspectWorkerWiring([
      entryChunk('new Worker(new URL("worker-xyz.js", import.meta.url));'),
      workerAsset,
    ]);
    expect(result.ok).toBe(true);
  });

  it("fails when no worker file is emitted", () => {
    const result = inspectWorkerWiring([entryChunk("console.log(1);")]);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/no worker file/);
  });

  it("fails when the worker file is emitted but never referenced", () => {
    const result = inspectWorkerWiring([entryChunk("console.log(1);"), workerAsset]);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/no entry chunk references it/);
  });

  it("fails when only a non-entry chunk references the worker", () => {
    const result = inspectWorkerWiring([
      entryChunk("console.log(1);"),
      nonEntryChunk('new Worker(new URL("assets/worker-xyz.js", import.meta.url));'),
      workerAsset,
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/no entry chunk references it/);
  });
});
