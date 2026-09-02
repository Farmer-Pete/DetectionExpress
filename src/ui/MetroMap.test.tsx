import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MapSelection } from "../game/store";
import { useGameStore } from "../game/store";
import { emptySnapshot } from "../sim/snapshot";
import { MetroMap } from "./MetroMap";

beforeEach(() => {
  // The map mounts the actor layer, which reads the game store; seed a snapshot so
  // the injected state is well-formed.
  useGameStore.setState({
    snapshot: {
      ...emptySnapshot(),
      nowTick: 10,
      actors: [
        {
          id: "C1",
          kind: "rider",
          presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
        },
        {
          id: "T1",
          kind: "train",
          presence: { kind: "at", node: "cen", fromTick: 0, untilTick: 20 },
        },
      ],
    },
    transport: { frozen: false, speed: 1 },
  });
});

describe("MetroMap", () => {
  it("renders every station by name", () => {
    render(<MetroMap onSelect={() => {}} />);
    expect(screen.getByText("Central")).toBeDefined();
    expect(screen.getByText("Harbor")).toBeDefined();
    expect(screen.getByText("World's End")).toBeDefined();
  });

  it("draws each line as a polyline in its world-data color", () => {
    const { container } = render(<MetroMap onSelect={() => {}} />);
    const red = container.querySelector('[data-line="red"]');
    const circle = container.querySelector('[data-line="circle"]');
    expect(red?.getAttribute("stroke")).toBe("#e6394a");
    expect(circle?.getAttribute("stroke")).toBe("#f2a900");
    // The Red Line runs five stations, so its polyline has five points.
    expect(red?.getAttribute("points")?.trim().split(/\s+/)).toHaveLength(5);
  });

  it("renders sites and the OCC with zone badges, no tinted regions", () => {
    render(<MetroMap onSelect={() => {}} />);
    expect(screen.getByText("Eastyard Depot")).toBeDefined();
    expect(screen.getByText("Operations Control Center")).toBeDefined();
    // Three sites sit in zone 3; the OCC sits in zone 4.
    expect(screen.getAllByText("Z3")).toHaveLength(3);
    expect(screen.getByText("Z4")).toBeDefined();
  });

  it("draws each node's sensor chips as static fixtures", () => {
    const { container } = render(<MetroMap onSelect={() => {}} />);
    // Every station carries a fare-gate chip; the OCC carries a console chip.
    const gates = container.querySelectorAll('[data-station] [data-chip="G"]');
    expect(gates.length).toBe(9);
    expect(container.querySelector('[data-site="occ"] [data-chip="O"]')).not.toBeNull();
  });

  it("draws each chip as a lucide icon, not a bare colored square", () => {
    const { container } = render(<MetroMap onSelect={() => {}} />);
    const gateChip = container.querySelector('[data-station] [data-chip="G"]');
    expect(gateChip?.querySelector("svg.lucide-log-in")).not.toBeNull();
  });

  it("is a neutral group, not role=img, so its interactive descendants are reachable", () => {
    render(<MetroMap onSelect={() => {}} />);
    expect(screen.getByRole("group", { name: "Metro network map" })).toBeDefined();
    expect(screen.queryByRole("img", { name: "Metro network map" })).toBeNull();
  });

  it("selects a station by name, on click and on Enter, as a named button", () => {
    const onSelect = vi.fn<(selection: MapSelection) => void>();
    render(<MetroMap onSelect={onSelect} />);
    const central = screen.getByRole("button", { name: "Central" });

    fireEvent.click(central);
    expect(onSelect).toHaveBeenCalledWith({ kind: "node", id: "cen" });

    onSelect.mockClear();
    fireEvent.keyDown(central, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({ kind: "node", id: "cen" });
  });

  it("selects a station on Space too", () => {
    const onSelect = vi.fn<(selection: MapSelection) => void>();
    render(<MetroMap onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Central" }), { key: " " });
    expect(onSelect).toHaveBeenCalledWith({ kind: "node", id: "cen" });
  });

  it("selects a site by name, on click and on Enter, as a named button", () => {
    const onSelect = vi.fn<(selection: MapSelection) => void>();
    render(<MetroMap onSelect={onSelect} />);
    const depot = screen.getByRole("button", { name: "Eastyard Depot" });

    fireEvent.click(depot);
    expect(onSelect).toHaveBeenCalledWith({ kind: "node", id: "dep" });

    onSelect.mockClear();
    fireEvent.keyDown(depot, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({ kind: "node", id: "dep" });
  });

  it("selects the OCC by name", () => {
    const onSelect = vi.fn<(selection: MapSelection) => void>();
    render(<MetroMap onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Operations Control Center" }));
    expect(onSelect).toHaveBeenCalledWith({ kind: "node", id: "occ" });
  });

  it("selects a train through its focusable hit target, on click and on Enter", () => {
    const onSelect = vi.fn<(selection: MapSelection) => void>();
    render(<MetroMap onSelect={onSelect} />);
    const train = screen.getByRole("button", { name: "Open T1" });

    fireEvent.click(train);
    expect(onSelect).toHaveBeenCalledWith({ kind: "train", actorId: "T1" });

    onSelect.mockClear();
    fireEvent.keyDown(train, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({ kind: "train", actorId: "T1" });
  });

  it("exposes every train hit target even for a train not currently in the snapshot", () => {
    // The four trains are fixed world-data fixtures; the hit target set never
    // shrinks just because a train has not published a frame yet.
    render(<MetroMap onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: "Open T2" })).toBeDefined();
  });

  it("keeps a hit target unplaced until its train publishes a placement", async () => {
    // Every rect starts `data-unplaced` (hidden via CSS), so before its train's first
    // frame it is not a transparent click/tab target at the SVG origin. Only T1 is in
    // the seeded snapshot, so the frame loop places it and clears the flag; T2 never
    // publishes a frame and stays unplaced.
    render(<MetroMap onSelect={() => {}} />);
    const t2 = screen.getByRole("button", { name: "Open T2" });
    expect(t2.getAttribute("data-unplaced")).not.toBeNull();

    const t1 = screen.getByRole("button", { name: "Open T1" });
    await waitFor(() => expect(t1.getAttribute("data-unplaced")).toBeNull());
    expect(t2.getAttribute("data-unplaced")).not.toBeNull();
  });
});
