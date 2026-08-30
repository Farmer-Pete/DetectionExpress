import { describe, expect, it } from "vitest";
import { type CameraGrant, createCameraReducer } from "./camera-reducer";

const CEN: CameraGrant = { station: "cen", gate: "cen:gate" };
const MKT: CameraGrant = { station: "mkt", gate: "mkt:gate" };

describe("createCameraReducer", () => {
  it("counts grants over its window, with persons equal to grants for a benign crowd", () => {
    const reducer = createCameraReducer(8);
    // Three benign taps at Central over ticks 0, 1, 2, all inside the window.
    reducer.step([CEN], 0);
    reducer.step([CEN], 1);
    const counts = reducer.step([CEN], 2);
    // The window sees exactly the three grants it was fed; benign, so persons == grants.
    expect(counts).toEqual([{ station: "cen", gate: "cen:gate", grants: 3, persons: 3 }]);
  });

  it("groups grants by gate and sorts the per-gate counts by gate", () => {
    const reducer = createCameraReducer(8);
    const counts = reducer.step([MKT, CEN, CEN], 0);
    // Two gates this tick: Central saw two grants, Market one. Sorted by gate id.
    expect(counts).toEqual([
      { station: "cen", gate: "cen:gate", grants: 2, persons: 2 },
      { station: "mkt", gate: "mkt:gate", grants: 1, persons: 1 },
    ]);
  });

  it("is order-independent: the same tick's grants in any order give the same counts", () => {
    const forward = createCameraReducer(8);
    const backward = createCameraReducer(8);
    const a = forward.step([CEN, CEN, MKT], 3);
    const b = backward.step([MKT, CEN, CEN], 3);
    expect(a).toEqual(b);
  });

  it("drops a grant's count as it ages out of the window", () => {
    const reducer = createCameraReducer(4);
    reducer.step([CEN], 0); // a grant at tick 0
    reducer.step([CEN], 1); // a grant at tick 1
    // At tick 3 both grants are still inside the 4-tick window: the count is 2.
    expect(reducer.step([], 3)).toEqual([
      { station: "cen", gate: "cen:gate", grants: 2, persons: 2 },
    ]);
    // At tick 4 the tick-0 grant ages out (4 - 0 >= 4); only the tick-1 grant remains.
    expect(reducer.step([], 4)).toEqual([
      { station: "cen", gate: "cen:gate", grants: 1, persons: 1 },
    ]);
  });

  it("drops a gate from the counts once all its grants have aged out", () => {
    const reducer = createCameraReducer(4);
    reducer.step([CEN], 0);
    // At tick 4 the only grant has aged out, so the gate no longer appears.
    expect(reducer.step([], 4)).toEqual([]);
  });

  it("keeps the ring bounded over a long run: the count stabilizes at the window size", () => {
    const reducer = createCameraReducer(10);
    let last: ReturnType<typeof reducer.step> = [];
    for (let tick = 0; tick < 5000; tick++) {
      last = reducer.step([CEN], tick);
    }
    // One grant per tick over a 10-tick window sums to exactly 10 and never grows,
    // so a leaked bucket (which would push the sum toward 5000) is ruled out.
    expect(last).toEqual([{ station: "cen", gate: "cen:gate", grants: 10, persons: 10 }]);
  });
});
