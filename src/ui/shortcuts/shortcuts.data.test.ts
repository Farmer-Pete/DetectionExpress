import { describe, expect, it } from "vitest";
import { assignedKey, kbdGlyph, RESERVED, type Scope, SHORTCUTS } from "./shortcuts.data";

// Every `Scope` member, spelled out explicitly rather than derived from
// `Object.keys(SHORTCUTS)` (which TypeScript can only type as `string[]`) — this keeps
// the invariant sweep below fully typed with no cast, at the cost of needing a new
// entry here alongside `shortcuts.data.ts` whenever a `Scope` is added.
const SCOPES: readonly Scope[] = [
  "shell",
  "sidepanel:chaos",
  "sidepanel:algorithm",
  "sidepanel:options",
  "mapDialog:event",
  "mapDialog:place",
  "trace",
  "legend",
  "hireMe",
];

describe("assignedKey", () => {
  it("returns the key for a known (scope, id) pair", () => {
    expect(assignedKey("shell", "menu")).toBe("M");
    expect(assignedKey("shell", "freeze")).toBe(" ");
  });

  it("returns undefined for an id not declared in that scope", () => {
    expect(assignedKey("shell", "nope")).toBeUndefined();
  });
});

describe("kbdGlyph", () => {
  it("renders Space for the literal space key", () => {
    expect(kbdGlyph(" ")).toBe("Space");
  });

  it("renders Esc for Escape", () => {
    expect(kbdGlyph("Escape")).toBe("Esc");
  });

  it("passes a plain letter or digit through unchanged", () => {
    expect(kbdGlyph("M")).toBe("M");
    expect(kbdGlyph("1")).toBe("1");
  });
});

describe("SHORTCUTS invariants (every declared scope)", () => {
  it.each(SCOPES)("%s: no two keys collide, case-insensitively", (scope) => {
    const keys = SHORTCUTS[scope].map((entry) => entry.key.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(SCOPES)("%s: every RESERVED-key entry carries dispatch: false", (scope) => {
    for (const entry of SHORTCUTS[scope]) {
      if (RESERVED.has(entry.key)) {
        expect(entry.dispatch).toBe(false);
      }
    }
  });

  it.each(SCOPES)("%s: every entry has a non-empty id and label", (scope) => {
    for (const entry of SHORTCUTS[scope]) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });
});

describe("the shell inventory (GH137-PLAN.md M1 + M2)", () => {
  it("carries exactly the shell command set: menu, freeze, three speeds, findings-more, legend-open, hire-me-open", () => {
    const ids = SHORTCUTS.shell.map((entry) => entry.id).sort();
    expect(ids).toEqual(
      [
        "findings-more",
        "freeze",
        "menu",
        "speed-0.5x",
        "speed-1x",
        "speed-2x",
        "legend-open",
        "hire-me-open",
      ].sort(),
    );
  });

  it("assigns Freeze the Space key as badge-only (dispatch: false)", () => {
    const freeze = SHORTCUTS.shell.find((entry) => entry.id === "freeze");
    expect(freeze?.key).toBe(" ");
    expect(freeze?.dispatch).toBe(false);
  });

  it("assigns the three speeds 1/2/3 in ascending order", () => {
    expect(assignedKey("shell", "speed-0.5x")).toBe("1");
    expect(assignedKey("shell", "speed-1x")).toBe("2");
    expect(assignedKey("shell", "speed-2x")).toBe("3");
  });

  it("assigns Menu M and Findings-more F", () => {
    expect(assignedKey("shell", "menu")).toBe("M");
    expect(assignedKey("shell", "findings-more")).toBe("F");
  });

  it("assigns Show legend L and Hire me H (GH137-PLAN.md M2)", () => {
    expect(assignedKey("shell", "legend-open")).toBe("L");
    expect(assignedKey("shell", "hire-me-open")).toBe("H");
  });
});

describe("the M2 composite scopes (GH137-PLAN.md M2)", () => {
  it("sidepanel:algorithm carries close, reset, and apply", () => {
    const ids = SHORTCUTS["sidepanel:algorithm"].map((entry) => entry.id).sort();
    expect(ids).toEqual(["apply", "close", "reset"].sort());
    expect(assignedKey("sidepanel:algorithm", "reset")).toBe("R");
    expect(assignedKey("sidepanel:algorithm", "apply")).toBe("A");
  });

  it("sidepanel:options carries close, retake-tour, and map-toggle", () => {
    expect(assignedKey("sidepanel:options", "retake-tour")).toBe("T");
    expect(assignedKey("sidepanel:options", "map-toggle")).toBe("P");
  });

  it("mapDialog:event carries back, close, and open-place", () => {
    expect(assignedKey("mapDialog:event", "back")).toBe("B");
    expect(assignedKey("mapDialog:event", "open-place")).toBe("O");
    const close = SHORTCUTS["mapDialog:event"].find((entry) => entry.id === "close");
    expect(close?.dispatch).toBe(false);
  });

  it("mapDialog:place carries back and close only (no open-place)", () => {
    expect(assignedKey("mapDialog:place", "back")).toBe("B");
    expect(assignedKey("mapDialog:place", "open-place")).toBeUndefined();
  });

  it("legend carries only a badge-only close", () => {
    const close = SHORTCUTS.legend.find((entry) => entry.id === "close");
    expect(close?.key).toBe("Escape");
    expect(close?.dispatch).toBe(false);
  });

  it("hireMe carries hire-me-close (H) and a badge-only dismiss (Escape)", () => {
    expect(assignedKey("hireMe", "hire-me-close")).toBe("H");
    const dismiss = SHORTCUTS.hireMe.find((entry) => entry.id === "dismiss");
    expect(dismiss?.dispatch).toBe(false);
  });

  it("the Hire me toggle's H lives in two different scopes (shell open, hireMe close), never colliding", () => {
    expect(assignedKey("shell", "hire-me-open")).toBe("H");
    expect(assignedKey("hireMe", "hire-me-close")).toBe("H");
  });
});
