import { describe, expect, it } from "vitest";
import { nextBacklog } from "./index";

describe("nextBacklog", () => {
  it("grows when arrivals beat throughput", () => {
    expect(nextBacklog(0, 10, 4)).toBe(6);
  });

  it("never drops below zero", () => {
    expect(nextBacklog(2, 1, 10)).toBe(0);
  });
});
