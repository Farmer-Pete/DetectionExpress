import { afterEach, describe, expect, it } from "bun:test";
import { Clock, ManualDriver } from "./clock";
import { bindVisibility } from "./visibility";

/** Force `document.hidden` for one test. */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
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
    driver.advance(10);
    expect(clock.now()).toBe(0); // paused: no advance
    detach();
    clock.stop();
  });

  it("runs when the tab starts visible", () => {
    setHidden(false);
    const driver = new ManualDriver();
    const clock = new Clock(60, driver);
    const detach = bindVisibility(clock);
    driver.advance(10);
    expect(clock.now()).toBe(10);
    detach();
    clock.stop();
  });
});
