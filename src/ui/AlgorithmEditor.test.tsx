import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { referenceSource } from "../game/engine-source";
import { useGameStore } from "../game/store";
import { AlgorithmEditor } from "./AlgorithmEditor";

beforeEach(() => {
  useGameStore.setState({ sourceLocked: false, runPending: false });
  useGameStore.getState().setAlgorithmSource(referenceSource);
});

describe("AlgorithmEditor", () => {
  it("starts on the naive default source", () => {
    expect(useGameStore.getState().source).toBe(referenceSource);
  });

  it("is editable with an Apply button when the source is not locked", () => {
    render(<AlgorithmEditor onRun={() => {}} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea.hasAttribute("readonly")).toBe(false);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDefined();
  });

  it("resets the source to the reference default when Reset to default is clicked", () => {
    useGameStore.getState().setAlgorithmSource("// a broken edit");
    render(<AlgorithmEditor onRun={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /reset to default/i }));
    expect(useGameStore.getState().source).toBe(referenceSource);
  });

  it("runs the current source when Apply is clicked", () => {
    let ran = 0;
    render(<AlgorithmEditor onRun={() => (ran += 1)} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(ran).toBe(1);
  });

  it("disables Apply and reads Checking... while a run is pending", () => {
    useGameStore.setState({ runPending: true });
    render(<AlgorithmEditor onRun={() => {}} />);
    const apply = screen.getByRole("button", { name: "Checking..." });
    expect(apply).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("enables Apply and reads Apply when no run is pending", () => {
    render(<AlgorithmEditor onRun={() => {}} />);
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toHaveProperty("disabled", false);
  });

  it("is read-only and hides the Apply and Reset buttons while the source is locked", () => {
    useGameStore.setState({ sourceLocked: true });
    render(<AlgorithmEditor onRun={() => {}} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea.hasAttribute("readonly")).toBe(true);
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.queryByRole("button", { name: /reset to default/i })).toBeNull();
  });

  it("shows the pushed source in the locked textarea", () => {
    useGameStore.setState({ sourceLocked: true, source: "// pushed from my IDE" });
    render(<AlgorithmEditor onRun={() => {}} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveProperty("value", "// pushed from my IDE");
  });

  it("keeps the Download button available even while the source is locked", () => {
    useGameStore.setState({ sourceLocked: true });
    render(<AlgorithmEditor onRun={() => {}} />);
    expect(screen.getByRole("button", { name: "Download engine.ts" })).toBeDefined();
  });

  it("shows the error line bound to the store error", () => {
    useGameStore.setState({ error: { phase: "load", message: "bad syntax" } });
    render(<AlgorithmEditor onRun={() => {}} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("load");
    expect(alert.textContent).toContain("bad syntax");
    useGameStore.setState({ error: null });
  });

  it("downloads the Scenario as engine.ts", () => {
    useGameStore.setState({ source: "// my algorithm" });
    render(<AlgorithmEditor onRun={() => {}} />);

    // Capture the temporary anchor the download builds, and stub the object-URL
    // lifecycle so happy-dom does not need a real Blob URL implementation.
    const anchors: HTMLElement[] = [];
    const realCreateElement = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, "createElement");
    createSpy.mockImplementation((tagName: string) => {
      const element = realCreateElement(tagName);
      if (tagName === "a") {
        anchors.push(element);
      }
      return element;
    });
    const createUrlSpy = vi.spyOn(URL, "createObjectURL");
    createUrlSpy.mockImplementation(() => "blob:test");
    const revokeUrlSpy = vi.spyOn(URL, "revokeObjectURL");
    revokeUrlSpy.mockImplementation(() => {});

    fireEvent.click(screen.getByRole("button", { name: "Download engine.ts" }));

    createSpy.mockRestore();
    createUrlSpy.mockRestore();
    revokeUrlSpy.mockRestore();

    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute("download")).toBe("engine.ts");
  });
});
