/**
 * GH137-PLAN.md TDD seams #2 (`resolveActiveScope`) and #4 (the dispatcher). The
 * dispatcher is exercised through the public API (`ShortcutsProvider` + `useShortcut`,
 * both real), never through internals, mirroring how a real control would register.
 */
import { fireEvent, render } from "@testing-library/react";
import type { RefObject } from "react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Scope } from "./shortcuts.data";
import { useShortcut } from "./use-shortcut";
import { resolveActiveScope, type ShortcutsAppState, ShortcutsProvider } from "./use-shortcuts";

const SHELL_STATE: ShortcutsAppState = {
  traceOpen: false,
  mapDialogKind: null,
  legendOpen: false,
  sidePanelOpen: false,
  sidePanelTab: "chaos",
  hireMeOpen: false,
};

describe("resolveActiveScope", () => {
  it("returns shell when nothing is open", () => {
    expect(resolveActiveScope(SHELL_STATE)).toBe("shell");
  });

  it("returns trace when the trace dialog is open", () => {
    expect(resolveActiveScope({ ...SHELL_STATE, traceOpen: true })).toBe("trace");
  });

  it.each(["event", "place"] as const)("returns mapDialog:%s for that dialog kind", (kind) => {
    expect(resolveActiveScope({ ...SHELL_STATE, mapDialogKind: kind })).toBe(`mapDialog:${kind}`);
  });

  it.each(["chaos", "algorithm", "options"] as const)(
    "returns sidepanel:%s for that open tab",
    (tab) => {
      expect(resolveActiveScope({ ...SHELL_STATE, sidePanelOpen: true, sidePanelTab: tab })).toBe(
        `sidepanel:${tab}`,
      );
    },
  );

  it("returns hireMe when only the Hire Me card is open", () => {
    expect(resolveActiveScope({ ...SHELL_STATE, hireMeOpen: true })).toBe("hireMe");
  });

  it("prefers trace over a simultaneous map dialog", () => {
    expect(resolveActiveScope({ ...SHELL_STATE, traceOpen: true, mapDialogKind: "event" })).toBe(
      "trace",
    );
  });

  it("prefers a map dialog over a simultaneous side panel", () => {
    expect(
      resolveActiveScope({ ...SHELL_STATE, mapDialogKind: "place", sidePanelOpen: true }),
    ).toBe("mapDialog:place");
  });

  it("prefers the side panel over a simultaneous Hire Me card", () => {
    expect(
      resolveActiveScope({
        ...SHELL_STATE,
        sidePanelOpen: true,
        sidePanelTab: "options",
        hireMeOpen: true,
      }),
    ).toBe("sidepanel:options");
  });

  it("prefers trace over a simultaneous Hire Me card", () => {
    expect(resolveActiveScope({ ...SHELL_STATE, traceOpen: true, hireMeOpen: true })).toBe("trace");
  });

  it("prefers a map dialog over a simultaneous Hire Me card", () => {
    expect(resolveActiveScope({ ...SHELL_STATE, mapDialogKind: "event", hireMeOpen: true })).toBe(
      "mapDialog:event",
    );
  });

  it("returns legend when only the legend dialog is open (GH137-PLAN.md M2)", () => {
    expect(resolveActiveScope({ ...SHELL_STATE, legendOpen: true })).toBe("legend");
  });

  it("prefers trace over a simultaneous legend dialog", () => {
    expect(resolveActiveScope({ ...SHELL_STATE, traceOpen: true, legendOpen: true })).toBe("trace");
  });

  it("prefers a map dialog over a simultaneous legend dialog", () => {
    expect(resolveActiveScope({ ...SHELL_STATE, mapDialogKind: "place", legendOpen: true })).toBe(
      "mapDialog:place",
    );
  });

  it("prefers the legend dialog over a simultaneous side panel", () => {
    expect(resolveActiveScope({ ...SHELL_STATE, legendOpen: true, sidePanelOpen: true })).toBe(
      "legend",
    );
  });

  it("prefers the legend dialog over a simultaneous Hire Me card", () => {
    expect(resolveActiveScope({ ...SHELL_STATE, legendOpen: true, hireMeOpen: true })).toBe(
      "legend",
    );
  });
});

/** A minimal control that registers a real shell/sidepanel-table entry and reports every
 *  activation. Mirrors how `Topbar`/`LogPanel`/`FindingsPanel` will call `useShortcut`. */
function ShortcutProbe({
  scope,
  id,
  onActivate,
  enabled = true,
}: {
  scope: Scope;
  id: string;
  onActivate: () => void;
  enabled?: boolean;
}) {
  useShortcut({ scope, id, onActivate, enabled });
  return null;
}

function renderProvider(
  appState: ShortcutsAppState,
  children: React.ReactNode,
  tourOwnsKeyboardRef?: RefObject<boolean>,
) {
  return render(
    <ShortcutsProvider appState={appState} tourOwnsKeyboardRef={tourOwnsKeyboardRef}>
      {children}
    </ShortcutsProvider>,
  );
}

describe("the dispatcher: a matching keydown", () => {
  it("invokes the active scope's handler and calls preventDefault", () => {
    const onActivate = vi.fn();
    renderProvider(SHELL_STATE, <ShortcutProbe scope="shell" id="menu" onActivate={onActivate} />);

    const event = new KeyboardEvent("keydown", { key: "m", bubbles: true, cancelable: true });
    window.dispatchEvent(event);

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("matches case-insensitively (Shift+M dispatches the same entry as m)", () => {
    const onActivate = vi.fn();
    renderProvider(SHELL_STATE, <ShortcutProbe scope="shell" id="menu" onActivate={onActivate} />);

    fireEvent.keyDown(document.body, { key: "M", shiftKey: true });

    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});

describe("the dispatcher: bail checks", () => {
  it("bails while tourOwnsKeyboard.current is true", () => {
    const onActivate = vi.fn();
    const tourOwnsKeyboardRef: RefObject<boolean> = { current: true };
    renderProvider(
      SHELL_STATE,
      <ShortcutProbe scope="shell" id="menu" onActivate={onActivate} />,
      tourOwnsKeyboardRef,
    );

    fireEvent.keyDown(document.body, { key: "m" });

    expect(onActivate).not.toHaveBeenCalled();
  });

  it.each(["ctrlKey", "metaKey", "altKey"] as const)("bails while %s is held", (modifier) => {
    const onActivate = vi.fn();
    renderProvider(SHELL_STATE, <ShortcutProbe scope="shell" id="menu" onActivate={onActivate} />);

    fireEvent.keyDown(document.body, { key: "m", [modifier]: true });

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("bails on a key repeat", () => {
    const onActivate = vi.fn();
    renderProvider(SHELL_STATE, <ShortcutProbe scope="shell" id="menu" onActivate={onActivate} />);

    fireEvent.keyDown(document.body, { key: "m", repeat: true });

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("bails once a prior handler already called preventDefault", () => {
    const onActivate = vi.fn();
    renderProvider(SHELL_STATE, <ShortcutProbe scope="shell" id="menu" onActivate={onActivate} />);

    const event = new KeyboardEvent("keydown", { key: "m", bubbles: true, cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("bails while a text-entry element is focused", () => {
    const onActivate = vi.fn();
    renderProvider(SHELL_STATE, <ShortcutProbe scope="shell" id="menu" onActivate={onActivate} />);
    const input = document.createElement("input");
    input.type = "text";
    document.body.append(input);

    fireEvent.keyDown(input, { key: "m" });

    expect(onActivate).not.toHaveBeenCalled();
    input.remove();
  });

  it("does NOT bail on a radio input (isTextEntry, not isEditableTarget, gates the dispatcher)", () => {
    const onActivate = vi.fn();
    renderProvider(SHELL_STATE, <ShortcutProbe scope="shell" id="menu" onActivate={onActivate} />);
    const radio = document.createElement("input");
    radio.type = "radio";
    document.body.append(radio);

    fireEvent.keyDown(radio, { key: "m" });

    expect(onActivate).toHaveBeenCalledTimes(1);
    radio.remove();
  });
});

describe("the dispatcher: scope isolation and freshness", () => {
  it("never fires a non-active scope's handler", () => {
    const menuActivate = vi.fn();
    const applyActivate = vi.fn();
    renderProvider(
      SHELL_STATE,
      <>
        <ShortcutProbe scope="shell" id="menu" onActivate={menuActivate} />
        <ShortcutProbe scope="sidepanel:algorithm" id="apply" onActivate={applyActivate} />
      </>,
    );

    fireEvent.keyDown(document.body, { key: "a" });

    expect(applyActivate).not.toHaveBeenCalled();
    expect(menuActivate).not.toHaveBeenCalled(); // "a" is not menu's key either
  });

  it("reads the just-committed active scope immediately after a transition (useLayoutEffect refs, not a stale closure)", () => {
    const menuActivate = vi.fn();
    const applyActivate = vi.fn();
    const { rerender } = render(
      <ShortcutsProvider appState={SHELL_STATE}>
        <ShortcutProbe scope="shell" id="menu" onActivate={menuActivate} />
        <ShortcutProbe scope="sidepanel:algorithm" id="apply" onActivate={applyActivate} />
      </ShortcutsProvider>,
    );
    fireEvent.keyDown(document.body, { key: "m" });
    expect(menuActivate).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "a" });
    expect(applyActivate).not.toHaveBeenCalled();

    rerender(
      <ShortcutsProvider
        appState={{ ...SHELL_STATE, sidePanelOpen: true, sidePanelTab: "algorithm" }}
      >
        <ShortcutProbe scope="shell" id="menu" onActivate={menuActivate} />
        <ShortcutProbe scope="sidepanel:algorithm" id="apply" onActivate={applyActivate} />
      </ShortcutsProvider>,
    );

    fireEvent.keyDown(document.body, { key: "a" });
    expect(applyActivate).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "m" });
    expect(menuActivate).toHaveBeenCalledTimes(1); // still just the one, from before the transition
  });

  it("skips a disabled control's shortcut without firing it", () => {
    const onActivate = vi.fn();
    renderProvider(
      SHELL_STATE,
      <ShortcutProbe scope="shell" id="menu" onActivate={onActivate} enabled={false} />,
    );

    fireEvent.keyDown(document.body, { key: "m" });

    expect(onActivate).not.toHaveBeenCalled();
  });
});

describe("registration: RESERVED and dispatch:false are refused", () => {
  it("never invokes a badge-only (dispatch: false) entry, even though its key is RESERVED (Space)", () => {
    const onActivate = vi.fn();
    renderProvider(
      SHELL_STATE,
      <ShortcutProbe scope="shell" id="freeze" onActivate={onActivate} />,
    );

    fireEvent.keyDown(document.body, { code: "Space", key: " " });

    expect(onActivate).not.toHaveBeenCalled();
  });
});

describe("StrictMode", () => {
  it("a setup/cleanup/setup cycle leaves exactly one live handler (no throw, exactly one invocation)", () => {
    const onActivate = vi.fn();
    expect(() =>
      render(
        <StrictMode>
          <ShortcutsProvider appState={SHELL_STATE}>
            <ShortcutProbe scope="shell" id="menu" onActivate={onActivate} />
          </ShortcutsProvider>
        </StrictMode>,
      ),
    ).not.toThrow();

    fireEvent.keyDown(document.body, { key: "m" });

    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
