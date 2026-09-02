import { describe, expect, it } from "vitest";
import { world } from "../world/world";
import { controlReference } from "./control";

describe("controlReference", () => {
  it("lists at least one authorized console, each a login on its own OCC host", () => {
    expect(controlReference.consoles.length).toBeGreaterThan(0);
    for (const console of controlReference.consoles) {
      // A `line.disp` login, matching the sensor data's "green.disp" style.
      expect(console.operator).toMatch(/^[a-z]+\.disp$/);
      // A control-floor host id like OCC-3.
      expect(console.host).toMatch(/^OCC-\d+$/);
    }
    // Distinct consoles: each host is seated by exactly one operator fixture.
    const hosts = controlReference.consoles.map((console) => console.host);
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it("offers only benign control-room commands (no rider-DB or signal override)", () => {
    expect(controlReference.commands.length).toBeGreaterThan(0);
    for (const entry of controlReference.commands) {
      // The curated benign verbs; the attack commands are out of scope for M6.
      expect(["STATUS", "REFRESH", "EXPORT"]).toContain(entry.command);
      expect(entry.target.length).toBeGreaterThan(0);
      // No benign command touches the rider database (the Dispatcher Overreach target).
      expect(entry.target).not.toMatch(/RIDER/i);
    }
  });

  it("lists one network host per real staff site, on the backbone", () => {
    const siteIds = new Set(world.sites.map((site) => site.id));
    expect(controlReference.hosts.length).toBeGreaterThan(0);
    for (const host of controlReference.hosts) {
      // The host sits at a REAL site from the world data, never a fabricated location.
      expect(siteIds.has(host.site)).toBe(true);
      expect(host.host.length).toBeGreaterThan(0);
    }
    const sites = controlReference.hosts.map((host) => host.site);
    expect(new Set(sites).size).toBe(sites.length);
  });

  it("relays only to internal destinations, never an external address", () => {
    expect(controlReference.destinations.length).toBeGreaterThan(0);
    for (const dest of controlReference.destinations) {
      expect(dest.length).toBeGreaterThan(0);
      // Benign backbone traffic stays internal; no external `ext-` address.
      expect(dest).not.toMatch(/^ext-/);
    }
  });

  it("bounds benign transfers to a small positive whole-byte range", () => {
    const { min, max } = controlReference.byteRange;
    expect(Number.isInteger(min)).toBe(true);
    expect(Number.isInteger(max)).toBe(true);
    expect(min).toBeGreaterThan(0);
    expect(max).toBeGreaterThan(min);
  });
});
