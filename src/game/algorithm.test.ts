import { describe, expect, it } from "vitest";
import {
  type AlgorithmSource,
  adaptModule,
  type ImportSource,
  type LoadTarget,
  loadAlgorithm,
  toLoadTarget,
} from "./algorithm";

describe("adaptModule", () => {
  it("returns a working match and defaults normalize to identity when absent", () => {
    const algo = adaptModule({
      match: (event: { flag?: boolean }) =>
        event.flag ? { reason: "r", at: 1, events: [1] } : null,
    });
    expect(algo.match instanceof Function).toBe(true);
    expect(algo.normalize("passthrough")).toBe("passthrough"); // identity default
    expect(algo.match({ flag: true })).toEqual({ reason: "r", at: 1, events: [1] });
    expect(algo.match({ flag: false })).toBeNull();
  });

  it("uses the module's normalize when it exports one", () => {
    const algo = adaptModule({
      normalize: (r: { x: number }) => ({ u: r.x }),
      match: () => null,
    });
    expect(algo.normalize({ x: 5 })).toEqual({ u: 5 });
  });

  it("rejects a module that exports no match function", () => {
    expect(() => adaptModule({})).toThrow(/match/i);
  });

  it("rejects a normalize export that is present but not a function", () => {
    expect(() => adaptModule({ match: () => null, normalize: 5 })).toThrow(/normalize/i);
  });
});

describe("toLoadTarget", () => {
  it("drops the cache-only path and version in url mode, keeping the url", () => {
    const src: AlgorithmSource = {
      kind: "url",
      path: "src/algorithms/kiosk.ts",
      version: 3,
      url: "src/algorithms/kiosk.ts?v=3",
    };
    expect(toLoadTarget(src)).toEqual({ kind: "url", url: "src/algorithms/kiosk.ts?v=3" });
  });

  it("carries the source string through in source mode", () => {
    const src: AlgorithmSource = { kind: "source", source: "export const match = () => null" };
    expect(toLoadTarget(src)).toEqual({
      kind: "source",
      source: "export const match = () => null",
    });
  });
});

describe("loadAlgorithm", () => {
  it("adapts the module returned by the injected import source", async () => {
    const target: LoadTarget = { kind: "source", source: "ignored source" };
    const importSource: ImportSource = () =>
      Promise.resolve({
        normalize: (r: { x: number }) => ({ u: r.x }),
        match: (event: { flag?: boolean }) =>
          event.flag ? { reason: "r", at: 1, events: [1] } : null,
      });
    const algo = await loadAlgorithm(target, importSource);
    expect(algo.normalize({ x: 5 })).toEqual({ u: 5 });
    expect(algo.match({ flag: true })).toEqual({ reason: "r", at: 1, events: [1] });
    expect(algo.match({ flag: false })).toBeNull();
  });

  it("passes a url target through to the import source unchanged", async () => {
    const seen: LoadTarget[] = [];
    const importSource: ImportSource = (target) => {
      seen.push(target);
      return Promise.resolve({ match: () => null });
    };
    await loadAlgorithm({ kind: "url", url: "src/algorithms/kiosk.ts?v=7" }, importSource);
    expect(seen).toEqual([{ kind: "url", url: "src/algorithms/kiosk.ts?v=7" }]);
  });

  it("passes a source target through to the import source unchanged", async () => {
    const seen: LoadTarget[] = [];
    const importSource: ImportSource = (target) => {
      seen.push(target);
      return Promise.resolve({ match: () => null });
    };
    await loadAlgorithm(
      { kind: "source", source: "export const match = () => null" },
      importSource,
    );
    expect(seen).toEqual([{ kind: "source", source: "export const match = () => null" }]);
  });

  it("surfaces a syntax error the import source rejects with", async () => {
    const importSource: ImportSource = () =>
      Promise.reject(new SyntaxError("Unexpected identifier"));
    await expect(
      loadAlgorithm({ kind: "source", source: "this is not valid javascript !!!" }, importSource),
    ).rejects.toThrow(SyntaxError);
  });
});
