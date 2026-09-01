import { afterEach, describe, expect, it, vi } from "vitest";
import { focusableControls, installOutsidePointerDismiss, trapTab } from "./focus";

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

  it("excludes a native control with a negative tabIndex, e.g. a roving-tabindex inactive tab", () => {
    document.body.innerHTML = `
      <div id="dialog">
        <button id="inactive-tab" tabindex="-1">Inactive</button>
        <button id="active-tab" tabindex="0">Active</button>
        <button id="close">Close</button>
      </div>
    `;
    const dialog = document.getElementById("dialog");
    if (dialog === null) {
      throw new Error("expected the dialog fixture");
    }
    const ids = focusableControls(dialog).map((el) => el.id);
    expect(ids).toEqual(["active-tab", "close"]);
  });
});

describe("trapTab", () => {
  it("wraps Shift+Tab from the active tab, skipping the negative-tabIndex inactive tab before it", () => {
    // The regression guard for the focus-leak bug: before the tabIndex filter, the
    // inactive tab counted as the first control, so Shift+Tab from the active tab was
    // treated as interior and native focus escaped the dialog.
    document.body.innerHTML = `
      <div id="dialog" tabindex="-1">
        <button id="inactive-tab" tabindex="-1">Inactive</button>
        <button id="active-tab" tabindex="0">Active</button>
        <button id="close">Close</button>
      </div>
    `;
    const dialog = document.getElementById("dialog");
    const active = document.getElementById("active-tab");
    if (dialog === null || active === null) {
      throw new Error("expected the dialog fixture");
    }
    active.focus();
    const preventDefault = vi.fn();
    const handled = trapTab(dialog, { key: "Tab", shiftKey: true, preventDefault });
    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement?.id).toBe("close");
  });
});

describe("installOutsidePointerDismiss", () => {
  // The teardown for the listeners the current test installed on `document`.
  let uninstall: (() => void) | null = null;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    document.body.innerHTML = "";
  });

  /**
   * The DOM `ModalHost` renders: the shell and the backdrop scrim are SIBLINGS
   * under `.app`, and the dialog is the scrim's only child. `shellRow` stands in
   * for the findings row that opens the dialog. It lives in the shell, so it is
   * outside the scrim, exactly like the real opening click's target.
   */
  function setup() {
    const app = document.createElement("div");
    const shell = document.createElement("div");
    const shellRow = document.createElement("button");
    const scrim = document.createElement("div");
    const dialog = document.createElement("div");
    const inner = document.createElement("button");
    shell.append(shellRow);
    dialog.append(inner);
    scrim.append(dialog);
    app.append(shell, scrim);
    document.body.append(app);

    const onDismiss = vi.fn();
    uninstall = installOutsidePointerDismiss({ current: dialog }, onDismiss);
    return { shellRow, scrim, dialog, inner, onDismiss };
  }

  const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  // happy-dom does not construct PointerEvent, so a bubbling generic Event of the
  // right type stands in. `isOutside` reads only `event.target`, which dispatch sets.
  const pointer = (type: "pointerdown" | "pointerup", el: Element) =>
    el.dispatchEvent(new Event(type, { bubbles: true }));

  it("does NOT dismiss on a click on shell content outside the scrim (the opening-click race)", () => {
    // This is the regression guard. A real click that opens the dialog keeps
    // bubbling to this document listener, which the open-effect just installed.
    // Its target is the shell row, outside the scrim, so it must never dismiss.
    // The pre-fix "anywhere the dialog does not contain" rule dismissed here.
    const { shellRow, onDismiss } = setup();
    click(shellRow);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("dismisses on a click on the backdrop scrim", () => {
    const { scrim, onDismiss } = setup();
    click(scrim);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does NOT dismiss on a click inside the dialog", () => {
    const { inner, onDismiss } = setup();
    click(inner);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does NOT dismiss when a gesture starts inside the dialog and ends on the scrim", () => {
    // A drag that selects text in the dialog and releases over the scrim. The
    // pointerdown starts inside, so the paired click must not dismiss.
    const { inner, scrim, onDismiss } = setup();
    pointer("pointerdown", inner);
    click(scrim);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does NOT dismiss when a gesture starts on the scrim but ends inside the dialog", () => {
    // The mirror case: a mis-click on the scrim that slides onto the dialog
    // before release. Its pointerup ends inside, so the click must not dismiss.
    const { inner, scrim, onDismiss } = setup();
    pointer("pointerdown", scrim);
    pointer("pointerup", inner);
    click(scrim);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("stops dismissing after cleanup removes the listeners", () => {
    const { scrim, onDismiss } = setup();
    uninstall?.();
    uninstall = null;
    click(scrim);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
