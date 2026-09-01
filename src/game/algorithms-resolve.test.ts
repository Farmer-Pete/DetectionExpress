import { describe, expect, it } from "vitest";
import {
  buildChangedFrame,
  createVersionCounter,
  DEFAULT_ENGINE_PATH,
  ENGINE_OVERRIDE_PATH,
  localAlgorithmUrl,
  resolveActiveFile,
} from "./algorithms-resolve";

describe("resolveActiveFile", () => {
  it("resolves to the fixed engine override when it exists", () => {
    expect(resolveActiveFile(true)).toBe(ENGINE_OVERRIDE_PATH);
    expect(ENGINE_OVERRIDE_PATH).toBe("/src/algorithms/engine.ts");
  });

  it("falls back to the default engine when the override is missing", () => {
    expect(resolveActiveFile(false)).toBe(DEFAULT_ENGINE_PATH);
  });
});

describe("buildChangedFrame", () => {
  it("carries the slugless path and version", () => {
    expect(buildChangedFrame("/src/algorithms/engine.ts", 7)).toEqual({
      path: "/src/algorithms/engine.ts",
      version: 7,
    });
  });
});

describe("localAlgorithmUrl", () => {
  it("appends the cache-busting version query", () => {
    expect(localAlgorithmUrl("/src/algorithms/engine.ts", 3)).toBe("/src/algorithms/engine.ts?v=3");
  });
});

describe("createVersionCounter", () => {
  it("starts at 0 and pre-increments on each bump", () => {
    const version = createVersionCounter();
    expect(version.current()).toBe(0);
    expect(version.bump()).toBe(1);
    expect(version.bump()).toBe(2);
    expect(version.current()).toBe(2);
  });
});
