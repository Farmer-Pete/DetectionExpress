import { describe, expect, it } from "vitest";
import { SEVERITY_DANGER_FRAC, SEVERITY_WARN_FRAC } from "../../game/tuning";
import { severityFill, severityLevel } from "./severity";

describe("severityLevel", () => {
  it("reads ok below the warn threshold", () => {
    expect(severityLevel(0)).toBe("ok");
    expect(severityLevel(SEVERITY_WARN_FRAC - 0.01)).toBe("ok");
  });

  it("reads warn from the warn threshold up to (not including) the danger threshold", () => {
    expect(severityLevel(SEVERITY_WARN_FRAC)).toBe("warn");
    expect(severityLevel(SEVERITY_DANGER_FRAC - 0.01)).toBe("warn");
  });

  it("reads danger from the danger threshold and above", () => {
    expect(severityLevel(SEVERITY_DANGER_FRAC)).toBe("danger");
    expect(severityLevel(1)).toBe("danger");
  });
});

describe("severityFill", () => {
  it("matches severityLevel at the same thresholds", () => {
    expect(severityFill(0)).toBe("var(--ok)");
    expect(severityFill(SEVERITY_WARN_FRAC)).toBe("var(--alert)");
    expect(severityFill(SEVERITY_DANGER_FRAC)).toBe("var(--threat)");
  });
});
