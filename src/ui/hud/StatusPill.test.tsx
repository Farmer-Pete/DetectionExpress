import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useGameStore } from "../../game/store";
import { emptySnapshot } from "../../sim/snapshot";
import { StatusPill } from "./StatusPill";

beforeEach(() => {
  useGameStore.setState({ snapshot: emptySnapshot() });
});

describe("StatusPill", () => {
  it("reads Running before any outcome, as a live region", () => {
    render(<StatusPill />);
    const pill = screen.getByRole("status");
    expect(pill.textContent).toBe("Running");
  });

  it("shows the win outcome", () => {
    useGameStore.setState({
      snapshot: { ...emptySnapshot(), status: "won", failureReason: null },
    });
    render(<StatusPill />);
    expect(screen.getByText("Won")).toBeDefined();
  });

  it("shows the queue failure reason", () => {
    useGameStore.setState({
      snapshot: { ...emptySnapshot(), status: "failed", failureReason: "queue" },
    });
    render(<StatusPill />);
    expect(screen.getByText("Failed: Queue overflowed")).toBeDefined();
  });

  it("shows the correctness failure reason", () => {
    useGameStore.setState({
      snapshot: { ...emptySnapshot(), status: "failed", failureReason: "correctness" },
    });
    render(<StatusPill />);
    expect(screen.getByText("Failed: Correctness too low")).toBeDefined();
  });

  it("reads Steady while running in steady schedule mode (GH124-PLAN.md Checkpoint 3)", () => {
    useGameStore.setState({
      snapshot: { ...emptySnapshot(), status: "running", scheduleMode: "steady" },
    });
    render(<StatusPill />);
    expect(screen.getByText("Steady")).toBeDefined();
  });

  it("reads Running while running in waves schedule mode", () => {
    useGameStore.setState({
      snapshot: { ...emptySnapshot(), status: "running", scheduleMode: "waves" },
    });
    render(<StatusPill />);
    expect(screen.getByText("Running")).toBeDefined();
  });
});
