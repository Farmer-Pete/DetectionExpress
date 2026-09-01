/**
 * The immutable scenario blueprint seam (GH117-PLAN.md "Part A"). Exercised
 * through `pinBruteForce`'s concrete `buildBlueprint`, the one `ScenarioSpec` this
 * codebase has today.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Attack } from "./attack";
import type { PipeEvent } from "./event";
import { buildBlueprint } from "./scenarios/pin-brute-force/scenario";
import { distanceTable } from "./world/distance";
import { buildTimetable } from "./world/timetable";
import { world } from "./world/world";
import type { WorldEnv } from "./world-reading";

/** Canonicalize a run's scored output the same way for hashing and comparison. */
function canonical(run: { events: readonly PipeEvent[]; attacks: readonly Attack[] }): string {
  return JSON.stringify({ events: run.events, attacks: run.attacks });
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Independent oracle for the parity sweep below: SHA-256 digests of
 * `{ events, attacks }` captured from `pinBruteForce.generate(seed)` BEFORE this
 * step's refactor touched `compose-scenario.ts`, `cast.ts`, or `scenario.ts`
 * (via a throwaway script run against the pre-refactor tree). Frozen here, never
 * recomputed from the code under test — the same discipline `actor.test.ts` uses
 * for its "frozen copy of the pre-heap linear scan" oracle. A hash, not a full
 * fixture, because the run's event count makes a literal fixture unwieldy while
 * SHA-256 still catches any single-byte divergence: a wrong id, a shifted
 * timestamp, a reordered event, a changed threshold.
 */
const GOLDEN_HASH_BY_SEED: Readonly<Record<number, string>> = {
  0: "8694cd06585c3c22867d4c0236fae1867a87ded2f54bb160725a5969280a7795",
  1: "a6355ce577e8a3ff3735d17674cab3f112c08d1e30197b995374bc2ce4068108",
  2: "4e0e44147527d29245119665a103827406e0f643bb472e6cc8ba5975d4225509",
  3: "ccfa491d8d6b2ea455ba76a6203440148aeba67e42a2064f38bbc918f0a686bb",
  4: "c99bd67e888ae5a57fcac416be6af2be0feff4aeaa512c96ad80fa83333ba0a0",
  5: "64b39e920dddd2364cd372d54f385de7813c09d388c4878d71d2d4b6464fc114",
  6: "79b9a8b730b3163a79b90b007a83d9604a5bc2132fb1c51ea942b519c66231b5",
  7: "d49f79edf29250a1d54dad91af61ac375ba2e39cad1b508e636c4d70215295df",
  8: "895bb1115514d2127c6178c4acc6389d97cc8672dbae1a86b5efe842fe8c0c32",
  9: "f3492433c4c517f5b0f1ad0ba8d158eed764da55e83b008d57688a68a17f401d",
  10: "745a042c3e2a0c6b57eb06ab6fe8b106a9589e205e700d843113f59bc2d18f6c",
  42: "0d8786e0a53190a8129c2d1986db4b01bad251755d7752a7a227a725b65bbc2c",
  99: "e7ff669b26317f0715b1f9fd778fb4c1c2adc8038c2a45023dc7f71785b4a50a",
  123: "7d406dcaf7a8aaa723a097583761de6388ffa07197935f7d2ad510c31e16cc67",
  777: "0d0b75b00aea77dd3ed195d3c1dda47dab7c1cf66e4d490242dfdf7e413f5b64",
  1000: "41e57ffa6b45332c63929a06f70dca7fbce3ed1c459a3b824d7e42572b37187a",
  2026: "6fe6863f7b4ebefd4be47e7541313456c52d55572d2a8b02f2c08b03ff70b6e8",
  4242: "913c5973a777d54a9d9cda0e4264505c0ce0201024be857c9634c3e184f6dfd4",
  9999: "773131d0d4e7f71e572e84f6028927b03fc987c0699aff60798ec444281cfac8",
  10000: "598e5fccc5cd11bccd20265711968e4daa9d54ac2d0af87f1a96ca410566c765",
  31415: "46c0bd667d950cc7f990c9e5df0ef62712feef7b2c2ebf6f1b120b515a9b82a6",
  55555: "d5d26b047fb7344a6d732385ccadb66d6c1b98d2db5099d24478302f4529529e",
  99991: "316a3aaf3c198928d5affcec76c2ea337022865d3ee2a9b9d740ee089a4dcf03",
  123456: "f5e0fd374b0140503e5bd2eb4bf2eee06fdf3f875c8d898b88ba18c1ec15aaef",
  654321: "2e3392d5dd4c8766f3fdd0ed40168336cd9ce1f85c2528bd33e9cc315632a764",
  1000003: "5e8c2e2d4705b3212e44e45b11c2e6185771f96d6ce27f814319c9d1311764ac",
};

describe("buildBlueprint precomposed-run parity (GH117-PLAN.md Part A, parity guard 1)", () => {
  const seeds = Object.keys(GOLDEN_HASH_BY_SEED).map(Number);

  it("covers at least 24 seeds", () => {
    expect(seeds.length).toBeGreaterThanOrEqual(24);
  });

  it.each(seeds)(
    "matches the pre-refactor Scenario.generate output exactly for seed %i",
    (seed) => {
      const blueprint = buildBlueprint(seed);
      const digest = sha256(canonical(blueprint.precomposed));
      const expected = GOLDEN_HASH_BY_SEED[seed];
      expect(expected).toBeDefined();
      expect(digest).toBe(expected);
    },
  );
});

describe("buildBlueprint descriptors", () => {
  it("tags every scenario descriptor as scored-scenario provenance", () => {
    const blueprint = buildBlueprint(42);
    expect(blueprint.descriptors.length).toBeGreaterThan(0);
    for (const descriptor of blueprint.descriptors) {
      expect(descriptor.provenance).toBe("scored-scenario");
    }
  });

  it("carries an initialPresence factory that places each descriptor at a station", () => {
    const blueprint = buildBlueprint(42);
    for (const descriptor of blueprint.descriptors) {
      const presence = descriptor.initialPresence(7);
      expect(presence.kind).toBe("at");
      if (presence.kind === "at") {
        expect(presence.fromTick).toBe(7);
        expect(presence.untilTick).toBe(7);
        expect(presence.node.length).toBeGreaterThan(0);
      }
    }
  });

  it("carries the actorId -> attackId labels and the waves/checkpoints alongside the descriptors", () => {
    const blueprint = buildBlueprint(42);
    expect(blueprint.labels.size).toBeGreaterThan(0);
    expect(blueprint.waves.length).toBeGreaterThan(0);
    expect(blueprint.checkpoints.length).toBeGreaterThan(0);
  });
});

describe("buildBlueprint instantiate()", () => {
  it("builds one actor per descriptor, with a stable id order across calls", () => {
    const blueprint = buildBlueprint(42);
    const first = blueprint.instantiate();
    const second = blueprint.instantiate();
    expect(first).toHaveLength(blueprint.descriptors.length);
    expect(second.map((a) => a.id)).toEqual(first.map((a) => a.id));
  });

  it("shares no mutable state across two instantiations", () => {
    const blueprint = buildBlueprint(42);
    const rng = (): number => 0.5;
    // Neither the PIN attacker nor the account rider reads `env` in `act`, but a
    // real one keeps this test honestly typed rather than asserting the type away.
    const env: WorldEnv = {
      world,
      distances: distanceTable(world),
      timetable: buildTimetable(world),
    };

    const first = blueprint.instantiate();
    const second = blueprint.instantiate();

    // Drive every actor in the FIRST cast through two transitions each, mutating
    // its internal phase.
    for (const actor of first) {
      let tick = actor.start({ rng });
      for (let step = 0; step < 2 && tick !== "dormant"; step++) {
        tick = actor.act({ env, rng, tick }).nextTick;
      }
    }

    // A THIRD, never-touched cast is the independent "what a fresh actor does"
    // oracle. The SECOND cast (also never touched) must match it exactly on its
    // first transition — proof that driving the FIRST cast left no mark on it.
    const third = blueprint.instantiate();
    for (let i = 0; i < second.length; i++) {
      const secondActor = second[i];
      const thirdActor = third[i];
      if (secondActor === undefined || thirdActor === undefined) {
        continue;
      }
      const tick = secondActor.start({ rng });
      expect(tick).toBe(thirdActor.start({ rng }));
      if (tick !== "dormant") {
        expect(secondActor.act({ env, rng, tick })).toEqual(thirdActor.act({ env, rng, tick }));
      }
    }
  });
});
