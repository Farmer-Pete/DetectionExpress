import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useGameStore } from "../../game/store";
import { emptySnapshot, type WaveOutcome } from "../../sim/snapshot";
import { WaveOutcomeBanner } from "./WaveOutcomeBanner";

function setWaveOutcome(waveOutcome: WaveOutcome | null): void {
  useGameStore.setState({ snapshot: { ...emptySnapshot(), waveOutcome } });
}

beforeEach(() => {
  setWaveOutcome(null);
});

describe("WaveOutcomeBanner", () => {
  it("renders nothing while no wave outcome is fresh", () => {
    setWaveOutcome(null);
    render(<WaveOutcomeBanner />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a held outcome with the caught-of-total count, as a polite live status", () => {
    setWaveOutcome({
      waveId: 1,
      outcome: "held",
      attackCount: 5,
      caughtCount: 5,
      allCaught: true,
      queuePeak: 3,
    });
    render(<WaveOutcomeBanner />);
    const banner = screen.getByRole("status");
    expect(banner.getAttribute("aria-live")).toBe("polite");
    expect(banner.textContent).toMatch(/threat contained/i);
    expect(banner.textContent).toMatch(/5\/5/);
  });

  it("shows a breach outcome with the caught-of-total count", () => {
    setWaveOutcome({
      waveId: 2,
      outcome: "breach",
      attackCount: 5,
      caughtCount: 2,
      allCaught: false,
      queuePeak: 12,
    });
    render(<WaveOutcomeBanner />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toMatch(/breach/i);
    expect(banner.textContent).toMatch(/2\/5/);
  });
});
