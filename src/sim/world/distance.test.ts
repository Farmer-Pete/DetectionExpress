import { describe, expect, it } from "vitest";
import { distanceMinutes, distanceTable, sharedLineRoute } from "./distance";
import { world } from "./world";

const table = distanceTable(world);

describe("distanceMinutes", () => {
  it("is zero on the diagonal", () => {
    expect(distanceMinutes(table, "cen", "cen")).toBe(0);
    expect(distanceMinutes(table, "end", "end")).toBe(0);
  });

  it("is symmetric", () => {
    expect(distanceMinutes(table, "har", "end")).toBe(distanceMinutes(table, "end", "har"));
    expect(distanceMinutes(table, "sum", "bay")).toBe(distanceMinutes(table, "bay", "sum"));
  });

  it("matches hand-checked shortest paths", () => {
    // har-mkt (3) + mkt-cen (2) = 5.
    expect(distanceMinutes(table, "har", "cen")).toBe(5);
    // har-mkt (3) + mkt-cen (2) + cen-riv (3) + riv-end (4) = 12.
    expect(distanceMinutes(table, "har", "end")).toBe(12);
    // sum-jct (5) + jct-cen (3) = 8.
    expect(distanceMinutes(table, "sum", "cen")).toBe(8);
  });

  it("throws on an unknown station", () => {
    expect(() => distanceMinutes(table, "zzz", "cen")).toThrow(/unknown station/);
    expect(() => distanceMinutes(table, "cen", "zzz")).toThrow(/unknown station/);
  });
});

describe("sharedLineRoute", () => {
  it("returns the line and its ride minutes for an adjacent pair", () => {
    expect(sharedLineRoute(world, "har", "mkt")).toEqual({ minutes: 3, line: "red" });
    expect(sharedLineRoute(world, "cen", "riv")).toEqual({ minutes: 3, line: "red" });
  });

  it("rides a multi-stop single line and sums its minutes", () => {
    // har-mkt (3) + mkt-cen (2) along red.
    expect(sharedLineRoute(world, "har", "cen")).toEqual({ minutes: 5, line: "red" });
  });

  it("picks the lowest line id on a pair that shares more than one", () => {
    // Central and Market share red and blue; blue sorts first.
    expect(sharedLineRoute(world, "cen", "mkt")).toEqual({ minutes: 2, line: "blue" });
  });

  it("returns null on a pair that shares no line", () => {
    expect(sharedLineRoute(world, "har", "bay")).toBeNull();
    expect(sharedLineRoute(world, "sum", "bay")).toBeNull();
  });

  it("throws on an unknown station", () => {
    expect(() => sharedLineRoute(world, "zzz", "cen")).toThrow(/unknown station/);
  });
});
