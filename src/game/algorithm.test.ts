import { describe, expect, it } from "bun:test";
import { loadAlgorithm } from "./algorithm";

describe("loadAlgorithm", () => {
  it("returns a working match and defaults normalize to identity when absent", async () => {
    const algo = await loadAlgorithm(
      `export function match(e){ return e.flag ? { reason: "r", at: 1, events: [1] } : null; }`,
    );
    expect(algo.match instanceof Function).toBe(true);
    expect(algo.normalize("passthrough")).toBe("passthrough"); // identity default
    expect(algo.match({ flag: true })).toEqual({ reason: "r", at: 1, events: [1] });
    expect(algo.match({ flag: false })).toBeNull();
  });

  it("uses the module's normalize when it exports one", async () => {
    const algo = await loadAlgorithm(
      `export function normalize(r){ return { u: r.x }; } export function match(){ return null; }`,
    );
    expect(algo.normalize({ x: 5 })).toEqual({ u: 5 });
  });

  it("rejects a module that exports no match function", async () => {
    await expect(loadAlgorithm(`export const nope = 1;`)).rejects.toThrow(/match/i);
  });

  it("surfaces a syntax error", async () => {
    await expect(loadAlgorithm(`this is not valid javascript !!!`)).rejects.toThrow();
  });

  it("revokes the object URL it created after the import", async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob | MediaSource): string => {
      const url = realCreate.call(URL, blob);
      created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string): void => {
      revoked.push(url);
      realRevoke.call(URL, url);
    };
    try {
      await loadAlgorithm(`export function match(){ return null; }`);
    } finally {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    }
    expect(created).toHaveLength(1);
    expect(revoked).toEqual(created); // exactly the URL it created, revoked
  });
});
