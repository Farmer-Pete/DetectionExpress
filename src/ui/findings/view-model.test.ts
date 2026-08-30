import { describe, expect, it } from "vitest";
import type { LiveFinding } from "../../sim/correctness";
import type { Finding } from "../../sim/finding";
import { buildFindingGroups, prettifyReason } from "./view-model";

/**
 * Build a LiveFinding fixture. `subjectType` lands on the emitted Finding (an
 * Anchored one when present), so the view model can key the group on the pair
 * `(subjectType, entity)`. An entity-less finding omits both.
 */
function live(
  over: Partial<LiveFinding> & { seq: number } & {
    subjectType?: string;
  },
): LiveFinding {
  const { subjectType, ...rest } = over;
  const reason = rest.reason ?? "pin_brute_force";
  const finding: Finding =
    subjectType !== undefined
      ? { alert: { eventIds: [], reason, at: 0 }, eventId: rest.seq, subjectType }
      : { alert: { eventIds: [], reason, at: 0 } };
  const result: LiveFinding = {
    finding,
    state: rest.state ?? "hit",
    reason,
    eventIds: rest.eventIds ?? [rest.seq],
    at: rest.at ?? 0,
    seq: rest.seq,
  };
  // `exactOptionalPropertyTypes`: only set `entity` when present, never to `undefined`.
  if (rest.entity !== undefined) {
    result.entity = rest.entity;
  }
  return result;
}

describe("prettifyReason", () => {
  it("turns a snake_case token into a sentence", () => {
    expect(prettifyReason("pin_brute_force")).toBe("Pin brute force");
  });

  it("splits camelCase into words", () => {
    expect(prettifyReason("pinBruteForce")).toBe("Pin brute force");
  });

  it("leaves an already-clean single word sentence-cased", () => {
    expect(prettifyReason("tailgating")).toBe("Tailgating");
  });
});

describe("buildFindingGroups grouping", () => {
  it("groups two findings on the same (subjectType, entity) into one group", () => {
    const { groups } = buildFindingGroups(
      [
        live({ seq: 1, subjectType: "account", entity: "acct-7", reason: "pin_brute_force" }),
        live({ seq: 2, subjectType: "account", entity: "acct-7", reason: "impossible_travel" }),
      ],
      null,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows).toHaveLength(2);
    expect(groups[0]?.entity).toBe("acct-7");
    expect(groups[0]?.entityKind).toBe("account");
  });

  it("keeps the same entity value under two subject types in separate groups", () => {
    const { groups } = buildFindingGroups(
      [
        live({ seq: 1, subjectType: "account", entity: "1234", reason: "pin_brute_force" }),
        live({ seq: 2, subjectType: "card", entity: "1234", reason: "cloned_card" }),
      ],
      null,
    );
    expect(groups).toHaveLength(2);
  });

  it("renders each entity-less finding as its own solo group", () => {
    const { groups } = buildFindingGroups(
      [live({ seq: 1, reason: "pin_brute_force" }), live({ seq: 2, reason: "pin_brute_force" })],
      null,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]?.entity).toBeNull();
    expect(groups[0]?.key).toBe("ungrouped::1");
    expect(groups[1]?.key).toBe("ungrouped::2");
  });
});

describe("buildFindingGroups agreement", () => {
  it("marks agreement when a group has two distinct hit reasons", () => {
    const { groups } = buildFindingGroups(
      [
        live({ seq: 1, subjectType: "account", entity: "a", reason: "pin_brute_force" }),
        live({ seq: 2, subjectType: "account", entity: "a", reason: "impossible_travel" }),
      ],
      null,
    );
    expect(groups[0]?.agreement).toBe(true);
  });

  it("does not mark agreement for the same hit reason twice", () => {
    const { groups } = buildFindingGroups(
      [
        live({ seq: 1, subjectType: "account", entity: "a", reason: "pin_brute_force" }),
        live({ seq: 2, subjectType: "account", entity: "a", reason: "pin_brute_force" }),
      ],
      null,
    );
    expect(groups[0]?.agreement).toBe(false);
  });

  it("does not count a watch toward agreement", () => {
    const { groups } = buildFindingGroups(
      [
        live({
          seq: 1,
          subjectType: "account",
          entity: "a",
          reason: "pin_brute_force",
          state: "hit",
        }),
        live({
          seq: 2,
          subjectType: "account",
          entity: "a",
          reason: "impossible_travel",
          state: "watch",
        }),
      ],
      null,
    );
    expect(groups[0]?.agreement).toBe(false);
  });
});

describe("buildFindingGroups ranking", () => {
  it("orders by hit count, then watch count, then recency", () => {
    const { groups } = buildFindingGroups(
      [
        // group a: 1 hit, at 5
        live({ seq: 1, subjectType: "account", entity: "a", state: "hit", at: 5 }),
        // group b: 2 hits
        live({ seq: 2, subjectType: "account", entity: "b", reason: "r1", state: "hit", at: 1 }),
        live({ seq: 3, subjectType: "account", entity: "b", reason: "r2", state: "hit", at: 2 }),
        // group c: 1 hit, at 9 (more recent than a)
        live({ seq: 4, subjectType: "account", entity: "c", state: "hit", at: 9 }),
      ],
      null,
    );
    expect(groups.map((g) => g.entity)).toEqual(["b", "c", "a"]);
  });

  it("sorts hits above watches within a group", () => {
    const { groups } = buildFindingGroups(
      [
        live({ seq: 1, subjectType: "account", entity: "a", state: "watch", reason: "r_watch" }),
        live({ seq: 2, subjectType: "account", entity: "a", state: "hit", reason: "r_hit" }),
      ],
      null,
    );
    expect(groups[0]?.rows.map((r) => r.state)).toEqual(["hit", "watch"]);
  });
});

describe("buildFindingGroups cap and pin", () => {
  function manyHitGroups(count: number): LiveFinding[] {
    // Each group is a distinct entity with a descending `at`, so rank == input order.
    return Array.from({ length: count }, (_, i) =>
      live({ seq: i + 1, subjectType: "account", entity: `e${i}`, at: count - i }),
    );
  }

  it("returns all ranked groups and reports the hidden count past 12", () => {
    const { groups, hiddenCount } = buildFindingGroups(manyHitGroups(15), null);
    expect(groups).toHaveLength(15);
    expect(hiddenCount).toBe(3);
  });

  it("reports zero hidden when at or under the cap", () => {
    const { hiddenCount } = buildFindingGroups(manyHitGroups(12), null);
    expect(hiddenCount).toBe(0);
  });

  it("pins the selected group into the first 12 even when it ranks past the cap", () => {
    const findings = manyHitGroups(15);
    // seq 15 is the lowest-ranked group (smallest `at`), so it ranks last by default.
    const { groups } = buildFindingGroups(findings, 15);
    const visible = groups.slice(0, 12);
    expect(visible.some((g) => g.rows.some((r) => r.seq === 15))).toBe(true);
  });
});

describe("buildFindingGroups row shape", () => {
  it("carries the prettified label, raw reason, and cited count on a row", () => {
    const { groups } = buildFindingGroups(
      [
        live({
          seq: 1,
          subjectType: "account",
          entity: "a",
          reason: "pin_brute_force",
          eventIds: [10, 11, 12],
        }),
      ],
      null,
    );
    const row = groups[0]?.rows[0];
    expect(row?.label).toBe("Pin brute force");
    expect(row?.reason).toBe("pin_brute_force");
    expect(row?.citedCount).toBe(3);
  });

  it("keeps the same seq when a watch promotes to a hit", () => {
    const watch = buildFindingGroups(
      [live({ seq: 4, subjectType: "account", entity: "a", state: "watch" })],
      null,
    );
    expect(watch.groups[0]?.rows[0]?.seq).toBe(4);
    const hit = buildFindingGroups(
      [live({ seq: 4, subjectType: "account", entity: "a", state: "hit" })],
      null,
    );
    expect(hit.groups[0]?.rows[0]?.seq).toBe(4);
    expect(hit.groups[0]?.rows[0]?.state).toBe("hit");
  });
});
