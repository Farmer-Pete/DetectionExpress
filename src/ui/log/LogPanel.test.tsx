import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGameStore } from "../../game/store";
import type { RingEvent } from "../../sim/inspector";
import { emptySnapshot, type SimSnapshot } from "../../sim/snapshot";
import { LogPanel } from "./LogPanel";

/** Publish a snapshot carrying only the given wave reading; everything else stays empty. */
function setWave(wave: SimSnapshot["wave"]): void {
  useGameStore.setState({ snapshot: { ...emptySnapshot(), wave } });
}

/** Publish a snapshot carrying the given wave reading and run status. */
function setWaveAndStatus(wave: SimSnapshot["wave"], status: SimSnapshot["status"]): void {
  useGameStore.setState({ snapshot: { ...emptySnapshot(), wave, status } });
}

function kioskEvent(id: number, overrides: Partial<RingEvent> = {}): RingEvent {
  return {
    id,
    ts: id * 2,
    endpoint: "kiosk-v1",
    raw: { t: id * 2, acct: `acct-${id}`, term: `term-${id}`, res: "OK" },
    normalized: { acct: `acct-${id}`, term: `term-${id}`, res: "OK" },
    ...overrides,
  };
}

function setSnapshot(events: RingEvent[], processed: number, admitted: number): void {
  useGameStore.setState({
    snapshot: { ...emptySnapshot(), events, processed, admitted },
  });
}

beforeEach(() => {
  useGameStore.setState({
    snapshot: emptySnapshot(),
    transport: { frozen: false, speed: 1 },
  });
});

describe("LogPanel", () => {
  it("renders rows newest first, highest id at the top", () => {
    setSnapshot([kioskEvent(0), kioskEvent(1), kioskEvent(2)], 0, 3);
    render(<LogPanel />);
    const rows = screen.getAllByTestId(/^log-row-/);
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "log-row-2",
      "log-row-1",
      "log-row-0",
    ]);
  });

  it("dims rows with id >= processed and renders earlier rows normal", () => {
    setSnapshot([kioskEvent(0), kioskEvent(1), kioskEvent(2)], 1, 3);
    render(<LogPanel />);
    expect(screen.getByTestId("log-row-0").className).not.toMatch(/log-row-pending/);
    expect(screen.getByTestId("log-row-1").className).toMatch(/log-row-pending/);
    expect(screen.getByTestId("log-row-2").className).toMatch(/log-row-pending/);
  });

  it("marks the visible row whose id equals processed as the cursor", () => {
    setSnapshot([kioskEvent(0), kioskEvent(1), kioskEvent(2)], 1, 3);
    render(<LogPanel />);
    expect(screen.getByTestId("log-row-1").className).toMatch(/log-row-cursor/);
    expect(screen.getByTestId("log-row-0").className).not.toMatch(/log-row-cursor/);
    expect(screen.getByTestId("log-row-2").className).not.toMatch(/log-row-cursor/);
  });

  it("shows no cursor and no sticky bar when caught up (processed === admitted)", () => {
    setSnapshot([kioskEvent(0), kioskEvent(1)], 2, 2);
    render(<LogPanel />);
    expect(document.querySelector(".log-row-cursor")).toBeNull();
    expect(screen.queryByTestId("log-sticky")).toBeNull();
  });

  it("shows the sticky bar when the queue is deeper than the visible ring", () => {
    // The ring only kept the newest events; processed (0) fell off long ago.
    const events = [kioskEvent(1000), kioskEvent(1001), kioskEvent(1002)];
    setSnapshot(events, 0, 1006);
    render(<LogPanel />);
    expect(screen.getByTestId("log-sticky").textContent).toContain("1006");
  });

  it("shows the sticky bar when the ring is empty but the queue is positive", () => {
    setSnapshot([], 0, 5);
    render(<LogPanel />);
    expect(screen.getByTestId("log-sticky").textContent).toContain("5");
  });

  it("shows the sticky bar when the ring is non-empty but no event matches processed yet", () => {
    const events = [kioskEvent(5), kioskEvent(6), kioskEvent(7)];
    setSnapshot(events, 4, 8);
    render(<LogPanel />);
    expect(screen.getByTestId("log-sticky").textContent).toContain("4");
  });

  it("sizes the queue bar width from admitted - processed, up to the full-scale max", () => {
    setSnapshot([], 0, 25); // half of LOG_QUEUE_MAX (50)
    const { rerender } = render(<LogPanel />);
    const fill = screen.getByTestId("queue-bar-fill");
    expect(fill.style.width).toBe("50%");

    setSnapshot([], 0, 200); // far past LOG_QUEUE_MAX, clamps to 100%
    rerender(<LogPanel />);
    expect(screen.getByTestId("queue-bar-fill").style.width).toBe("100%");
  });

  it("shows the plain queue count alongside the bar", () => {
    setSnapshot([], 10, 35);
    render(<LogPanel />);
    expect(screen.getByText("25 queued")).toBeDefined();
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
  it("shows the countdown to the next wave, in whole game-seconds, while calm", () => {
    // ticksUntilNext 42 * GAME_SECONDS_PER_TICK (2) = 84.
    setWave({ phase: "calm", index: 0, ticksUntilNext: 42, eventsPerTick: null });
    render(<LogPanel />);
    expect(screen.getByText("next wave in 84s")).toBeDefined();
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

describe("LogPanel wave countdown seconds (GH38 review round 1, fix 3)", () => {
  it("renders known tick values as whole game-seconds", () => {
    setWave({ phase: "calm", index: 0, ticksUntilNext: 30, eventsPerTick: null });
    const { rerender } = render(<LogPanel />);
    expect(screen.getByText("next wave in 60s")).toBeDefined();

    setWave({ phase: "calm", index: 0, ticksUntilNext: 1, eventsPerTick: null });
    rerender(<LogPanel />);
    expect(screen.getByText("next wave in 2s")).toBeDefined();
  });

  it("ceils a fractional tick countdown so it steps once per whole second, not once per sample", () => {
    // Real ticksUntilNext values are always whole ticks, so at the shipped
    // GAME_SECONDS_PER_TICK (2, a whole number) no two distinct real tick counts
    // ever land in the same second. This directly exercises the ceil quantization
    // that guards against that changing: two samples a fraction of a tick apart,
    // 29.1 and 29.5, both multiply into the (58, 59] bucket and must render
    // identically instead of flickering between adjacent samples.
    setWave({ phase: "calm", index: 0, ticksUntilNext: 29.1, eventsPerTick: null });
    const { rerender } = render(<LogPanel />);
    const first = screen.getByText(/next wave in \d+s/).textContent;

    setWave({ phase: "calm", index: 0, ticksUntilNext: 29.5, eventsPerTick: null });
    rerender(<LogPanel />);
    const second = screen.getByText(/next wave in \d+s/).textContent;

    expect(first).toBe("next wave in 59s");
    expect(second).toBe(first);
  });
});

describe("LogPanel wave readout accessibility (GH38 review round 1, fix 2)", () => {
  it("hides the fast-updating visible countdown from assistive tech", () => {
    setWave({ phase: "calm", index: 0, ticksUntilNext: 30, eventsPerTick: null });
    render(<LogPanel />);
    const visible = screen.getByText("next wave in 60s");
    expect(visible.getAttribute("aria-hidden")).toBe("true");
  });

  it("hides the visible WAVE INCOMING text from assistive tech too", () => {
    setWave({ phase: "incoming", index: 0, ticksUntilNext: 5, eventsPerTick: null });
    render(<LogPanel />);
    const visible = screen.getByText("◈ WAVE INCOMING");
    expect(visible.getAttribute("aria-hidden")).toBe("true");
  });

  it("carries a role=status region that stays silent while calm", () => {
    setWave({ phase: "calm", index: 0, ticksUntilNext: 30, eventsPerTick: null });
    render(<LogPanel />);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("announces the incoming phase in the role=status region", () => {
    setWave({ phase: "incoming", index: 0, ticksUntilNext: 5, eventsPerTick: null });
    render(<LogPanel />);
    expect(screen.getByRole("status").textContent).toMatch(/wave incoming/i);
  });

  it("falls silent again in the role=status region once the wave goes active", () => {
    setWave({ phase: "active", index: 0, ticksUntilNext: null, eventsPerTick: 5 });
    render(<LogPanel />);
    expect(screen.getByRole("status").textContent).toBe("");
  });
});

describe("LogPanel queue-bar danger pulse (#38 juice item 2)", () => {
  it("adds the pulse class at danger severity", () => {
    setSnapshot([], 0, 45); // 45 / LOG_QUEUE_MAX(50) = 0.9, past SEVERITY_DANGER_FRAC (0.8)
    render(<LogPanel />);
    expect(screen.getByTestId("queue-bar-fill").className).toMatch(/queue-bar-danger/);
  });

  it("omits the pulse class below danger severity", () => {
    setSnapshot([], 0, 10); // 10 / 50 = 0.2
    render(<LogPanel />);
    expect(screen.getByTestId("queue-bar-fill").className).not.toMatch(/queue-bar-danger/);
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
