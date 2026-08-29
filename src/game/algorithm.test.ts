import { describe, expect, it } from "vitest";
import { adaptModule, type ImportSource, loadAlgorithm } from "./algorithm";

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

describe("loadAlgorithm", () => {
  it("adapts the module returned by the injected import source", async () => {
    const importSource: ImportSource = () =>
      Promise.resolve({
        normalize: (r: { x: number }) => ({ u: r.x }),
        match: (event: { flag?: boolean }) =>
          event.flag ? { reason: "r", at: 1, events: [1] } : null,
      });
    const algo = await loadAlgorithm("ignored source", importSource);
    expect(algo.normalize({ x: 5 })).toEqual({ u: 5 });
    expect(algo.match({ flag: true })).toEqual({ reason: "r", at: 1, events: [1] });
    expect(algo.match({ flag: false })).toBeNull();
  });

  it("surfaces a syntax error the import source rejects with", async () => {
    const importSource: ImportSource = () =>
      Promise.reject(new SyntaxError("Unexpected identifier"));
    await expect(loadAlgorithm("this is not valid javascript !!!", importSource)).rejects.toThrow(
      SyntaxError,
    );
  });
});
