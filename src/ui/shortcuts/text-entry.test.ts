import { describe, expect, it } from "vitest";
import { isEditableTarget, isTextEntry } from "./text-entry";

function elementOfType(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    el.setAttribute(name, value);
  }
  return el;
}

describe("isEditableTarget (LogPanel-compatible: every INPUT counts, including a radio)", () => {
  it("treats a text input as editable", () => {
    expect(isEditableTarget(elementOfType("input", { type: "text" }))).toBe(true);
  });

  it("treats a radio input as editable, matching the old LogPanel behavior", () => {
    expect(isEditableTarget(elementOfType("input", { type: "radio" }))).toBe(true);
  });

  it("treats a textarea as editable", () => {
    expect(isEditableTarget(elementOfType("textarea"))).toBe(true);
  });

  it("treats a contenteditable element as editable", () => {
    const el = elementOfType("div");
    el.contentEditable = "true";
    document.body.append(el);
    expect(isEditableTarget(el)).toBe(true);
    el.remove();
  });

  it("does not treat a plain button as editable", () => {
    expect(isEditableTarget(elementOfType("button"))).toBe(false);
  });

  it("does not treat a null target as editable", () => {
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("isTextEntry (the mnemonic dispatcher's narrower predicate)", () => {
  it("treats a text input as text entry", () => {
    expect(isTextEntry(elementOfType("input", { type: "text" }))).toBe(true);
  });

  it("treats an input with no explicit type as text entry (the HTML default type is text)", () => {
    expect(isTextEntry(elementOfType("input"))).toBe(true);
  });

  it("does NOT treat a radio input as text entry, unlike isEditableTarget", () => {
    expect(isTextEntry(elementOfType("input", { type: "radio" }))).toBe(false);
  });

  it("does not treat a checkbox input as text entry", () => {
    expect(isTextEntry(elementOfType("input", { type: "checkbox" }))).toBe(false);
  });

  it("treats a textarea as text entry", () => {
    expect(isTextEntry(elementOfType("textarea"))).toBe(true);
  });

  it("treats a contenteditable element as text entry", () => {
    const el = elementOfType("div");
    el.contentEditable = "true";
    document.body.append(el);
    expect(isTextEntry(el)).toBe(true);
    el.remove();
  });

  it("does not treat a plain button as text entry", () => {
    expect(isTextEntry(elementOfType("button"))).toBe(false);
  });

  it("does not treat a null target as text entry", () => {
    expect(isTextEntry(null)).toBe(false);
  });
});
