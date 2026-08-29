import { describe, expect, it } from "vitest";
import {
  type AlgorithmSource,
  adaptModule,
  freshModuleUrl,
  type ImportSource,
  type LoadTarget,
  loadAlgorithm,
  toLoadTarget,
} from "./algorithm";

describe("freshModuleUrl", () => {
  it("appends a nonce with & when the url already has a query", () => {
    expect(freshModuleUrl("/src/algorithms/foo.ts?v=3", 7)).toBe("/src/algorithms/foo.ts?v=3&r=7");
  });

  it("appends a nonce with ? when the url has no query", () => {
    expect(freshModuleUrl("/src/game/default-engine.ts", 2)).toBe(
      "/src/game/default-engine.ts?r=2",
    );
  });

  it("gives two loads at the same version distinct urls, so each is a fresh module", () => {
    const url = "/src/algorithms/foo.ts?v=3";
    expect(freshModuleUrl(url, 4)).not.toBe(freshModuleUrl(url, 5));
  });
});

describe("adaptModule", () => {
  it("returns a working detect and defaults normalize to identity when absent", () => {
    const algo = adaptModule({
      detect: (event: { flag?: boolean }) =>
        event.flag ? [{ alert: { reason: "r", at: 1, eventIds: [1] } }] : [],
    });
    expect(algo.detect instanceof Function).toBe(true);
    expect(algo.normalize("passthrough")).toBe("passthrough"); // identity default
    expect(algo.detect({ flag: true })).toEqual([{ alert: { reason: "r", at: 1, eventIds: [1] } }]);
    expect(algo.detect({ flag: false })).toEqual([]);
  });

  it("uses the module's normalize when it exports one", () => {
    const algo = adaptModule({
      normalize: (r: { x: number }) => ({ u: r.x }),
      detect: () => [],
    });
    expect(algo.normalize({ x: 5 })).toEqual({ u: 5 });
  });

  it("rejects a module that exports no detect function", () => {
    expect(() => adaptModule({})).toThrow(/detect/i);
  });

  it("rejects a normalize export that is present but not a function", () => {
    expect(() => adaptModule({ detect: () => [], normalize: 5 })).toThrow(/normalize/i);
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
    const src: AlgorithmSource = { kind: "source", source: "export const detect = () => []" };
    expect(toLoadTarget(src)).toEqual({
      kind: "source",
      source: "export const detect = () => []",
    });
  });
});

describe("loadAlgorithm", () => {
  it("adapts the module returned by the injected import source", async () => {
    const target: LoadTarget = { kind: "source", source: "ignored source" };
    const importSource: ImportSource = () =>
      Promise.resolve({
        normalize: (r: { x: number }) => ({ u: r.x }),
        detect: (event: { flag?: boolean }) =>
          event.flag ? [{ alert: { reason: "r", at: 1, eventIds: [1] } }] : [],
      });
    const algo = await loadAlgorithm(target, importSource);
    expect(algo.normalize({ x: 5 })).toEqual({ u: 5 });
    expect(algo.detect({ flag: true })).toEqual([{ alert: { reason: "r", at: 1, eventIds: [1] } }]);
    expect(algo.detect({ flag: false })).toEqual([]);
  });

  it("passes a url target through to the import source unchanged", async () => {
    const seen: LoadTarget[] = [];
    const importSource: ImportSource = (target) => {
      seen.push(target);
      return Promise.resolve({ detect: () => [] });
    };
    await loadAlgorithm({ kind: "url", url: "src/algorithms/kiosk.ts?v=7" }, importSource);
    expect(seen).toEqual([{ kind: "url", url: "src/algorithms/kiosk.ts?v=7" }]);
  });

  it("passes a source target through to the import source unchanged", async () => {
    const seen: LoadTarget[] = [];
    const importSource: ImportSource = (target) => {
      seen.push(target);
      return Promise.resolve({ detect: () => [] });
    };
    await loadAlgorithm({ kind: "source", source: "export const detect = () => []" }, importSource);
    expect(seen).toEqual([{ kind: "source", source: "export const detect = () => []" }]);
  });

  it("surfaces a syntax error the import source rejects with", async () => {
    const importSource: ImportSource = () =>
      Promise.reject(new SyntaxError("Unexpected identifier"));
    await expect(
      loadAlgorithm({ kind: "source", source: "this is not valid javascript !!!" }, importSource),
    ).rejects.toThrow(SyntaxError);
  });
});
