import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WavePhase } from "../../sim/wave-state";
import { useWavePhaseEdge } from "./use-wave-phase-edge";

function setup(initial: WavePhase) {
  return renderHook(({ phase }) => useWavePhaseEdge(phase), { initialProps: { phase: initial } });
}

describe("useWavePhaseEdge", () => {
  it("starts with no edge fired", () => {
    const { result } = setup("calm");
    expect(result.current).toBe(0);
  });

  it("fires exactly once on an incoming -> active transition", () => {
    const { result, rerender } = setup("incoming");
    rerender({ phase: "active" });
    expect(result.current).toBe(1);
  });

  it("does not fire again on an unrelated rerender at the same phase", () => {
    const { result, rerender } = setup("incoming");
    rerender({ phase: "active" });
    expect(result.current).toBe(1);
    rerender({ phase: "active" }); // no phase change: not a new edge
    expect(result.current).toBe(1);
  });

  it("does not fire on a calm -> incoming transition", () => {
    const { result, rerender } = setup("calm");
    rerender({ phase: "incoming" });
    expect(result.current).toBe(0);
  });

  it("does not fire on an active -> calm transition (the wave simply ends)", () => {
    const { result, rerender } = setup("active");
    rerender({ phase: "calm" });
    expect(result.current).toBe(0);
  });

  it("re-arms: a later wave's incoming -> active edge fires again", () => {
    const { result, rerender } = setup("incoming");
    rerender({ phase: "active" });
    expect(result.current).toBe(1);
    rerender({ phase: "calm" });
    rerender({ phase: "incoming" });
    rerender({ phase: "active" });
    expect(result.current).toBe(2);
  });
});
