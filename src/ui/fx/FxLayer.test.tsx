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
  const result: LiveFinding = { finding, state, reason, eventIds, at: 0, seq: opts.seq };
  if (opts.entity !== undefined) {
    result.entity = opts.entity;
  }
  return result;
}

function caughtDecision(liveSeq: number, entity = "acct-1"): CaughtDecision {
  return {
    outcome: "caught",
    seq: 0,
    at: 0,
    attackId: 1,
    entity,
    finding: { alert: { reason: "brute", at: 0, eventIds: [1] }, eventId: 1 },
    liveSeq,
  };
}

function falseDecision(liveSeq: number, entity?: string): FalseDecision {
  const decision: FalseDecision = {
    outcome: "false",
    seq: 0,
    at: 0,
    finding: { alert: { reason: "brute", at: 0, eventIds: [1] }, eventId: 1 },
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
    seq: 0,
    at: 0,
    attackId: 1,
    entity,
    reason: "brute",
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
