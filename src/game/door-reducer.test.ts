import { describe, expect, it } from "vitest";
import { createDoorReducer, type DoorGrant } from "./door-reducer";

const STORE: DoorGrant = { location: "dep", door: "STORE" };
const YARD: DoorGrant = { location: "dep", door: "YARD" };

describe("createDoorReducer", () => {
  it("opens a door on a grant and reports it open", () => {
    const reducer = createDoorReducer(8);
    const events = reducer.step([STORE], 0);
    expect(events).toEqual([{ location: "dep", door: "STORE", event: "open" }]);
    expect(reducer.openDoors()).toEqual([{ location: "dep", door: "STORE" }]);
  });

  it("closes the door after its dwell, and not before", () => {
    const reducer = createDoorReducer(8);
    reducer.step([STORE], 0);
    // Nothing happens on the ticks inside the dwell window.
    for (let tick = 1; tick < 8; tick++) {
      expect(reducer.step([], tick)).toEqual([]);
      expect(reducer.openDoors()).toHaveLength(1);
    }
    // At openedTick + dwell it closes.
    expect(reducer.step([], 8)).toEqual([{ location: "dep", door: "STORE", event: "close" }]);
    expect(reducer.openDoors()).toEqual([]);
  });

  it("is order-independent: the same grants in any order give the same events and state", () => {
    const forward = createDoorReducer(8);
    const backward = createDoorReducer(8);
    const a = forward.step([STORE, YARD], 3);
    const b = backward.step([YARD, STORE], 3);
    expect(a).toEqual(b);
    expect(forward.openDoors()).toEqual(backward.openDoors());
  });

  it("does not re-open a door that is already open", () => {
    const reducer = createDoorReducer(8);
    reducer.step([STORE], 0);
    // A second grant for the same door mid-dwell emits nothing new.
    expect(reducer.step([STORE], 2)).toEqual([]);
    expect(reducer.openDoors()).toHaveLength(1);
  });

  it("re-opens a door with a fresh grant after it has closed", () => {
    const reducer = createDoorReducer(4);
    reducer.step([STORE], 0);
    reducer.step([], 4); // closes
    expect(reducer.step([STORE], 5)).toEqual([{ location: "dep", door: "STORE", event: "open" }]);
  });

  it("emits close events before open events within one tick, each in a stable order", () => {
    const reducer = createDoorReducer(4);
    reducer.step([STORE], 0); // STORE opens at 0, closes at 4
    // At tick 4, STORE closes and YARD opens; closes come first, deterministically.
    expect(reducer.step([YARD], 4)).toEqual([
      { location: "dep", door: "STORE", event: "close" },
      { location: "dep", door: "YARD", event: "open" },
    ]);
  });
});
