import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGameStore } from "../../game/store";
import { emptySnapshot, type SimSnapshot } from "../../sim/snapshot";
import type { WorldLogEvent } from "../../sim/world-log";
import { LogPanel } from "./LogPanel";

/** Publish a snapshot carrying only the given wave reading; everything else stays empty. */
function setWave(wave: SimSnapshot["wave"]): void {
  useGameStore.setState({ snapshot: { ...emptySnapshot(), wave } });
}

/** Publish a snapshot carrying the given wave reading and run status. */
function setWaveAndStatus(wave: SimSnapshot["wave"], status: SimSnapshot["status"]): void {
  useGameStore.setState({ snapshot: { ...emptySnapshot(), wave, status } });
}

function kioskEvent(id: number, overrides: Partial<WorldLogEvent> = {}): WorldLogEvent {
  return {
    id,
    ts: id * 2,
    sensor: "kiosk",
    placeId: "cen",
    chipNode: "cen:kiosk",
    actorId: `patron-${id}`,
    reading: {
      sensor: "kiosk",
      reading: {
        ts: id * 2,
        account: `acct-${id}`,
        station: "cen",
        terminal: "K1",
        outcome: "success",
      },
    },
    scored: false,
    ...overrides,
  };
}

function fareGateEvent(id: number, overrides: Partial<WorldLogEvent> = {}): WorldLogEvent {
  return {
    id,
    ts: id * 2,
    sensor: "fare-gate",
    placeId: "cen",
    chipNode: "cen:gate",
    reading: {
      sensor: "fare-gate",
      reading: {
        ts: id * 2,
        card: `card-${id}`,
        station: "cen",
        line: "red",
        direction: "in",
        result: "ok",
        balance: 50,
      },
    },
    scored: false,
    ...overrides,
  };
}

function setSnapshot(worldEvents: WorldLogEvent[]): void {
  useGameStore.setState({
    snapshot: { ...emptySnapshot(), worldEvents },
  });
}

beforeEach(() => {
  useGameStore.setState({
    snapshot: emptySnapshot(),
    transport: { frozen: false, speed: 1 },
    flashes: new Map(),
    overlayOpen: false,
  });
});

describe("LogPanel", () => {
  it("renders rows newest first, highest id at the top", () => {
    setSnapshot([kioskEvent(0), kioskEvent(1), kioskEvent(2)]);
    render(<LogPanel />);
    const rows = screen.getAllByTestId(/^log-row-/);
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "log-row-2",
      "log-row-1",
      "log-row-0",
    ]);
  });

  it("renders a row for every sensor kind, not just the scored kiosk stream", () => {
    setSnapshot([kioskEvent(0), fareGateEvent(1)]);
    render(<LogPanel />);
    expect(screen.getByTestId("log-row-0")).toBeDefined();
    expect(screen.getByTestId("log-row-1")).toBeDefined();
  });

  it("renders no queue bar, cursor, or sticky 'engine N behind' bar", () => {
    setSnapshot([kioskEvent(0)]);
    render(<LogPanel />);
    expect(document.querySelector(".queue-bar")).toBeNull();
    expect(document.querySelector(".log-row-cursor")).toBeNull();
    expect(screen.queryByTestId("log-sticky")).toBeNull();
    expect(screen.queryByTestId("queue-bar-fill")).toBeNull();
  });

  it("selects the world event by its own id when a row is clicked", () => {
    setSnapshot([kioskEvent(0), fareGateEvent(1)]);
    render(<LogPanel />);
    fireEvent.click(screen.getByTestId("log-row-1"));
    expect(useGameStore.getState().eventSelection).toBe(1);
  });

  it("carries data-scored-event-id only on a scored row, keyed by scoredEventId (not the world id)", () => {
    setSnapshot([
      kioskEvent(5, { scored: true, scoredEventId: 42 }),
      fareGateEvent(6), // unscored: never carries the attribute
    ]);
    render(<LogPanel />);
    expect(screen.getByTestId("log-row-5").getAttribute("data-scored-event-id")).toBe("42");
    expect(screen.getByTestId("log-row-6").hasAttribute("data-scored-event-id")).toBe(false);
  });
});

describe("LogPanel cited-row flash", () => {
  it("carries log-row-cited and the inline hunt color for a scored row's flash, keyed by scoredEventId", () => {
    setSnapshot([
      kioskEvent(0, { scored: true, scoredEventId: 100 }),
      kioskEvent(1, { scored: true, scoredEventId: 101 }),
    ]);
    // Keyed by scoredEventId (101), a different number from either row's world id.
    useGameStore.getState().spawnFlashes([{ eventId: 101, colorVar: "var(--hunt-2)", gen: 1 }]);
    render(<LogPanel />);
    const flashed = screen.getByTestId("log-row-1");
    expect(flashed.className).toMatch(/log-row-cited/);
    expect(flashed.style.getPropertyValue("--hunt-color")).toBe("var(--hunt-2)");
    expect(screen.getByTestId("log-row-0").className).not.toMatch(/log-row-cited/);
  });

  it("never flashes an unscored row, even if its world id collides with a flash key", () => {
    // The fare-gate row's world id (101) equals the flash's scored-id key: a row with no
    // scoredEventId must still never flash, proving the lookup keys off scoredEventId,
    // never the world id.
    setSnapshot([fareGateEvent(101)]);
    useGameStore.getState().spawnFlashes([{ eventId: 101, colorVar: "var(--hunt-2)", gen: 1 }]);
    render(<LogPanel />);
    expect(screen.getByTestId("log-row-101").className).not.toMatch(/log-row-cited/);
  });

  it("remounts the flash when a re-spawn carries a higher gen", () => {
    setSnapshot([kioskEvent(1, { scored: true, scoredEventId: 9 })]);
    useGameStore.getState().spawnFlashes([{ eventId: 9, colorVar: "var(--hunt-1)", gen: 1 }]);
    const { rerender } = render(<LogPanel />);
    const first = screen.getByTestId("log-row-1");
    useGameStore.getState().spawnFlashes([{ eventId: 9, colorVar: "var(--hunt-3)", gen: 2 }]);
    rerender(<LogPanel />);
    const second = screen.getByTestId("log-row-1");
    expect(second).not.toBe(first); // a higher gen remounted the node
    expect(second.style.getPropertyValue("--hunt-color")).toBe("var(--hunt-3)");
  });
});

describe("LogPanel freeze control", () => {
  it("toggles freeze from the Freeze button and lights when frozen", () => {
    render(<LogPanel />);
    const button = screen.getByRole("button", { name: "Freeze" });
    expect(button.className).not.toMatch(/transport-freeze-on/);
    fireEvent.click(button);
    expect(useGameStore.getState().transport.frozen).toBe(true);
    expect(screen.getByRole("button", { name: "Freeze" }).className).toMatch(/transport-freeze-on/);
  });

  it("toggles freeze when Space is pressed", () => {
    render(<LogPanel />);
    fireEvent.keyDown(document.body, { code: "Space" });
    expect(useGameStore.getState().transport.frozen).toBe(true);
  });

  it("ignores Space while an editable target is focused", () => {
    render(<LogPanel />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { code: "Space" });
    expect(useGameStore.getState().transport.frozen).toBe(false);
    input.remove();
  });

  it("ignores a Space key repeat", () => {
    render(<LogPanel />);
    fireEvent.keyDown(document.body, { code: "Space", repeat: true });
    expect(useGameStore.getState().transport.frozen).toBe(false);
  });

  it("does not toggle freeze when Space lands on a focused Speed button", () => {
    render(<LogPanel />);
    const speed = screen.getByRole("button", { name: "2x" });
    speed.focus();
    // The listener stands down for any interactive target, so freeze stays off and the
    // speed button keeps its own native Space activation.
    fireEvent.keyDown(speed, { code: "Space" });
    expect(useGameStore.getState().transport.frozen).toBe(false);
  });

  it("stands down for a non-button focusable widget (a role=checkbox with tabindex)", () => {
    render(<LogPanel />);
    const widget = document.createElement("div");
    widget.setAttribute("role", "checkbox");
    widget.setAttribute("tabindex", "0");
    document.body.appendChild(widget);
    widget.focus();
    fireEvent.keyDown(widget, { code: "Space" });
    expect(useGameStore.getState().transport.frozen).toBe(false);
    widget.remove();
  });

  it("toggles exactly once when the focused Freeze button receives Space (native click, not the listener)", () => {
    render(<LogPanel />);
    const button = screen.getByRole("button", { name: "Freeze" });
    button.focus();
    // The panel's listener stands down for the focused button; the browser's native
    // click does the single toggle. Firing both proves the listener does not double it:
    // if it did not stand down, the keydown toggle plus the click toggle would cancel out.
    fireEvent.keyDown(button, { code: "Space" });
    fireEvent.click(button);
    expect(useGameStore.getState().transport.frozen).toBe(true);
  });

  it("ignores Space while an overlay is open (GH118-PLAN.md): the inert shell must not resume the run", () => {
    useGameStore.setState({ overlayOpen: true });
    render(<LogPanel />);
    fireEvent.keyDown(document.body, { code: "Space" });
    expect(useGameStore.getState().transport.frozen).toBe(false);
  });

  it("resumes handling Space once the overlay closes", () => {
    useGameStore.setState({ overlayOpen: true });
    render(<LogPanel />);
    fireEvent.keyDown(document.body, { code: "Space" });
    expect(useGameStore.getState().transport.frozen).toBe(false);

    act(() => {
      useGameStore.setState({ overlayOpen: false });
    });
    fireEvent.keyDown(document.body, { code: "Space" });
    expect(useGameStore.getState().transport.frozen).toBe(true);
  });
});

describe("LogPanel speed control", () => {
  it("dispatches setSpeed from each speed button", () => {
    render(<LogPanel />);
    fireEvent.click(screen.getByRole("button", { name: "2x" }));
    expect(useGameStore.getState().transport.speed).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "0.5x" }));
    expect(useGameStore.getState().transport.speed).toBe(0.5);
    fireEvent.click(screen.getByRole("button", { name: "1x" }));
    expect(useGameStore.getState().transport.speed).toBe(1);
  });

  it("lights the active speed button and only that one", () => {
    useGameStore.setState({ transport: { frozen: false, speed: 2 } });
    render(<LogPanel />);
    expect(screen.getByRole("button", { name: "2x" }).className).toMatch(/transport-speed-on/);
    expect(screen.getByRole("button", { name: "1x" }).className).not.toMatch(/transport-speed-on/);
    expect(screen.getByRole("button", { name: "0.5x" }).className).not.toMatch(
      /transport-speed-on/,
    );
  });
});

describe("LogPanel wave readout (#38 juice item 1)", () => {
  it("shows the countdown to the next wave, quantized to a 30-game-second bucket, while calm", () => {
    // ticksUntilNext 42 * GAME_SECONDS_PER_TICK (2) = 84 raw game-seconds,
    // which rounds up to the 90 bucket (ceil(84 / 30) * 30).
    setWave({ phase: "calm", index: 0, ticksUntilNext: 42, eventsPerTick: null });
    render(<LogPanel />);
    expect(screen.getByText("next wave in 90s")).toBeDefined();
  });

  it("swaps to the WAVE INCOMING readout while incoming", () => {
    setWave({ phase: "incoming", index: 0, ticksUntilNext: 5, eventsPerTick: null });
    render(<LogPanel />);
    expect(screen.getByText("◈ WAVE INCOMING")).toBeDefined();
    expect(screen.queryByText(/next wave in/)).toBeNull();
  });

  it("shows no readout while a wave is active (no countdown to show)", () => {
    setWave({ phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: 5 });
    render(<LogPanel />);
    expect(screen.queryByText(/next wave in/)).toBeNull();
    expect(screen.queryByText("◈ WAVE INCOMING")).toBeNull();
  });

  it("shows no readout after the last wave (calm with a null index)", () => {
    setWave({ phase: "calm", index: null, ticksUntilNext: null, eventsPerTick: null });
    render(<LogPanel />);
    expect(screen.queryByText(/next wave in/)).toBeNull();
    expect(screen.queryByText("◈ WAVE INCOMING")).toBeNull();
  });

  it("shows no readout for a steady run: the sampler publishes this same calm, null-index reading for the whole run (GH124-PLAN.md Checkpoint 3)", () => {
    useGameStore.setState({
      snapshot: {
        ...emptySnapshot(),
        wave: { phase: "calm", index: null, ticksUntilNext: null, eventsPerTick: null },
        scheduleMode: "steady",
      },
    });
    render(<LogPanel />);
    expect(screen.queryByText(/next wave in/)).toBeNull();
    expect(screen.queryByText("◈ WAVE INCOMING")).toBeNull();
  });
});

describe("LogPanel wave readout: concluded-run gate (GH38 review round 2, F003)", () => {
  it("shows no WAVE INCOMING readout and an empty status region once the run has failed", () => {
    setWaveAndStatus(
      { phase: "incoming", index: 0, ticksUntilNext: 5, eventsPerTick: null },
      "failed",
    );
    render(<LogPanel />);
    expect(screen.queryByText("◈ WAVE INCOMING")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("shows no 'next wave in' countdown once the run has failed, even while calm with a wave still scheduled", () => {
    setWaveAndStatus(
      { phase: "calm", index: 0, ticksUntilNext: 42, eventsPerTick: null },
      "failed",
    );
    render(<LogPanel />);
    expect(screen.queryByText(/next wave in/)).toBeNull();
  });

  it("shows no readout and an empty status region once the run has won", () => {
    setWaveAndStatus(
      { phase: "incoming", index: 0, ticksUntilNext: 5, eventsPerTick: null },
      "won",
    );
    render(<LogPanel />);
    expect(screen.queryByText("◈ WAVE INCOMING")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
  });
});

describe("LogPanel wave countdown bucketing (GH38 review round 4, F014)", () => {
  it("renders known tick values at their 30-game-second bucket", () => {
    // waveStateAt only reports "calm" once ticksUntilNext > WAVE_WARN_TICKS
    // (30); at or below that it is "incoming" instead. Both fixtures below
    // use the smallest producible-calm tick counts, not arbitrary round
    // numbers, so this test only encodes states the engine can actually emit.
    //
    // 60 ticks * GAME_SECONDS_PER_TICK (2) = 120 raw game-seconds, already a
    // bucket multiple, so it renders unchanged.
    setWave({ phase: "calm", index: 0, ticksUntilNext: 60, eventsPerTick: null });
    const { rerender } = render(<LogPanel />);
    expect(screen.getByText("next wave in 120s")).toBeDefined();

    // 31 ticks (the smallest tick count waveStateAt ever reports as "calm") *
    // 2 = 62 raw game-seconds, rounding up into the 90 bucket.
    setWave({ phase: "calm", index: 0, ticksUntilNext: 31, eventsPerTick: null });
    rerender(<LogPanel />);
    expect(screen.getByText("next wave in 90s")).toBeDefined();
  });

  it("renders adjacent tick values inside one 30s bucket identically", () => {
    // 31 ticks -> 62 raw seconds and 45 ticks -> 90 raw seconds both land in
    // the (60, 90] bucket, so both must render "90s" instead of drifting
    // downward sample to sample.
    setWave({ phase: "calm", index: 0, ticksUntilNext: 31, eventsPerTick: null });
    const { rerender } = render(<LogPanel />);
    const first = screen.getByText(/next wave in \d+s/).textContent;

    setWave({ phase: "calm", index: 0, ticksUntilNext: 45, eventsPerTick: null });
    rerender(<LogPanel />);
    const second = screen.getByText(/next wave in \d+s/).textContent;

    expect(first).toBe("next wave in 90s");
    expect(second).toBe(first);
  });

  it("renders bucket-boundary values differently", () => {
    // 45 ticks -> 90 raw seconds (bucket 90) vs 46 ticks -> 92 raw seconds
    // (bucket 120): one tick apart, but crossing the boundary must change
    // the displayed text.
    setWave({ phase: "calm", index: 0, ticksUntilNext: 45, eventsPerTick: null });
    const { rerender } = render(<LogPanel />);
    expect(screen.getByText("next wave in 90s")).toBeDefined();

    setWave({ phase: "calm", index: 0, ticksUntilNext: 46, eventsPerTick: null });
    rerender(<LogPanel />);
    expect(screen.getByText("next wave in 120s")).toBeDefined();
  });
});

describe("LogPanel wave readout accessibility (GH38 review round 1, fix 2)", () => {
  it("hides the fast-updating visible countdown from assistive tech", () => {
    // 31 is the smallest tick count `waveStateAt` can ever report as calm
    // (calm requires ticksUntilNext > WAVE_WARN_TICKS); 31 * 2s buckets to 90s.
    setWave({ phase: "calm", index: 0, ticksUntilNext: 31, eventsPerTick: null });
    render(<LogPanel />);
    const visible = screen.getByText("next wave in 90s");
    expect(visible.getAttribute("aria-hidden")).toBe("true");
  });

  it("hides the visible WAVE INCOMING text from assistive tech too", () => {
    setWave({ phase: "incoming", index: 0, ticksUntilNext: 5, eventsPerTick: null });
    render(<LogPanel />);
    const visible = screen.getByText("◈ WAVE INCOMING");
    expect(visible.getAttribute("aria-hidden")).toBe("true");
  });

  it("carries a role=status region that stays silent while calm", () => {
    setWave({ phase: "calm", index: 0, ticksUntilNext: 31, eventsPerTick: null });
    render(<LogPanel />);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("announces the incoming phase in the role=status region", () => {
    setWave({ phase: "incoming", index: 0, ticksUntilNext: 5, eventsPerTick: null });
    render(<LogPanel />);
    expect(screen.getByRole("status").textContent).toMatch(/wave incoming/i);
  });

  it("announces wave arrived once the wave goes active (GH38 review round 4, F007)", () => {
    setWave({ phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: 5 });
    render(<LogPanel />);
    expect(screen.getByRole("status").textContent).toMatch(/wave arrived/i);
  });
});

describe("LogPanel wave flash (one-shot on incoming -> active)", () => {
  it("adds .waveflash to the log column on the edge, then clears it after the animation", () => {
    vi.useFakeTimers();
    try {
      setWave({ phase: "incoming", index: 0, ticksUntilNext: 1, eventsPerTick: null });
      const { container } = render(<LogPanel />);
      const panel = container.querySelector(".log-panel");
      expect(panel?.className).not.toMatch(/waveflash/);

      act(() => {
        setWave({ phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: 5 });
      });
      expect(panel?.className).toMatch(/waveflash/);

      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(panel?.className).not.toMatch(/waveflash/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not flash on a rerender that is not an incoming -> active edge", () => {
    setWave({ phase: "calm", index: 0, ticksUntilNext: 10, eventsPerTick: null });
    const { container } = render(<LogPanel />);
    const panel = container.querySelector(".log-panel");
    act(() => {
      setWave({ phase: "incoming", index: 0, ticksUntilNext: 5, eventsPerTick: null });
    });
    expect(panel?.className).not.toMatch(/waveflash/);
  });
});

describe("LogPanel animated cues gate on run conclusion (GH38 review round 3, F004+F006)", () => {
  it("never flashes when the incoming -> active edge lands in the same update the run concludes", () => {
    vi.useFakeTimers();
    try {
      setWaveAndStatus(
        { phase: "incoming", index: 0, ticksUntilNext: 1, eventsPerTick: null },
        "running",
      );
      const { container } = render(<LogPanel />);
      const panel = container.querySelector(".log-panel");
      expect(panel?.className).not.toMatch(/waveflash/);

      act(() => {
        setWaveAndStatus(
          { phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: 5 },
          "failed",
        );
      });
      expect(panel?.className).not.toMatch(/waveflash/);

      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(panel?.className).not.toMatch(/waveflash/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still flashes across the incoming -> active edge while the run keeps running", () => {
    vi.useFakeTimers();
    try {
      setWaveAndStatus(
        { phase: "incoming", index: 0, ticksUntilNext: 1, eventsPerTick: null },
        "running",
      );
      const { container } = render(<LogPanel />);
      const panel = container.querySelector(".log-panel");

      act(() => {
        setWaveAndStatus(
          { phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: 5 },
          "running",
        );
      });
      expect(panel?.className).toMatch(/waveflash/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears an in-flight flash immediately when the run concludes mid-animation, without waiting for the timer (GH38 review)", () => {
    vi.useFakeTimers();
    try {
      setWaveAndStatus(
        { phase: "incoming", index: 0, ticksUntilNext: 1, eventsPerTick: null },
        "running",
      );
      const { container } = render(<LogPanel />);
      const panel = container.querySelector(".log-panel");

      act(() => {
        setWaveAndStatus(
          { phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: 5 },
          "running",
        );
      });
      expect(panel?.className).toMatch(/waveflash/);

      // The run concludes mid-flash, well before the flash's own timer would clear it.
      act(() => {
        setWaveAndStatus(
          { phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: 5 },
          "failed",
        );
      });
      expect(panel?.className).not.toMatch(/waveflash/);
    } finally {
      vi.useRealTimers();
    }
  });
});
