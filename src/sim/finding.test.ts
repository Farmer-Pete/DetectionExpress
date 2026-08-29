import { describe, expectTypeOf, it } from "vitest";
import type {
  Alert,
  AlertReason,
  Algorithm,
  Context,
  Detect,
  DetectView,
  Finding,
  JsonValue,
  Widget,
} from "./finding";

describe("Finding type contract", () => {
  it("accepts a minimal OneShot final that carries only an alert", () => {
    const minimal: Finding = {
      alert: { eventIds: [1], reason: "pin_brute_force", at: 42 },
    };
    expectTypeOf(minimal).toExtend<Finding>();
  });

  it("accepts a rich final with every widget kind in context", () => {
    const rich: Finding = {
      alert: { eventIds: [1, 2, 3], reason: "pin_brute_force", at: 90 },
      context: [
        { type: "text", title: "Summary", text: "Five wrong PINs in a row." },
        {
          type: "kv",
          entries: [
            { label: "account", value: "acct-7" },
            { label: "fails", value: 5 },
          ],
        },
        {
          type: "table",
          columns: ["ts", "endpoint"],
          rows: [
            [10, "turnstile-3"],
            [12, "turnstile-3"],
          ],
        },
        { type: "json", value: { window: [10, 12], nested: { ok: true, tags: ["a"] } } },
      ],
    };
    expectTypeOf(rich).toExtend<Finding>();
  });

  it("accepts an Anchored partial that carries an eventId anchor", () => {
    const watch: Finding = {
      alert: { eventIds: [5], reason: "pin_brute_force", at: 3 },
      eventId: 5,
      subjectType: "acct",
      isPartial: true,
    };
    expectTypeOf(watch).toExtend<Finding>();
  });

  it("scores its core off Alert: eventIds, reason, at", () => {
    const alert: Alert = { eventIds: [1], reason: "pin_brute_force", at: 1 };
    expectTypeOf(alert).toExtend<Alert>();
    expectTypeOf<Alert["reason"]>().toEqualTypeOf<AlertReason>();
    expectTypeOf<Alert["eventIds"]>().toEqualTypeOf<number[]>();
    expectTypeOf<Alert["at"]>().toEqualTypeOf<number>();
  });

  it("carries a JsonValue in the json widget", () => {
    const payload: JsonValue = { a: [1, "two", true, null, { b: 2 }] };
    const widget: Widget = { type: "json", value: payload };
    const context: Context = [widget];
    expectTypeOf(context).toEqualTypeOf<Widget[]>();
  });

  it("types Detect as a synchronous (DetectView) => Finding[]", () => {
    expectTypeOf<Detect>().toEqualTypeOf<(event: DetectView) => Finding[]>();
    expectTypeOf<Detect>().parameter(0).toEqualTypeOf<DetectView>();
    expectTypeOf<Detect>().returns.toEqualTypeOf<Finding[]>();
    expectTypeOf<Detect>().returns.not.toEqualTypeOf<Promise<Finding[]>>();
  });

  it("types Algorithm as normalize plus detect", () => {
    expectTypeOf<Algorithm>().toHaveProperty("detect").toEqualTypeOf<Detect>();
    expectTypeOf<Algorithm>().toHaveProperty("normalize");
  });

  it("rejects a Finding with no alert", () => {
    // @ts-expect-error a Finding must always carry an alert.
    const noAlert: Finding = { context: [] };
    expectTypeOf(noAlert).toExtend<Finding>();
  });

  it("rejects a partial with no eventId anchor", () => {
    // @ts-expect-error a partial needs an eventId anchor to promote against.
    const partialNoAnchor: Finding = {
      alert: { eventIds: [1], reason: "pin_brute_force", at: 1 },
      isPartial: true,
    };
    expectTypeOf(partialNoAnchor).toExtend<Finding>();
  });

  it("rejects a subjectType with no eventId anchor", () => {
    // @ts-expect-error subjectType needs an eventId anchor to resolve against.
    const subjectNoAnchor: Finding = {
      alert: { eventIds: [1], reason: "pin_brute_force", at: 1 },
      subjectType: "acct",
    };
    expectTypeOf(subjectNoAnchor).toExtend<Finding>();
  });

  it("rejects a widget with an unknown type", () => {
    const context: Context = [
      // @ts-expect-error "chart" is not a known widget type.
      { type: "chart", series: [1, 2, 3] },
    ];
    expectTypeOf(context).toEqualTypeOf<Widget[]>();
  });

  it("rejects a json widget whose value holds a function", () => {
    const context: Context = [
      // @ts-expect-error a function is not a JSON-serializable value.
      { type: "json", value: () => 1 },
    ];
    expectTypeOf(context).toEqualTypeOf<Widget[]>();
  });
});
