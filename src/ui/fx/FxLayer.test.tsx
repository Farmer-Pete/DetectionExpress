import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGameStore } from "../../game/store";
import type {
  CaughtDecision,
  Decision,
  FalseDecision,
  LiveFinding,
  MissedDecision,
} from "../../sim/correctness";
import type { Finding } from "../../sim/finding";
import { emptySnapshot } from "../../sim/snapshot";
import { type FxClock, FxLayer } from "./FxLayer";

// ---- a controllable clock, the FxLayer analogue of clock.ts's ManualDriver ----
class ManualFxClock implements FxClock {
  private time = 0;
  private queue = new Map<number, FrameRequestCallback>();
  private nextId = 1;
  /** Total requestFrame calls, so a test can prove the loop parks (F011). */
  requestFrameCalls = 0;

  now(): number {
    return this.time;
  }

  requestFrame(callback: FrameRequestCallback): number {
    this.requestFrameCalls++;
    const id = this.nextId++;
    this.queue.set(id, callback);
    return id;
  }

  cancelFrame(id: number): void {
    this.queue.delete(id);
  }

  /** Advance the clock and fire every callback queued as of this call, once. */
  advance(ms: number): void {
    this.time += ms;
    const due = [...this.queue.values()];
    this.queue.clear();
    for (const callback of due) {
      callback(this.time);
    }
  }
}

function stubReducedMotion(matches: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

/** A reduced-motion media stub whose `flip` fires the change listener FxLayer registered. */
function mutableReducedMotionMedia(initial: boolean): { flip: (matches: boolean) => void } {
  let matches = initial;
  let listener: (() => void) | null = null;
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return matches;
    },
    media: query,
    addEventListener: (_type: "change", callback: () => void) => {
      listener = callback;
    },
    removeEventListener: () => {
      listener = null;
    },
  }));
  return {
    flip: (next: boolean) => {
      matches = next;
      listener?.();
    },
  };
}

/** A DOMRect-shaped stub carrying only the fields FxLayer reads. */
function rect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function stubRect(el: Element, r: DOMRect): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(r);
}

function requireEl(selector: string): Element {
  const el = document.querySelector(selector);
  if (el === null) {
    throw new Error(`expected an element matching ${selector}`);
  }
  return el;
}

interface HarnessProps {
  logRowIds: readonly number[];
  findingSeqs: readonly number[];
  clock: FxClock;
}

/** The minimal DOM FxLayer measures: a log panel with rows, a findings panel with rows. */
function Harness({ logRowIds, findingSeqs, clock }: HarnessProps) {
  return (
    <>
      <div className="log-stream">
        {logRowIds.map((id) => (
          <div key={id} data-testid={`log-row-${id}`} />
        ))}
      </div>
      <div className="findings-panel">
        {findingSeqs.map((seq) => (
          <button key={seq} type="button" data-finding-seq={seq} />
        ))}
      </div>
      <FxLayer clock={clock} />
    </>
  );
}

function renderHarness(
  clock: FxClock,
  logRowIds: readonly number[] = [],
  findingSeqs: readonly number[] = [],
): void {
  render(<Harness logRowIds={logRowIds} findingSeqs={findingSeqs} clock={clock} />);
}

function publish(findings: readonly LiveFinding[], decisions: readonly Decision[] = []): void {
  act(() => {
    useGameStore.setState({ snapshot: { ...emptySnapshot(), findings, decisions } });
  });
}

interface LiveOptions {
  seq: number;
  state?: "hit" | "watch";
  reason?: string;
  eventIds?: number[];
  entity?: string;
}

function liveFinding(opts: LiveOptions): LiveFinding {
  const reason = opts.reason ?? "brute";
  const eventIds = opts.eventIds ?? [opts.seq];
  const state = opts.state ?? "hit";
  const anchor = eventIds[0] ?? opts.seq;
  const finding: Finding =
    state === "watch"
      ? { alert: { reason, at: 0, eventIds }, eventId: anchor, isPartial: true }
      : { alert: { reason, at: 0, eventIds }, eventId: anchor };
  const result: LiveFinding = {
    finding,
    state,
    reason,
    eventIds,
    at: 0,
    seq: opts.seq,
    citedEvents: [],
  };
  if (opts.entity !== undefined) {
    result.entity = opts.entity;
  }
  return result;
}

// DecisionBase.seq is documented as append order: strictly monotonic. A shared
// counter keeps every fixture built through these helpers honoring that contract,
// regardless of which helper or how many decisions a single test builds.
let nextFixtureSeq = 0;

function caughtDecision(
  liveSeq: number,
  entity = "acct-1",
  eventIds: number[] = [1],
): CaughtDecision {
  return {
    outcome: "caught",
    seq: nextFixtureSeq++,
    at: 0,
    attackId: 1,
    entity,
    finding: { alert: { reason: "brute", at: 0, eventIds }, eventId: eventIds[0] ?? 1 },
    citedEvents: [],
    resolvedAt: 0,
    liveSeq,
  };
}

function falseDecision(liveSeq: number, entity?: string, eventIds: number[] = [1]): FalseDecision {
  const decision: FalseDecision = {
    outcome: "false",
    seq: nextFixtureSeq++,
    at: 0,
    finding: { alert: { reason: "brute", at: 0, eventIds }, eventId: eventIds[0] ?? 1 },
    citedEvents: [],
    resolvedAt: 0,
    liveSeq,
  };
  if (entity !== undefined) {
    decision.entity = entity;
  }
  return decision;
}

function missedDecision(entity = "acct-1"): MissedDecision {
  return {
    outcome: "missed",
    seq: nextFixtureSeq++,
    at: 0,
    attackId: 1,
    entity,
    reason: "brute",
    resolvedAt: 0,
    window: { startTs: 0, endTs: 0 },
  };
}

function cometFrom(el: HTMLElement): { x: number; y: number } {
  return { x: Number.parseFloat(el.style.left), y: Number.parseFloat(el.style.top) };
}

function cometTo(el: HTMLElement): { x: number; y: number } {
  const from = cometFrom(el);
  const dx = Number.parseFloat(el.style.getPropertyValue("--comet-dx"));
  const dy = Number.parseFloat(el.style.getPropertyValue("--comet-dy"));
  return { x: from.x + dx, y: from.y + dy };
}

beforeEach(() => {
  useGameStore.setState({ snapshot: emptySnapshot(), flashes: new Map(), runToken: 0 });
  stubReducedMotion(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FxLayer landing a finding", () => {
  it("spawns one flash and one comet per distinct cited row, deduping a repeated id", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [10, 11], [1]);
    publish([liveFinding({ seq: 1, reason: "brute", eventIds: [10, 11, 10] })]);
    expect(useGameStore.getState().flashes.size).toBe(2); // 10 and 11, not three
    expect(screen.getAllByTestId("fx-comet")).toHaveLength(2);
  });

  it("does not fire for a finding that only ever appears as a watch", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [10], [1]);
    publish([liveFinding({ seq: 1, state: "watch", eventIds: [10] })]);
    expect(useGameStore.getState().flashes.size).toBe(0);
    expect(screen.queryAllByTestId("fx-comet")).toHaveLength(0);
  });

  it("does not refire a hit -> hit re-emit with grown eventIds", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [10, 11], [1]);
    publish([liveFinding({ seq: 1, eventIds: [10] })]);
    expect(screen.getAllByTestId("fx-comet")).toHaveLength(1);
    publish([liveFinding({ seq: 1, eventIds: [10, 11] })]);
    expect(screen.getAllByTestId("fx-comet")).toHaveLength(1); // no new comet for the re-emit
  });

  it("spawns all items for a burst delta of several findings and decisions in one tick", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [10, 20], [1, 2]);
    publish(
      [
        liveFinding({ seq: 1, reason: "brute", eventIds: [10] }),
        liveFinding({ seq: 2, reason: "travel", eventIds: [20] }),
      ],
      [caughtDecision(1), missedDecision("acct-9")],
    );
    expect(screen.getAllByTestId("fx-comet")).toHaveLength(2);
    expect(screen.getAllByTestId("fx-pop")).toHaveLength(2);
  });
});

describe("FxLayer F012 fallback landing FX for an unsampled hit", () => {
  it("spawns the landing flash, comet, and pop for a caught decision whose liveSeq never appeared in a findings array", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [30, 31], [5]);
    stubRect(requireEl(".findings-panel"), rect(0, 0, 200, 200));
    stubRect(requireEl("[data-finding-seq='5']"), rect(40, 50, 60, 70));
    publish([], [caughtDecision(5, "acct-7", [30, 31])]);
    expect(useGameStore.getState().flashes.size).toBe(2); // one per cited eventId
    expect(screen.getAllByTestId("fx-comet")).toHaveLength(2);
    expect(screen.getAllByTestId("fx-pop")).toHaveLength(1);
  });

  it("de-dupes: a hit sampled in the same delta as its own decision produces exactly one flash+comet set", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [10], [1]);
    publish(
      [liveFinding({ seq: 1, reason: "brute", eventIds: [10] })],
      [caughtDecision(1, "acct-1", [10])],
    );
    expect(useGameStore.getState().flashes.size).toBe(1); // not two: findings loop already fired it
    expect(screen.getAllByTestId("fx-comet")).toHaveLength(1);
  });

  it("under reduced motion, the fallback spawns the cited flash and the pop but no comet", () => {
    stubReducedMotion(true);
    const clock = new ManualFxClock();
    renderHarness(clock, [10], [1]);
    publish([], [caughtDecision(1, "acct-1", [10])]);
    expect(useGameStore.getState().flashes.size).toBe(1);
    expect(screen.queryAllByTestId("fx-comet")).toHaveLength(0);
    expect(screen.getAllByTestId("fx-pop")).toHaveLength(1);
  });

  it("regression: when the hit was sampled and fired in an earlier tick, a later decision for the same liveSeq does not refire", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [10], [1]);
    publish([liveFinding({ seq: 1, eventIds: [10] })]); // the hit lands first, no decision yet
    expect(screen.getAllByTestId("fx-comet")).toHaveLength(1);

    publish([liveFinding({ seq: 1, eventIds: [10] })], [caughtDecision(1, "acct-1", [10])]); // the decision arrives a tick later, for the same liveSeq
    expect(screen.getAllByTestId("fx-comet")).toHaveLength(1); // still one: the fallback did not refire
    expect(screen.getAllByTestId("fx-pop")).toHaveLength(1); // the pop is unaffected
  });
});

describe("FxLayer stacked pops (F009)", () => {
  it("gives each pop in a same-anchor batch of missed decisions a distinct position", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [], []);
    stubRect(requireEl(".findings-panel"), rect(100, 200, 300, 400));
    publish([], [missedDecision("acct-1"), missedDecision("acct-2"), missedDecision("acct-3")]);
    const pops = screen.getAllByTestId("fx-pop");
    expect(pops).toHaveLength(3);
    const coords = pops.map((pop) => `${pop.style.left},${pop.style.top}`);
    expect(new Set(coords).size).toBe(3); // every pop lands at a distinct point
  });
});

describe("FxLayer anchor clamping", () => {
  it("clamps a straddling row's center into the panel's visible bottom edge, even though the row overlaps the panel", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [10], [1]);
    stubRect(requireEl(".log-stream"), rect(0, 0, 200, 200));
    stubRect(requireEl(".findings-panel"), rect(0, 0, 200, 200));
    stubRect(screen.getByTestId("log-row-10"), rect(5, 5, 15, 15));
    // The finding row's rect overlaps the panel (its top, 190, is inside the panel's
    // 0..200 span) but its own center, 220, sits below the panel's bottom edge — a
    // row straddling the edge, not fully off-screen.
    stubRect(requireEl("[data-finding-seq='1']"), rect(10, 190, 30, 250));
    publish([liveFinding({ seq: 1, eventIds: [10] })]);
    const comet = screen.getByTestId("fx-comet");
    expect(cometTo(comet)).toEqual({ x: 20, y: 200 }); // clamped to the panel's visible bottom edge
  });
});

describe("FxLayer decision pops", () => {
  it("pops CAUGHT with the entity, in green, anchored on the finding's row", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [], [1]);
    stubRect(requireEl(".findings-panel"), rect(0, 0, 200, 200));
    stubRect(requireEl("[data-finding-seq='1']"), rect(40, 50, 60, 70));
    publish([], [caughtDecision(1, "acct-7")]);
    const pop = screen.getByTestId("fx-pop");
    expect(pop.textContent).toBe("CAUGHT · acct-7");
    expect(pop.style.color).toBe("var(--ok)");
    expect(Number.parseFloat(pop.style.left)).toBe(50); // the row's rect center
    expect(Number.parseFloat(pop.style.top)).toBe(60);
  });

  it("pops FALSE ALERT with the entity, in amber, anchored on the finding's row", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [], [2]);
    stubRect(requireEl(".findings-panel"), rect(0, 0, 200, 200));
    stubRect(requireEl("[data-finding-seq='2']"), rect(0, 0, 20, 20));
    publish([], [falseDecision(2, "acct-3")]);
    const pop = screen.getByTestId("fx-pop");
    expect(pop.textContent).toBe("FALSE ALERT · acct-3");
    expect(pop.style.color).toBe("var(--alert)");
  });

  it("pops a bare FALSE ALERT with no suffix for an entity-less false decision", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [], [3]);
    stubRect(requireEl(".findings-panel"), rect(0, 0, 200, 200));
    stubRect(requireEl("[data-finding-seq='3']"), rect(0, 0, 20, 20));
    publish([], [falseDecision(3)]);
    expect(screen.getByTestId("fx-pop").textContent).toBe("FALSE ALERT");
  });

  it("pops MISSED with the entity, in red, anchored on the findings panel's top edge", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [], []);
    stubRect(requireEl(".findings-panel"), rect(100, 200, 300, 400));
    publish([], [missedDecision("acct-9")]);
    const pop = screen.getByTestId("fx-pop");
    expect(pop.textContent).toBe("MISSED · acct-9");
    expect(pop.style.color).toBe("var(--threat)");
    expect(Number.parseFloat(pop.style.left)).toBe(200); // top-edge center: (100+300)/2
    expect(Number.parseFloat(pop.style.top)).toBe(200); // the panel's visible top
  });
});

describe("FxLayer fallback anchors", () => {
  it("anchors an evicted cited row on the log panel's bottom edge, and clamps an off-screen mounted row", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [11], []); // row 10 is evicted (no element); row 11 is mounted
    stubRect(requireEl(".log-stream"), rect(0, 0, 100, 100));
    stubRect(requireEl(".findings-panel"), rect(300, 300, 400, 400)); // finding row is capped
    stubRect(screen.getByTestId("log-row-11"), rect(200, 200, 210, 210)); // off-screen

    publish([liveFinding({ seq: 1, eventIds: [10, 11] })]);
    const [evicted, offscreen] = screen.getAllByTestId("fx-comet");
    if (!evicted || !offscreen) {
      throw new Error("expected two comets");
    }
    expect(cometFrom(evicted)).toEqual({ x: 50, y: 100 }); // log panel's visible bottom edge
    expect(cometFrom(offscreen)).toEqual({ x: 100, y: 100 }); // clamped into the panel bounds
    // Both land on the same fallback: the finding's row is missing (capped past +N more).
    expect(cometTo(evicted)).toEqual({ x: 350, y: 400 });
    expect(cometTo(offscreen)).toEqual({ x: 350, y: 400 });
  });
});

describe("FxLayer viewport clamping (F018)", () => {
  function stubViewport(width: number, height: number): void {
    vi.stubGlobal("innerWidth", width);
    vi.stubGlobal("innerHeight", height);
  }

  it("clamps a fallback point to the viewport when the panel is only partly scrolled off", () => {
    stubViewport(1024, 800);
    const clock = new ManualFxClock();
    renderHarness(clock, [10], [1]);
    // The log panel's raw rect runs from y=500 to y=1500 — its bottom half is below
    // the 800px viewport. The mounted row sits at y=520..530, inside the part of the
    // panel that IS on screen, so it anchors on its own center, not the edge.
    stubRect(requireEl(".log-stream"), rect(0, 500, 100, 1500));
    stubRect(requireEl(".findings-panel"), rect(300, 300, 400, 400));
    stubRect(screen.getByTestId("log-row-10"), rect(10, 520, 20, 530));

    publish([liveFinding({ seq: 1, eventIds: [10] })]);
    const comet = screen.getByTestId("fx-comet");
    expect(cometFrom(comet)).toEqual({ x: 15, y: 525 }); // the row's own center: it is visible
    expect(cometFrom(comet).y).toBeLessThanOrEqual(800);
  });

  it("treats a panel rect entirely below the viewport as not visible, clamping to the nearest edge", () => {
    stubViewport(1024, 800);
    const clock = new ManualFxClock();
    renderHarness(clock, [10], [1]);
    // The whole log panel sits below the viewport (900..1500 with innerHeight 800): no
    // part of it is visible, so even a "mounted" row inside it falls back to the
    // viewport's nearest edge rather than its own (off-screen) coordinates.
    stubRect(requireEl(".log-stream"), rect(0, 900, 100, 1500));
    stubRect(requireEl(".findings-panel"), rect(300, 300, 400, 400));
    stubRect(screen.getByTestId("log-row-10"), rect(10, 920, 20, 930));

    publish([liveFinding({ seq: 1, eventIds: [10] })]);
    const comet = screen.getByTestId("fx-comet");
    // x stays the row's own center (15, already inside the panel's horizontal span);
    // y clamps to the viewport's bottom edge, same as any other off-screen anchor.
    expect(cometFrom(comet)).toEqual({ x: 15, y: 800 });
  });
});

describe("FxLayer reduced motion", () => {
  it("spawns no comets, but still fades in a verdict pop and flashes cited rows", () => {
    stubReducedMotion(true);
    const clock = new ManualFxClock();
    renderHarness(clock, [10], [1]);
    publish([liveFinding({ seq: 1, eventIds: [10] })], [caughtDecision(1)]);
    expect(useGameStore.getState().flashes.size).toBe(1); // the cited row still flashes
    expect(screen.queryAllByTestId("fx-comet")).toHaveLength(0); // no flight path
    expect(screen.getAllByTestId("fx-pop")).toHaveLength(1); // the label still appears
  });

  it("removes in-flight comet items immediately when reduced motion flips on mid-flight (F016)", () => {
    const media = mutableReducedMotionMedia(false);
    const clock = new ManualFxClock();
    renderHarness(clock, [10], [1]);
    publish([liveFinding({ seq: 1, eventIds: [10] })]);
    expect(screen.getAllByTestId("fx-comet").length).toBeGreaterThan(0);

    act(() => media.flip(true));
    expect(screen.queryAllByTestId("fx-comet")).toHaveLength(0);
  });
});

describe("FxLayer timing", () => {
  it("expires a spawned item once the clock advances past its duration (the rAF loop runs on)", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [], []);
    stubRect(requireEl(".findings-panel"), rect(0, 0, 100, 100));
    publish([], [missedDecision()]);
    expect(screen.getByTestId("fx-pop")).toBeDefined();
    act(() => clock.advance(2000)); // well past every FX duration
    expect(screen.queryByTestId("fx-pop")).toBeNull();
  });

  it("clears a flash once the clock advances past the flash duration", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [10], [1]);
    publish([liveFinding({ seq: 1, eventIds: [10] })]);
    expect(useGameStore.getState().flashes.size).toBe(1);
    act(() => clock.advance(2000));
    expect(useGameStore.getState().flashes.size).toBe(0);
  });
});

describe("FxLayer run reset", () => {
  it("clears fired seqs, palette, flashes, and live items on a runToken change, so a reused seq refires", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [10], [1]);
    publish([liveFinding({ seq: 1, eventIds: [10] })]);
    expect(useGameStore.getState().flashes.size).toBe(1);
    expect(screen.getAllByTestId("fx-comet").length).toBeGreaterThan(0);

    act(() => {
      useGameStore.getState().bumpRunToken();
      useGameStore.setState({ snapshot: emptySnapshot() });
    });
    expect(useGameStore.getState().flashes.size).toBe(0);
    expect(screen.queryAllByTestId("fx-comet")).toHaveLength(0);

    // The fresh run reuses seq 1 for a different finding. It must fire again: proof the
    // fired-seq set (not just the store's flashes and overlay items) was reset too.
    publish([liveFinding({ seq: 1, eventIds: [10] })]);
    expect(useGameStore.getState().flashes.size).toBe(1);
    expect(screen.getAllByTestId("fx-comet").length).toBeGreaterThan(0);
  });

  it("clears announcements on a runToken change (F005), so no prior-run verdict lingers", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [], [1]);
    stubRect(requireEl(".findings-panel"), rect(0, 0, 200, 200));
    stubRect(requireEl("[data-finding-seq='1']"), rect(40, 50, 60, 70));
    publish([], [caughtDecision(1, "acct-7")]);
    expect(screen.getByTestId("fx-announcements").textContent).toContain("Caught: acct-7");

    act(() => {
      useGameStore.getState().bumpRunToken();
      useGameStore.setState({ snapshot: emptySnapshot() });
    });
    expect(screen.getByTestId("fx-announcements").childElementCount).toBe(0);
  });

  it("spawns nothing from a stale snapshot on a token-first transition, then fires normally once the fresh run lands", () => {
    // `bumpRunToken` and the empty-snapshot publish are separate store actions
    // (`run-controller.ts`): this reproduces the order where the token flips in
    // its own render, with the OLD run's findings and decision still sitting in
    // the store, unlike the other run-reset tests above, which bundle both store
    // writes into one `act` (a same-render bump the reset must also cover, but
    // not the only order it has to be correct under).
    const clock = new ManualFxClock();
    renderHarness(clock, [10], [1]);
    stubRect(requireEl(".findings-panel"), rect(0, 0, 200, 200));
    stubRect(requireEl("[data-finding-seq='1']"), rect(40, 50, 60, 70));
    publish([liveFinding({ seq: 1, eventIds: [10] })], [caughtDecision(1, "acct-7")]);
    expect(useGameStore.getState().flashes.size).toBe(1);
    expect(screen.getAllByTestId("fx-comet").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("fx-pop")).toHaveLength(1);
    expect(screen.getByTestId("fx-announcements").textContent).toContain("Caught: acct-7");

    // Bump the token ALONE: the store's snapshot still holds the old run's finding
    // and decision at this point. The reset must spawn nothing from them, and must
    // clear what was already live.
    act(() => {
      useGameStore.getState().bumpRunToken();
    });
    expect(useGameStore.getState().flashes.size).toBe(0);
    expect(screen.queryAllByTestId("fx-comet")).toHaveLength(0);
    expect(screen.queryAllByTestId("fx-pop")).toHaveLength(0);
    expect(screen.getByTestId("fx-announcements").childElementCount).toBe(0);

    // The empty-snapshot publish that normally follows the bump: still nothing
    // spawns, since the old run's finding and decision are simply gone now, and
    // the reset pass already zeroed the baselines they would have diffed against.
    publish([], []);
    expect(useGameStore.getState().flashes.size).toBe(0);
    expect(screen.queryAllByTestId("fx-comet")).toHaveLength(0);
    expect(screen.queryAllByTestId("fx-pop")).toHaveLength(0);

    // The fresh run reuses seq 1 for a different finding. It must fire normally:
    // proof the zeroed baselines (not just the cleared overlay) survived the reset.
    publish([liveFinding({ seq: 1, eventIds: [10] })]);
    expect(useGameStore.getState().flashes.size).toBe(1);
    expect(screen.getAllByTestId("fx-comet").length).toBeGreaterThan(0);
  });
});

describe("FxLayer mount over a populated store (F004)", () => {
  it("fires nothing on mount when the store already holds hit findings and a decision log", () => {
    const clock = new ManualFxClock();
    act(() => {
      useGameStore.setState({
        snapshot: {
          ...emptySnapshot(),
          findings: [liveFinding({ seq: 1, eventIds: [10] })],
          decisions: [caughtDecision(1)],
        },
      });
    });
    renderHarness(clock, [10], [1]);
    expect(screen.queryAllByTestId("fx-comet")).toHaveLength(0);
    expect(screen.queryAllByTestId("fx-pop")).toHaveLength(0);
    expect(useGameStore.getState().flashes.size).toBe(0);
  });

  it("still fires once a runToken bump reuses the same seq for a fresh finding", () => {
    const clock = new ManualFxClock();
    act(() => {
      useGameStore.setState({
        snapshot: {
          ...emptySnapshot(),
          findings: [liveFinding({ seq: 1, eventIds: [10] })],
          decisions: [caughtDecision(1)],
        },
      });
    });
    renderHarness(clock, [10], [1]);
    expect(screen.queryAllByTestId("fx-comet")).toHaveLength(0);

    act(() => {
      useGameStore.getState().bumpRunToken();
      useGameStore.setState({ snapshot: emptySnapshot() });
    });
    publish([liveFinding({ seq: 1, eventIds: [10] })]);
    expect(screen.getAllByTestId("fx-comet").length).toBeGreaterThan(0);
  });

  it("still fires a watch finding present at mount once it promotes to a hit", () => {
    const clock = new ManualFxClock();
    act(() => {
      useGameStore.setState({
        snapshot: {
          ...emptySnapshot(),
          findings: [liveFinding({ seq: 1, state: "watch", eventIds: [10] })],
        },
      });
    });
    renderHarness(clock, [10], [1]);
    expect(screen.queryAllByTestId("fx-comet")).toHaveLength(0);

    publish([liveFinding({ seq: 1, state: "hit", eventIds: [10] })]);
    expect(screen.getAllByTestId("fx-comet").length).toBeGreaterThan(0);
  });
});

describe("FxLayer verdict announcements (F007)", () => {
  it("announces a caught decision in plain words, live and outside the aria-hidden overlay", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [], [1]);
    stubRect(requireEl(".findings-panel"), rect(0, 0, 200, 200));
    stubRect(requireEl("[data-finding-seq='1']"), rect(40, 50, 60, 70));
    publish([], [caughtDecision(1, "acct-7")]);

    const live = screen.getByTestId("fx-announcements");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.closest('[aria-hidden="true"]')).toBeNull();
    expect(live.textContent).toContain("Caught: acct-7");
  });

  it("announces a false alert and a miss in plain words", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [], []);
    stubRect(requireEl(".findings-panel"), rect(0, 0, 200, 200));
    publish([], [falseDecision(2), missedDecision("acct-9")]);

    const live = screen.getByTestId("fx-announcements");
    expect(live.textContent).toContain("False alert");
    expect(live.textContent).toContain("Missed: acct-9");
  });

  it("appends and trims a sub-cap burst to the cap (F007)", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [], []);
    stubRect(requireEl(".findings-panel"), rect(0, 0, 200, 200));
    // Three decisions, then three more new ones: six seen total, five kept (the cap),
    // the oldest (acct-1) aged out. The first three keep their identity (and seq)
    // across snapshots, exactly as the scorer's log republishes them.
    const firstThree = [
      missedDecision("acct-1"),
      missedDecision("acct-2"),
      missedDecision("acct-3"),
    ];
    publish([], firstThree);
    publish(
      [],
      [...firstThree, missedDecision("acct-4"), missedDecision("acct-5"), missedDecision("acct-6")],
    );
    const live = screen.getByTestId("fx-announcements");
    expect(live.childElementCount).toBe(5);
    expect(live.textContent).not.toContain("acct-1");
    expect(live.textContent).toContain("acct-6");
  });

  it("collapses a single burst over the cap into one outcome-count summary, not a truncated list", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [], []);
    stubRect(requireEl(".findings-panel"), rect(0, 0, 200, 200));
    // One publish carrying 7 decisions at once: more than ANNOUNCEMENT_CAP (5). A
    // per-decision list would drop verdicts no matter which end the cap kept, so this
    // must render as exactly one summary entry instead.
    const decisions = [
      caughtDecision(1, "acct-1"),
      caughtDecision(1, "acct-2"),
      falseDecision(1, "acct-3"),
      missedDecision("acct-4"),
      missedDecision("acct-5"),
      missedDecision("acct-6"),
      missedDecision("acct-7"),
    ];
    publish([], decisions);

    const live = screen.getByTestId("fx-announcements");
    expect(live.childElementCount).toBe(1);
    expect(live.textContent).toBe("7 decisions: 2 caught, 1 false alert, 4 missed");
  });
});

describe("FxLayer rAF parking (F011)", () => {
  it("requests no frames until a spawn, then parks again once everything expires", () => {
    const clock = new ManualFxClock();
    renderHarness(clock, [10], [1]);
    expect(clock.requestFrameCalls).toBe(0); // nothing pending at mount: parked

    publish([liveFinding({ seq: 1, eventIds: [10] })]);
    expect(clock.requestFrameCalls).toBeGreaterThan(0);

    act(() => clock.advance(2000)); // past every FX duration: flash and comet both expire
    const callsAfterExpiry = clock.requestFrameCalls;
    act(() => clock.advance(2000)); // parked: this tick must not have rescheduled itself
    expect(clock.requestFrameCalls).toBe(callsAfterExpiry);

    publish([liveFinding({ seq: 2, eventIds: [10] })]); // a fresh spawn wakes the loop
    expect(clock.requestFrameCalls).toBeGreaterThan(callsAfterExpiry);
  });
});

describe("FxLayer unmount", () => {
  it("cancels its rAF loop and clears every flash it owns", () => {
    const clock = new ManualFxClock();
    const { unmount } = render(<Harness logRowIds={[10]} findingSeqs={[1]} clock={clock} />);
    publish([liveFinding({ seq: 1, eventIds: [10] })]);
    expect(useGameStore.getState().flashes.size).toBe(1);
    unmount();
    expect(useGameStore.getState().flashes.size).toBe(0);
    // Advancing the clock after unmount must touch nothing: the loop was cancelled.
    act(() => clock.advance(5000));
    expect(useGameStore.getState().flashes.size).toBe(0);
  });
});
