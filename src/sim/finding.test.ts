/**
 * Type-level contract test for `./finding`.
 *
 * The compiler enforces these assertions, not the runner. `vitest.config.ts` sets no
 * `typecheck.enabled`, so under `vitest run` the `expectTypeOf` and `@ts-expect-error`
 * lines are runtime no-ops and the file passes either way. The real gate is `tsc --noEmit`
 * (the `typecheck` script, run in CI): a wrong assertion or an unused `@ts-expect-error`
 * fails the compile. That failure is what proves the contract holds.
 */
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
  it("accepts a minimal final that carries its required anchor", () => {
    const minimal: Finding = {
      alert: { eventIds: [1], reason: "pin_brute_force", at: 42 },
      eventId: 1,
    };
    expectTypeOf(minimal).toExtend<Finding>();
  });

  it("accepts a rich final with every widget kind in context", () => {
    const rich: Finding = {
      alert: { eventIds: [1, 2, 3], reason: "pin_brute_force", at: 90 },
      eventId: 1,
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

  it("types Algorithm as detect plus an optional normalize", () => {
    expectTypeOf<Algorithm>().toHaveProperty("detect").toEqualTypeOf<Detect>();
    expectTypeOf<Algorithm>().toHaveProperty("normalize");
    // normalize is optional: the loader defaults an omitted one to identity, so a
    // detect-only module is a valid Algorithm.
    const detectOnly: Algorithm = { detect: () => [] };
    expectTypeOf(detectOnly).toExtend<Algorithm>();
  });

  it("rejects a Finding with no alert", () => {
    // @ts-expect-error a Finding must always carry an alert.
    const noAlert: Finding = { context: [] };
    expectTypeOf(noAlert).toExtend<Finding>();
  });

  it("rejects any Finding that omits the now-required eventId anchor", () => {
    // @ts-expect-error every Finding needs an eventId; the OneShot arm is gone.
    const noAnchor: Finding = {
      alert: { eventIds: [1], reason: "pin_brute_force", at: 1 },
    };
    expectTypeOf(noAnchor).toExtend<Finding>();
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
