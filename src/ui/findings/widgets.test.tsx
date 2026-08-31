import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Context } from "../../sim/finding";
import { WidgetList } from "./widgets";

describe("WidgetList", () => {
  it("renders a text widget's title and text as plain text nodes, with no HTML injection", () => {
    const context: Context = [{ type: "text", title: "Status", text: "<b>5</b> of 5 wrong PINs" }];
    const { container } = render(<WidgetList context={context} />);
    expect(screen.getByText("Status")).toBeDefined();
    // The literal markup renders as text, not as an element: no <b> is ever created.
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("<b>5</b> of 5 wrong PINs")).toBeDefined();
  });

  it("renders a kv widget as a definition list, values included, no HTML injection", () => {
    const context: Context = [
      {
        type: "kv",
        title: "Burst",
        entries: [
          { label: "wrong PINs", value: 5 },
          { label: "<img src=x>", value: "<script>alert(1)</script>" },
        ],
      },
    ];
    const { container } = render(<WidgetList context={context} />);
    expect(container.querySelector("dl")).not.toBeNull();
    expect(screen.getByText("wrong PINs")).toBeDefined();
    expect(screen.getByText("5")).toBeDefined();
    expect(screen.getByText("<img src=x>")).toBeDefined();
    expect(screen.getByText("<script>alert(1)</script>")).toBeDefined();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("renders a table widget as a real <table> with its columns and rows", () => {
    const context: Context = [
      {
        type: "table",
        title: "Recent fails",
        columns: ["id", "ts"],
        rows: [
          [1, 10],
          [2, 20],
        ],
      },
    ];
    const { container } = render(<WidgetList context={context} />);
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(screen.getByText("id")).toBeDefined();
    expect(screen.getByText("ts")).toBeDefined();
    const cells = [...(table?.querySelectorAll("tbody td") ?? [])].map((cell) => cell.textContent);
    expect(cells).toEqual(["1", "10", "2", "20"]);
  });

  it("renders a json widget as a <pre> of the pretty-printed value", () => {
    const context: Context = [{ type: "json", value: { a: 1, b: ["x", "y"] } }];
    const { container } = render(<WidgetList context={context} />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe(JSON.stringify({ a: 1, b: ["x", "y"] }, null, 2));
  });

  it("renders nothing when context is absent", () => {
    const { container } = render(<WidgetList />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when context is an empty array", () => {
    const { container } = render(<WidgetList context={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
