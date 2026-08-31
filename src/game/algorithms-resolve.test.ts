import { describe, expect, it } from "vitest";
import {
  buildChangedFrame,
  createVersionCounter,
  DEFAULT_ENGINE_PATH,
  isValidAlgorithmSlug,
  localAlgorithmUrl,
  overridePath,
  resolveActiveFile,
  selectActiveFile,
} from "./algorithms-resolve";

describe("isValidAlgorithmSlug", () => {
  it("accepts lowercase letters, digits, and hyphens up to 64 chars", () => {
    expect(isValidAlgorithmSlug("pin-brute-force")).toBe(true);
    expect(isValidAlgorithmSlug("a")).toBe(true);
    expect(isValidAlgorithmSlug("a1-b2-c3")).toBe(true);
    expect(isValidAlgorithmSlug("x".repeat(64))).toBe(true);
  });

  it("rejects the empty slug", () => {
    expect(isValidAlgorithmSlug("")).toBe(false);
  });

  it("rejects a slug longer than 64 chars", () => {
    expect(isValidAlgorithmSlug("x".repeat(65))).toBe(false);
  });

  it("rejects uppercase, spaces, and underscores", () => {
    expect(isValidAlgorithmSlug("Kiosk")).toBe(false);
    expect(isValidAlgorithmSlug("kiosk pin")).toBe(false);
    expect(isValidAlgorithmSlug("kiosk_pin")).toBe(false);
  });

  it("rejects traversal strings and path separators", () => {
    expect(isValidAlgorithmSlug("../secret")).toBe(false);
    expect(isValidAlgorithmSlug("..")).toBe(false);
    expect(isValidAlgorithmSlug("a/b")).toBe(false);
    expect(isValidAlgorithmSlug("a.ts")).toBe(false);
    expect(isValidAlgorithmSlug("/etc/passwd")).toBe(false);
  });
});

describe("resolveActiveFile", () => {
  it("resolves to the override when it exists", () => {
    const path = resolveActiveFile("kiosk", () => true);
    expect(path).toBe("/src/algorithms/kiosk.ts");
  });

  it("resolves to the default engine when the override is missing", () => {
    const path = resolveActiveFile("kiosk", () => false);
    expect(path).toBe(DEFAULT_ENGINE_PATH);
  });

  it("returns null and never calls exists for an invalid slug", () => {
    let touched = false;
    const path = resolveActiveFile("../escape", () => {
      touched = true;
      return true;
    });
    expect(path).toBeNull();
    expect(touched).toBe(false); // an invalid slug never triggers a filesystem read
  });

  it("passes the exact slug to the exists predicate", () => {
    const seen: string[] = [];
    resolveActiveFile("pin-brute-force", (slug) => {
      seen.push(slug);
      return false;
    });
    expect(seen).toEqual(["pin-brute-force"]);
  });
});

describe("selectActiveFile", () => {
  it("mirrors resolveActiveFile for the boolean-input form", () => {
    expect(selectActiveFile("kiosk", true)).toBe(overridePath("kiosk"));
    expect(selectActiveFile("kiosk", false)).toBe(DEFAULT_ENGINE_PATH);
    expect(selectActiveFile("../escape", true)).toBeNull();
    expect(selectActiveFile("", false)).toBeNull();
  });
});

describe("buildChangedFrame", () => {
  it("carries the slug, path, and version", () => {
    expect(buildChangedFrame("kiosk", "/src/algorithms/kiosk.ts", 7)).toEqual({
      slug: "kiosk",
      path: "/src/algorithms/kiosk.ts",
      version: 7,
    });
  });
});

describe("localAlgorithmUrl", () => {
  it("appends the cache-busting version query", () => {
    expect(localAlgorithmUrl("/src/algorithms/kiosk.ts", 3)).toBe("/src/algorithms/kiosk.ts?v=3");
  });
});

describe("createVersionCounter", () => {
  it("starts at 0 and pre-increments on each bump", () => {
    const version = createVersionCounter();
    expect(version.current()).toBe(0);
    expect(version.bump()).toBe(1);
    expect(version.bump()).toBe(2);
    expect(version.current()).toBe(2);
  });
});
