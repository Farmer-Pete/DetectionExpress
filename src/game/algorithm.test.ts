import { describe, expect, it } from "vitest";
import { adaptModule, type ImportSource, loadAlgorithm } from "./algorithm";

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

describe("loadAlgorithm", () => {
  it("adapts the module returned by the injected import source", async () => {
    const importSource: ImportSource = () =>
      Promise.resolve({
        normalize: (r: { x: number }) => ({ u: r.x }),
        detect: (event: { flag?: boolean }) =>
          event.flag ? [{ alert: { reason: "r", at: 1, eventIds: [1] } }] : [],
      });
    const algo = await loadAlgorithm("ignored source", importSource);
    expect(algo.normalize({ x: 5 })).toEqual({ u: 5 });
    expect(algo.detect({ flag: true })).toEqual([{ alert: { reason: "r", at: 1, eventIds: [1] } }]);
    expect(algo.detect({ flag: false })).toEqual([]);
  });

  it("surfaces a syntax error the import source rejects with", async () => {
    const importSource: ImportSource = () =>
      Promise.reject(new SyntaxError("Unexpected identifier"));
    await expect(loadAlgorithm("this is not valid javascript !!!", importSource)).rejects.toThrow(
      SyntaxError,
    );
  });
});
