import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { useGameStore } from "../game/store";
import { optimizationSource } from "../sim/scenarios/kiosk-pin-attack/optimization";
import { referenceSource } from "../sim/scenarios/kiosk-pin-attack/reference";
import { AlgorithmEditor } from "./AlgorithmEditor";

const SLUG = "kiosk-pin-attack";

beforeEach(() => {
  useGameStore.setState({ sourceLocked: false });
  useGameStore.getState().setAlgorithmSource(referenceSource);
});

describe("AlgorithmEditor", () => {
  it("starts on the naive default source", () => {
    expect(useGameStore.getState().source).toBe(referenceSource);
  });

  it("is editable with a Run button when the source is not locked", () => {
    render(<AlgorithmEditor onRun={() => {}} slug={SLUG} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea.hasAttribute("readonly")).toBe(false);
    expect(screen.getByRole("button", { name: "Run" })).toBeDefined();
  });

  it("swaps the source to the Optimization when Apply Optimization is clicked", () => {
    render(<AlgorithmEditor onRun={() => undefined} slug={SLUG} />);
    fireEvent.click(screen.getByRole("button", { name: /apply optimization/i }));
    expect(useGameStore.getState().source).toBe(optimizationSource);
  });

  it("runs the current source when Run is clicked", () => {
    let ran = 0;
    render(<AlgorithmEditor onRun={() => (ran += 1)} slug={SLUG} />);
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
    expect(ran).toBe(1);
  });

  it("is read-only and hides the Run button while the source is locked", () => {
    useGameStore.setState({ sourceLocked: true });
    render(<AlgorithmEditor onRun={() => {}} slug={SLUG} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea.hasAttribute("readonly")).toBe(true);
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
  });

  it("shows the pushed source in the locked textarea", () => {
    useGameStore.setState({ sourceLocked: true, source: "// pushed from my IDE" });
    render(<AlgorithmEditor onRun={() => {}} slug={SLUG} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveProperty("value", "// pushed from my IDE");
  });

  it("keeps the Download button available even while the source is locked", () => {
    useGameStore.setState({ sourceLocked: true });
    render(<AlgorithmEditor onRun={() => {}} slug={SLUG} />);
    expect(screen.getByRole("button", { name: "Download this Scenario" })).toBeDefined();
  });

  it("downloads the Scenario as detection-express-<slug>.js", () => {
    useGameStore.setState({ source: "// my algorithm" });
    render(<AlgorithmEditor onRun={() => {}} slug={SLUG} />);

    // Capture the temporary anchor the download builds, and stub the object-URL
    // lifecycle so happy-dom does not need a real Blob URL implementation.
    const anchors: HTMLElement[] = [];
    const realCreateElement = document.createElement.bind(document);
    const createSpy = spyOn(document, "createElement");
    createSpy.mockImplementation((tagName: string) => {
      const element = realCreateElement(tagName);
      if (tagName === "a") {
        anchors.push(element);
      }
      return element;
    });
    const createUrlSpy = spyOn(URL, "createObjectURL");
    createUrlSpy.mockImplementation(() => "blob:test");
    const revokeUrlSpy = spyOn(URL, "revokeObjectURL");
    revokeUrlSpy.mockImplementation(() => {});

    fireEvent.click(screen.getByRole("button", { name: "Download this Scenario" }));

    createSpy.mockRestore();
    createUrlSpy.mockRestore();
    revokeUrlSpy.mockRestore();

    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute("download")).toBe("detection-express-kiosk-pin-attack.js");
  });
});
