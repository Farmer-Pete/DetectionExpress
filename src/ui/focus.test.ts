import { describe, expect, it } from "vitest";
import { focusableControls } from "./focus";

describe("focusableControls", () => {
  it("excludes a disabled control and one nested inside an aria-hidden wrapper, keeping enabled visible ones", () => {
    document.body.innerHTML = `
      <div id="dialog">
        <button id="enabled">Enabled</button>
        <button id="disabled" disabled>Disabled</button>
        <div aria-hidden="true"><button id="hidden-wrapper">Hidden wrapper</button></div>
      </div>
    `;
    const dialog = document.getElementById("dialog");
    if (dialog === null) {
      throw new Error("expected the dialog fixture");
    }
    const ids = focusableControls(dialog).map((el) => el.id);
    expect(ids).toEqual(["enabled"]);
  });
});
