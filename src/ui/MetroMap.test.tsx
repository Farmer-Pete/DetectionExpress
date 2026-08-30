import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useWorldStore } from "../game/world-store";
import { emptyWorldSnapshot } from "../sim/world-snapshot";
import { MetroMap } from "./MetroMap";

beforeEach(() => {
  // The map mounts the actor layer, which reads the world store; seed a snapshot so
  // the injected state is well-formed.
  useWorldStore.setState({
    worldSnapshot: {
      ...emptyWorldSnapshot(),
      nowTick: 10,
      actors: [
        {
          id: "C1",
          kind: "rider",
          presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
        },
      ],
      counts: { riders: 1, trains: 0, staff: 0 },
    },
  });
});

describe("MetroMap", () => {
  it("renders every station by name", () => {
    render(<MetroMap />);
    expect(screen.getByText("Central")).toBeDefined();
    expect(screen.getByText("Harbor")).toBeDefined();
    expect(screen.getByText("World's End")).toBeDefined();
  });

  it("draws each line as a polyline in its world.json color", () => {
    const { container } = render(<MetroMap />);
    const red = container.querySelector('[data-line="red"]');
    const circle = container.querySelector('[data-line="circle"]');
    expect(red?.getAttribute("stroke")).toBe("#e6394a");
    expect(circle?.getAttribute("stroke")).toBe("#f2a900");
    // The Red Line runs five stations, so its polyline has five points.
    expect(red?.getAttribute("points")?.trim().split(/\s+/)).toHaveLength(5);
  });

  it("renders sites and the OCC with zone badges, no tinted regions", () => {
    render(<MetroMap />);
    expect(screen.getByText("Eastyard Depot")).toBeDefined();
    expect(screen.getByText("Operations Control Center")).toBeDefined();
    // Three sites sit in zone 3; the OCC sits in zone 4.
    expect(screen.getAllByText("Z3")).toHaveLength(3);
    expect(screen.getByText("Z4")).toBeDefined();
  });

  it("draws each node's sensor chips as static fixtures", () => {
    const { container } = render(<MetroMap />);
    // Every station carries a fare-gate chip; the OCC carries a console chip.
    const gates = container.querySelectorAll('[data-station] [data-chip="G"]');
    expect(gates.length).toBe(9);
    expect(container.querySelector('[data-site="occ"] [data-chip="O"]')).not.toBeNull();
  });
});
