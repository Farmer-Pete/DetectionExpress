import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { introCopy, REPO_URL } from "./content/narrative";
import { IntroOverlay } from "./IntroOverlay";

function renderOverlay(overrides: Partial<Parameters<typeof IntroOverlay>[0]> = {}) {
  const onObserve = vi.fn();
  const onCauseChaos = vi.fn();
  const onEditEngine = vi.fn();
  render(
    <IntroOverlay
      copy={introCopy}
      repoUrl={REPO_URL}
      onObserve={onObserve}
      onCauseChaos={onCauseChaos}
      onEditEngine={onEditEngine}
      {...overrides}
    />,
  );
  return { onObserve, onCauseChaos, onEditEngine };
}

describe("IntroOverlay", () => {
  it("renders the premise, both actions, and both links", () => {
    renderOverlay();
    expect(screen.getByText(introCopy.paragraphs[0] ?? "")).toBeDefined();
    expect(screen.getByRole("button", { name: introCopy.observeLabel })).toBeDefined();
    expect(screen.getByRole("button", { name: introCopy.chaosLabel })).toBeDefined();
    expect(screen.getByRole("link", { name: introCopy.sourceLabel })).toBeDefined();
    expect(screen.getByRole("button", { name: introCopy.editLabel })).toBeDefined();
  });

  it("fires the observe and cause-chaos callbacks", () => {
    const { onObserve, onCauseChaos } = renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: introCopy.observeLabel }));
    expect(onObserve).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: introCopy.chaosLabel }));
    expect(onCauseChaos).toHaveBeenCalledTimes(1);
  });

  it("fires the edit-engine callback", () => {
    const { onEditEngine } = renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: introCopy.editLabel }));
    expect(onEditEngine).toHaveBeenCalledTimes(1);
  });

  it("points the source link at the repo in a safe new tab", () => {
    renderOverlay();
    const link = screen.getByRole("link", { name: introCopy.sourceLabel });
    expect(link.getAttribute("href")).toBe(REPO_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    const rel = link.getAttribute("rel") ?? "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });

  it("is a modal dialog named by its title", () => {
    renderOverlay();
    const dialog = screen.getByRole("dialog", { name: introCopy.title });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("dismisses on Escape", () => {
    const { onObserve } = renderOverlay();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onObserve).toHaveBeenCalledTimes(1);
  });

  it("dismisses on a backdrop click but not on a click inside the dialog", () => {
    const { onObserve } = renderOverlay();
    const dialog = screen.getByRole("dialog");
    // A click inside the dialog carries a different target, so it never dismisses.
    fireEvent.click(dialog);
    expect(onObserve).not.toHaveBeenCalled();
    // A click on the backdrop scrim itself dismisses.
    const backdrop = dialog.parentElement;
    if (backdrop === null) {
      throw new Error("the dialog has no backdrop");
    }
    fireEvent.click(backdrop);
    expect(onObserve).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss when a gesture starts inside the dialog and ends on the backdrop", () => {
    const { onObserve } = renderOverlay();
    const dialog = screen.getByRole("dialog");
    const paragraph = screen.getByText(introCopy.paragraphs[0] ?? "");
    // A drag that starts inside the dialog (e.g. selecting the premise text) and
    // releases over the backdrop must not dismiss, even though the click lands outside.
    fireEvent.pointerDown(paragraph);
    const backdrop = dialog.parentElement;
    if (backdrop === null) {
      throw new Error("the dialog has no backdrop");
    }
    fireEvent.click(backdrop);
    expect(onObserve).not.toHaveBeenCalled();
  });

  it("moves focus into the dialog on open", () => {
    renderOverlay();
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("traps focus at the edges", () => {
    renderOverlay();
    const dialog = screen.getByRole("dialog");
    const focusable = [...dialog.querySelectorAll<HTMLElement>("button, a[href]")];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      throw new Error("the dialog has no focusable controls");
    }

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
