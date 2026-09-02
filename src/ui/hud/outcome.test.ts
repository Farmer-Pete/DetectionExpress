import { describe, expect, it } from "vitest";
import { outcomeText } from "./outcome";

describe("outcomeText", () => {
  it("reads Running while the run is in progress", () => {
    expect(outcomeText("running", null)).toBe("Running");
  });

  it("reads Won once the run succeeds", () => {
    expect(outcomeText("won", null)).toBe("Won");
  });

  it("reads the queue failure reason", () => {
    expect(outcomeText("failed", "queue")).toBe("Failed: Queue overflowed");
  });

  it("reads the correctness failure reason", () => {
    expect(outcomeText("failed", "correctness")).toBe("Failed: Correctness too low");
  });

  it("falls back to a bare Failed when no reason is set", () => {
    expect(outcomeText("failed", null)).toBe("Failed");
  });
});
