import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModalHost } from "./ModalHost";

describe("ModalHost", () => {
  it("makes the shell inert while modalOpen is true, and keeps the overlay outside it", () => {
    render(
      <ModalHost modalOpen overlays={<div data-testid="overlay">overlay</div>}>
        <button type="button" data-testid="shell-child">
          shell content
        </button>
      </ModalHost>,
    );
    const shell = document.querySelector(".app-shell");
    if (shell === null) {
      throw new Error("expected an .app-shell element");
    }
    expect(shell.hasAttribute("inert")).toBe(true);

    const shellChild = document.querySelector('[data-testid="shell-child"]');
    if (shellChild === null) {
      throw new Error("expected the shell child to render");
    }
    expect(shellChild.closest("[inert]")).not.toBeNull();

    const overlay = document.querySelector('[data-testid="overlay"]');
    if (overlay === null) {
      throw new Error("expected the overlay to render");
    }
    expect(overlay.closest(".app-shell")).toBeNull();
    expect(overlay.closest("[inert]")).toBeNull();
  });

  it("leaves the shell interactive when modalOpen is false", () => {
    render(
      <ModalHost modalOpen={false} overlays={null}>
        <button type="button">shell content</button>
      </ModalHost>,
    );
    const shell = document.querySelector(".app-shell");
    if (shell === null) {
      throw new Error("expected an .app-shell element");
    }
    expect(shell.hasAttribute("inert")).toBe(false);
  });

  it("appends an extra shell class alongside app-shell when shellExtraClass is given", () => {
    render(
      <ModalHost modalOpen={false} shellExtraClass="shake" overlays={null}>
        <span>content</span>
      </ModalHost>,
    );
    const shell = document.querySelector(".app-shell");
    if (shell === null) {
      throw new Error("expected an .app-shell element");
    }
    expect(shell.className).toBe("app-shell shake");
  });

  it("uses app-shell alone when shellExtraClass is omitted", () => {
    render(
      <ModalHost modalOpen={false} overlays={null}>
        <span>content</span>
      </ModalHost>,
    );
    const shell = document.querySelector(".app-shell");
    if (shell === null) {
      throw new Error("expected an .app-shell element");
    }
    expect(shell.className).toBe("app-shell");
  });
});
