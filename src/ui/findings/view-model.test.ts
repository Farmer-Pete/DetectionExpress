import { describe, expect, it } from "vitest";
import { URGENT_HITS } from "../../game/tuning";
import type { LiveFinding } from "../../sim/correctness";
import type { Finding } from "../../sim/finding";
import {
  buildFindingGroups,
  countActiveHits,
  prettifyReason,
  stateLabel,
  urgentAnnouncement,
} from "./view-model";

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
  // A real anchor in BOTH the nested alert.eventIds and the top-level snapshot keeps the
  // fixture consistent; the no-subject branch still carries the now-required eventId.
  const finding: Finding =
    subjectType !== undefined
      ? { alert: { eventIds: [rest.seq], reason, at: 0 }, eventId: rest.seq, subjectType }
      : { alert: { eventIds: [rest.seq], reason, at: 0 }, eventId: rest.seq };
  const result: LiveFinding = {
    finding,
    state: rest.state ?? "hit",
    reason,
    eventIds: rest.eventIds ?? [rest.seq],
    at: rest.at ?? 0,
    seq: rest.seq,
    citedEvents: rest.citedEvents ?? [],
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

describe("stateLabel", () => {
  it("labels a hit as Alert, avoiding the raw 'hit' term (CONTEXT.md)", () => {
    expect(stateLabel("hit")).toBe("Alert");
  });

  it("labels a watch as Watching", () => {
    expect(stateLabel("watch")).toBe("Watching");
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
    expect(groups[1]?.entity).toBeNull();
    // Distinct keys, so the two solo findings never merge into one group.
    expect(groups[0]?.key).not.toBe(groups[1]?.key);
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

describe("buildFindingGroups key collisions", () => {
  it("does not merge a grouped finding with a solo finding whose old keys would collide", () => {
    const { groups } = buildFindingGroups(
      [
        // The old `${subjectType}::${entity}` key was `ungrouped::1` here...
        live({ seq: 2, subjectType: "ungrouped", entity: "1", state: "hit", reason: "r1" }),
        // ...and the old solo key `ungrouped::${seq}` was also `ungrouped::1` for seq 1.
        live({ seq: 1, state: "hit", reason: "r2" }),
      ],
      null,
    );
    expect(groups).toHaveLength(2);
  });

  it("keeps two groups apart when a value contains the old separator", () => {
    const { groups } = buildFindingGroups(
      [
        live({ seq: 1, subjectType: "a", entity: "b::c", state: "hit", reason: "r1" }),
        live({ seq: 2, subjectType: "a::b", entity: "c", state: "hit", reason: "r2" }),
      ],
      null,
    );
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.agreement)).toBe(true);
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

  it("breaks a hit-count tie by watch count", () => {
    const { groups } = buildFindingGroups(
      [
        // group a: 1 hit, 1 watch, more recent
        live({ seq: 1, subjectType: "account", entity: "a", reason: "r1", state: "hit", at: 9 }),
        live({ seq: 2, subjectType: "account", entity: "a", reason: "r2", state: "watch", at: 9 }),
        // group b: 1 hit, 2 watches -> more watches ranks it above a despite an older `at`
        live({ seq: 3, subjectType: "account", entity: "b", reason: "r1", state: "hit", at: 1 }),
        live({ seq: 4, subjectType: "account", entity: "b", reason: "r2", state: "watch", at: 1 }),
        live({ seq: 5, subjectType: "account", entity: "b", reason: "r3", state: "watch", at: 1 }),
      ],
      null,
    );
    expect(groups.map((g) => g.entity)).toEqual(["b", "a"]);
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

  it("carries the seq through unchanged for both watch and hit inputs", () => {
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

describe("countActiveHits (#38 juice item 3+4)", () => {
  it("counts zero and reads not urgent with no findings", () => {
    expect(countActiveHits([])).toEqual({ count: 0, urgent: false });
  });

  it("counts only hit-state findings, ignoring watches", () => {
    const findings = [
      live({ seq: 1, state: "hit" }),
      live({ seq: 2, state: "watch" }),
      live({ seq: 3, state: "hit" }),
    ];
    expect(countActiveHits(findings)).toEqual({ count: 2, urgent: false });
  });

  it("is not urgent one hit below URGENT_HITS", () => {
    const findings = Array.from({ length: URGENT_HITS - 1 }, (_, i) =>
      live({ seq: i + 1, state: "hit" }),
    );
    expect(countActiveHits(findings)).toEqual({ count: URGENT_HITS - 1, urgent: false });
  });

  it("flips urgent exactly at URGENT_HITS", () => {
    const findings = Array.from({ length: URGENT_HITS }, (_, i) =>
      live({ seq: i + 1, state: "hit" }),
    );
    expect(countActiveHits(findings)).toEqual({ count: URGENT_HITS, urgent: true });
  });

  it("stays urgent past URGENT_HITS", () => {
    const findings = Array.from({ length: URGENT_HITS + 2 }, (_, i) =>
      live({ seq: i + 1, state: "hit" }),
    );
    expect(countActiveHits(findings)).toEqual({ count: URGENT_HITS + 2, urgent: true });
  });
});

describe("urgentAnnouncement (GH38 review round 4, F002)", () => {
  it("is empty when not urgent", () => {
    expect(urgentAnnouncement(false)).toBe("");
  });

  it("is a complete phrase, with no leading comma, when urgent", () => {
    const text = urgentAnnouncement(true);
    expect(text).toBe("findings urgent");
    expect(text.startsWith(",")).toBe(false);
  });

  it("carries no live count, so it does not re-announce on every hit increment", () => {
    // A fixed phrase regardless of how many hits are urgent — the count lives
    // only in the visible "N active" text, never in the announcement. Asserting
    // the phrase carries no digit enforces that contract against any future
    // implementation, where comparing the pure call to itself never would.
    expect(urgentAnnouncement(true)).not.toMatch(/\d/);
  });

  it("names no CONTEXT.md Alert-avoid word (hit, detection, notification, flag)", () => {
    const text = urgentAnnouncement(true);
    expect(text.toLowerCase()).not.toMatch(/\bhits?\b|\bdetection\b|\bnotification\b|\bflag\b/);
  });
});
