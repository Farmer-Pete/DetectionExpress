import { describe, expect, it } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { DevState } from "../game/dev-host-client";
import { DevKitPanel } from "./DevKitPanel";

/** A test harness that drives the panel's dev state through the `subscribe` seam. */
function harness() {
  let listener: ((state: DevState) => void) | null = null;
  let edits = 0;
  let stops = 0;
  const props = {
    onEditInIde: () => {
      edits += 1;
    },
    onStopEditing: () => {
      stops += 1;
    },
    subscribe: (received: (state: DevState) => void): (() => void) => {
      listener = received;
      return () => {
        listener = null;
      };
    },
  };
  const push = (state: DevState): void => {
    act(() => {
      listener?.(state);
    });
  };
  return { props, push, edits: () => edits, stops: () => stops };
}

describe("DevKitPanel", () => {
  it("offers 'Edit in my IDE' before a file is active", () => {
    const h = harness();
    render(<DevKitPanel {...h.props} />);
    expect(screen.getByRole("button", { name: "Edit in my IDE" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Stop editing" })).toBeNull();
  });

  it("calls onEditInIde when the button is clicked", () => {
    const h = harness();
    render(<DevKitPanel {...h.props} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit in my IDE" }));
    expect(h.edits()).toBe(1);
  });

  it("shows the active path and a 'Stop editing' control once a file is active", () => {
    const h = harness();
    render(<DevKitPanel {...h.props} />);
    h.push({
      status: "connected",
      path: "/algorithms/detection-express-kiosk-pin-attack.js",
      message: null,
    });

    expect(screen.getByText("/algorithms/detection-express-kiosk-pin-attack.js")).toBeDefined();
    expect(screen.getByRole("button", { name: "Stop editing" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Edit in my IDE" })).toBeNull();
  });

  it("calls onStopEditing and returns to the edit button after a stop", () => {
    const h = harness();
    render(<DevKitPanel {...h.props} />);
    h.push({ status: "connected", path: "/algorithms/x.js", message: null });

    fireEvent.click(screen.getByRole("button", { name: "Stop editing" }));
    expect(h.stops()).toBe(1);

    // The App drives the panel back to the off state on stop; the edit button returns.
    h.push({ status: "off", path: null, message: null });
    expect(screen.getByRole("button", { name: "Edit in my IDE" })).toBeDefined();
  });

  it("surfaces a host message on the status line", () => {
    const h = harness();
    render(<DevKitPanel {...h.props} />);
    h.push({ status: "error", path: null, message: "Could not open the level file." });
    expect(screen.getByRole("status").textContent).toBe("Could not open the level file.");
  });
});
