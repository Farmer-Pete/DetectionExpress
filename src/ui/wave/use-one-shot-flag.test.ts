import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOneShotFlag } from "./use-one-shot-flag";

function setup(initialToken: number, durationMs: number) {
  return renderHook(({ token }) => useOneShotFlag(token, durationMs), {
    initialProps: { token: initialToken },
  });
}

describe("useOneShotFlag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays false while the token is 0", () => {
    const { result } = setup(0, 300);
    expect(result.current).toBe(false);
  });

  it("goes true when the token changes, then false after the duration", () => {
    const { result, rerender } = setup(0, 300);
    rerender({ token: 1 });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe(false);
  });

  it("stays true until the duration elapses", () => {
    const { result, rerender } = setup(0, 300);
    rerender({ token: 1 });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe(true);
  });

  it("re-arms on a later token change", () => {
    const { result, rerender } = setup(0, 300);
    rerender({ token: 1 });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe(false);
    rerender({ token: 2 });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe(false);
  });

  it("clears its timer on unmount", () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const { rerender, unmount } = setup(0, 300);
    rerender({ token: 1 });
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
