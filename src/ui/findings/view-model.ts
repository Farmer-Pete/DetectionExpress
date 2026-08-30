/**
 * The findings view model. It turns the flat, seq-ordered `LiveFinding[]` the sim
 * publishes into the ranked, grouped view the panel renders. Pure and total, so it
 * tests with no DOM, and it is the sole home for the UI-only concerns of grouping,
 * ranking, and display prettification. The sim never sees any of this.
 */
import type { LiveFinding } from "../../sim/correctness";

/** One finding, shaped for a row. */
export interface FindingRow {
  /** Stable insertion id; selection keys on it. */
  seq: number;
  /** "watch" for a partial, "hit" for a final. */
  state: "hit" | "watch";
  /** The prettified reason, for display. */
  label: string;
  /** The raw reason token, for the hunt key and agreement. */
  reason: string;
  /** How many Events the finding cites. */
  citedCount: number;
}

/** One entity's findings, or a single entity-less finding rendered solo. */
export interface FindingGroup {
  /** Grouped: `${subjectType}::${entity}`. Solo: `ungrouped::${seq}`. */
  key: string;
  /** The resolved entity, or null for an entity-less OneShot. */
  entity: string | null;
  /** The subjectType, when present, for the entity chip. */
  entityKind?: string;
  /** Rows: hits first, then watches, otherwise in seq order. */
  rows: FindingRow[];
  /** True when the group has two or more distinct hit reasons on the entity. */
  agreement: boolean;
  /** Count of hit rows, the primary rank key. */
  hitCount: number;
  /** The most recent emission time across the group, the tie-break rank key. */
  latestAt: number;
}

/** The ranked groups plus the count the panel hides behind "+N more". */
export interface GroupedFindings {
  /** ALL ranked groups; the selected finding's group pinned into the first 12. */
  groups: FindingGroup[];
  /** `max(0, groups.length - 12)`, for the "+N more" line. */
  hiddenCount: number;
}

/** The panel shows this many groups before the "+N more" line. */
const VISIBLE_CAP = 12;

/**
 * Prettify a raw reason token for display. Splits on `_` and camelCase boundaries,
 * then sentence-cases the result. `pin_brute_force` -> `Pin brute force`. Pure and
 * total: an empty or already-clean token comes back sentence-cased.
 */
export function prettifyReason(reason: string): string {
  const words = reason
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
  if (words.length === 0) {
    return "";
  }
  const [first, ...rest] = words;
  const head = first ?? "";
  return [head.charAt(0).toUpperCase() + head.slice(1), ...rest].join(" ");
}

/** A group under construction, before its rows settle into hit-first order. */
interface Draft {
  key: string;
  entity: string | null;
  entityKind?: string;
  findings: LiveFinding[];
}

/**
 * Group findings by `(subjectType, entity)`, rank the groups, and report how many
 * fall past the visible cap. Keying on the pair, not the entity alone, keeps two
 * subject domains that resolve the same value apart, so agreement never fires across
 * them. An entity-less finding gets a unique `ungrouped::${seq}` key, so it renders
 * solo and no live finding is ever dropped or merged away.
 *
 * `selectedSeq` pins the selected finding's group into the first 12, even when it
 * ranks past the cap, so a selection never hides.
 */
export function buildFindingGroups(
  findings: readonly LiveFinding[],
  selectedSeq: number | null,
): GroupedFindings {
  // Bucket into drafts, preserving first-seen order for a stable within-state sort.
  const drafts = new Map<string, Draft>();
  for (const finding of findings) {
    const entity = finding.entity ?? null;
    const entityKind = finding.finding.subjectType;
    const key = entity === null ? `ungrouped::${finding.seq}` : `${entityKind}::${entity}`;
    const existing = drafts.get(key);
    if (existing) {
      existing.findings.push(finding);
    } else {
      // `exactOptionalPropertyTypes`: only set `entityKind` when it is present, never to
      // `undefined`. An entity-less finding carries no subject type.
      const draft: Draft = { key, entity, findings: [finding] };
      if (entityKind !== undefined) {
        draft.entityKind = entityKind;
      }
      drafts.set(key, draft);
    }
  }

  const groups = [...drafts.values()].map(toGroup);
  groups.sort(byRank);

  const pinned = pinSelected(groups, selectedSeq);
  return { groups: pinned, hiddenCount: Math.max(0, pinned.length - VISIBLE_CAP) };
}

/** Settle one draft into a group: hit-first rows, agreement, and the rank keys. */
function toGroup(draft: Draft): FindingGroup {
  const hits = draft.findings.filter((f) => f.state === "hit");
  const watches = draft.findings.filter((f) => f.state === "watch");
  const rows = [...hits, ...watches].map(toRow);
  const distinctHitReasons = new Set(hits.map((f) => f.reason));
  const group: FindingGroup = {
    key: draft.key,
    entity: draft.entity,
    rows,
    agreement: distinctHitReasons.size >= 2,
    hitCount: hits.length,
    latestAt: draft.findings.reduce((max, f) => Math.max(max, f.at), Number.NEGATIVE_INFINITY),
  };
  if (draft.entityKind !== undefined) {
    group.entityKind = draft.entityKind;
  }
  return group;
}

/** Shape one live finding into a row. */
function toRow(finding: LiveFinding): FindingRow {
  return {
    seq: finding.seq,
    state: finding.state,
    label: prettifyReason(finding.reason),
    reason: finding.reason,
    citedCount: finding.eventIds.length,
  };
}

/** Rank: hit count desc, then watch count desc, then latest emission desc. */
function byRank(a: FindingGroup, b: FindingGroup): number {
  if (a.hitCount !== b.hitCount) {
    return b.hitCount - a.hitCount;
  }
  const aWatch = a.rows.length - a.hitCount;
  const bWatch = b.rows.length - b.hitCount;
  if (aWatch !== bWatch) {
    return bWatch - aWatch;
  }
  return b.latestAt - a.latestAt;
}

/**
 * Pull the selected finding's group into the last visible slot when it ranks past
 * the cap, so the panel's default 12 always includes it. A selection already inside
 * the window, or no selection, leaves the order untouched.
 */
function pinSelected(groups: FindingGroup[], selectedSeq: number | null): FindingGroup[] {
  if (selectedSeq === null) {
    return groups;
  }
  const index = groups.findIndex((g) => g.rows.some((r) => r.seq === selectedSeq));
  if (index < VISIBLE_CAP) {
    return groups;
  }
  const reordered = [...groups];
  const [selected] = reordered.splice(index, 1);
  if (selected) {
    reordered.splice(VISIBLE_CAP - 1, 0, selected);
  }
  return reordered;
}
