import { afterEach, describe, expect, it } from "vitest";
import { Clock, ManualDriver } from "./clock";
import { bindVisibility } from "./visibility";

/** Force `document.hidden` for one test. */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

/** Fire n ticks in a row. These tests only read the tick count, so a burst is fine. */
function tickN(driver: ManualDriver, n: number): void {
  for (let i = 0; i < n; i++) {
    driver.tick();
  }
}

afterEach(() => {
  setHidden(false);
});

describe("bindVisibility", () => {
  it("begins paused when the tab starts hidden", () => {
    setHidden(true);
    const driver = new ManualDriver();
    const clock = new Clock(60, driver);
    const detach = bindVisibility(clock);
    tickN(driver, 10);
    expect(clock.now()).toBe(0); // paused: no advance
    detach();
    clock.stop();
  });

  it("runs when the tab starts visible", () => {
    setHidden(false);
    const driver = new ManualDriver();
    const clock = new Clock(60, driver);
    const detach = bindVisibility(clock);
    tickN(driver, 10);
    expect(clock.now()).toBe(10);
    detach();
    clock.stop();
  });

  it("pauses on hide and resumes on show", () => {
    setHidden(false);
    const driver = new ManualDriver();
    const clock = new Clock(60, driver);
    const detach = bindVisibility(clock);
    tickN(driver, 5);
    expect(clock.now()).toBe(5);

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    tickN(driver, 100);
    expect(clock.now()).toBe(5); // paused: hidden ticks do not advance

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    tickN(driver, 3);
    expect(clock.now()).toBe(8); // resumed
    detach();
    clock.stop();
  });

  it("stops reacting to visibilitychange after detach", () => {
    setHidden(false);
    const driver = new ManualDriver();
    const clock = new Clock(60, driver);
    const detach = bindVisibility(clock);
    detach();

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    tickN(driver, 5);
    expect(clock.now()).toBe(5); // the listener is gone, so no pause
    clock.stop();
  });
});
