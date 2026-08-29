import { describe, expect, it } from "vitest";
import { parseFindings } from "./parse-findings";
import { RuleError } from "./rule-error";

/**
 * The boundary parser for the player's `detect()` return. It enforces ADR 0006's
 * normative rules and replaces the old `matchResult`. Every violation throws a
 * `RuleError` with phase `"detect"`; "no finding" is the empty array, never null.
 * The seam is exhaustive by design: every normative rule gets a failing case.
 */

/** Assert a value is rejected with a detect-phase RuleError. */
function expectDetectReject(value: unknown): void {
  expect(() => parseFindings(value)).toThrow(RuleError);
  try {
    parseFindings(value);
  } catch (error) {
    expect(error).toBeInstanceOf(RuleError);
    expect(error instanceof RuleError && error.phase).toBe("detect");
  }
}

describe("parseFindings: accepts", () => {
  it("a minimal OneShot final", () => {
    const findings = parseFindings([{ alert: { eventIds: [1], reason: "r", at: 1 } }]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.alert.reason).toBe("r");
  });

  it("the empty array as no finding", () => {
    expect(parseFindings([])).toEqual([]);
  });

  it("an Anchored partial with eventId, subjectType, and isPartial true", () => {
    const findings = parseFindings([
      {
        alert: { eventIds: [5, 6], reason: "brute", at: 3 },
        eventId: 5,
        subjectType: "acct",
        isPartial: true,
      },
    ]);
    expect(findings).toHaveLength(1);
  });

  it("a OneShot with isPartial false and no eventId", () => {
    expect(() =>
      parseFindings([{ alert: { eventIds: [1], reason: "r", at: 1 }, isPartial: false }]),
    ).not.toThrow();
  });

  it("a zero eventId, since zero is a valid non-negative id", () => {
    expect(() =>
      parseFindings([{ alert: { eventIds: [0], reason: "r", at: 1 }, eventId: 0 }]),
    ).not.toThrow();
  });

  it("every widget kind, including a nested json value", () => {
    const findings = parseFindings([
      {
        alert: { eventIds: [1], reason: "r", at: 1 },
        context: [
          { type: "text", title: "T", text: "hello" },
          {
            type: "kv",
            entries: [
              { label: "a", value: "x" },
              { label: "b", value: 2 },
            ],
          },
          {
            type: "table",
            columns: ["ts", "endpoint"],
            rows: [
              [10, "k-3"],
              [12, "k-3"],
            ],
          },
          { type: "json", value: { window: [10, 12], nested: { ok: true, tags: ["a"] } } },
        ],
      },
    ]);
    expect(findings[0]?.context).toHaveLength(4);
  });

  it("a json value with a shared but non-cyclic reference", () => {
    const shared = { k: 1 };
    expect(() =>
      parseFindings([
        {
          alert: { eventIds: [1], reason: "r", at: 1 },
          context: [{ type: "json", value: { a: shared, b: shared } }],
        },
      ]),
    ).not.toThrow();
  });
});

describe("parseFindings: rejects the return shape", () => {
  it("a non-array return", () => {
    expectDetectReject(null);
    expectDetectReject(undefined);
    expectDetectReject({ alert: { eventIds: [1], reason: "r", at: 1 } });
    expectDetectReject("nope");
  });

  it("a bare Alert not wrapped in a Finding array", () => {
    expectDetectReject({ eventIds: [1], reason: "r", at: 1 });
  });

  it("a missing alert, and a non-object alert", () => {
    expectDetectReject([{}]);
    expectDetectReject([{ alert: 5 }]);
    expectDetectReject([{ alert: null }]);
  });
});

describe("parseFindings: rejects a bad alert core", () => {
  it("a missing or empty eventIds", () => {
    expectDetectReject([{ alert: { reason: "r", at: 1 } }]);
    expectDetectReject([{ alert: { eventIds: [], reason: "r", at: 1 } }]);
  });

  it("a non-array, non-integer, negative, or non-finite eventId", () => {
    expectDetectReject([{ alert: { eventIds: 1, reason: "r", at: 1 } }]);
    expectDetectReject([{ alert: { eventIds: [1.5], reason: "r", at: 1 } }]);
    expectDetectReject([{ alert: { eventIds: [-1], reason: "r", at: 1 } }]);
    expectDetectReject([{ alert: { eventIds: [Number.POSITIVE_INFINITY], reason: "r", at: 1 } }]);
    expectDetectReject([{ alert: { eventIds: [Number.NaN], reason: "r", at: 1 } }]);
  });

  it("an empty or non-string reason", () => {
    expectDetectReject([{ alert: { eventIds: [1], reason: "", at: 1 } }]);
    expectDetectReject([{ alert: { eventIds: [1], reason: 5, at: 1 } }]);
  });

  it("a non-finite at", () => {
    expectDetectReject([{ alert: { eventIds: [1], reason: "r", at: Number.NaN } }]);
    expectDetectReject([{ alert: { eventIds: [1], reason: "r", at: Number.POSITIVE_INFINITY } }]);
    expectDetectReject([{ alert: { eventIds: [1], reason: "r", at: "1" } }]);
  });

  it("an unknown field on the alert", () => {
    expectDetectReject([{ alert: { eventIds: [1], reason: "r", at: 1, extra: 1 } }]);
  });
});

describe("parseFindings: rejects a bad anchor and grouping", () => {
  it("an eventId not a member of alert.eventIds", () => {
    expectDetectReject([{ alert: { eventIds: [1, 2], reason: "r", at: 1 }, eventId: 3 }]);
  });

  it("a non-finite, negative, or fractional eventId", () => {
    expectDetectReject([
      { alert: { eventIds: [1], reason: "r", at: 1 }, eventId: Number.POSITIVE_INFINITY },
    ]);
    expectDetectReject([{ alert: { eventIds: [1], reason: "r", at: 1 }, eventId: -1 }]);
    expectDetectReject([{ alert: { eventIds: [1], reason: "r", at: 1 }, eventId: 1.5 }]);
  });

  it("a subjectType with no eventId", () => {
    expectDetectReject([{ alert: { eventIds: [1], reason: "r", at: 1 }, subjectType: "acct" }]);
  });

  it("a non-string or empty subjectType", () => {
    expectDetectReject([
      { alert: { eventIds: [1], reason: "r", at: 1 }, eventId: 1, subjectType: 5 },
    ]);
    expectDetectReject([
      { alert: { eventIds: [1], reason: "r", at: 1 }, eventId: 1, subjectType: "" },
    ]);
  });

  it("isPartial true with no eventId, and a non-boolean isPartial", () => {
    expectDetectReject([{ alert: { eventIds: [1], reason: "r", at: 1 }, isPartial: true }]);
    expectDetectReject([
      { alert: { eventIds: [1], reason: "r", at: 1 }, eventId: 1, isPartial: "yes" },
    ]);
  });

  it("an unknown top-level field on a Finding", () => {
    expectDetectReject([{ alert: { eventIds: [1], reason: "r", at: 1 }, mystery: 1 }]);
  });
});

describe("parseFindings: rejects bad context and widgets", () => {
  it("a non-array context", () => {
    expectDetectReject([{ alert: { eventIds: [1], reason: "r", at: 1 }, context: {} }]);
  });

  it("an unknown widget type", () => {
    expectDetectReject([
      { alert: { eventIds: [1], reason: "r", at: 1 }, context: [{ type: "chart", data: [] }] },
    ]);
  });

  it("a non-string widget title", () => {
    expectDetectReject([
      {
        alert: { eventIds: [1], reason: "r", at: 1 },
        context: [{ type: "text", title: 5, text: "x" }],
      },
    ]);
  });

  it("an unknown field on a widget", () => {
    expectDetectReject([
      {
        alert: { eventIds: [1], reason: "r", at: 1 },
        context: [{ type: "text", text: "x", extra: 1 }],
      },
    ]);
  });

  it("a text widget with a non-string text", () => {
    expectDetectReject([
      { alert: { eventIds: [1], reason: "r", at: 1 }, context: [{ type: "text", text: 5 }] },
    ]);
  });

  it("a kv widget with a bad entries value type or a missing label", () => {
    expectDetectReject([
      {
        alert: { eventIds: [1], reason: "r", at: 1 },
        context: [{ type: "kv", entries: [{ label: "a", value: {} }] }],
      },
    ]);
    expectDetectReject([
      {
        alert: { eventIds: [1], reason: "r", at: 1 },
        context: [{ type: "kv", entries: [{ value: 1 }] }],
      },
    ]);
    expectDetectReject([
      {
        alert: { eventIds: [1], reason: "r", at: 1 },
        context: [{ type: "kv", entries: "nope" }],
      },
    ]);
  });

  it("a table widget with non-string columns, a bad cell, or a non-rectangular row", () => {
    expectDetectReject([
      {
        alert: { eventIds: [1], reason: "r", at: 1 },
        context: [{ type: "table", columns: [1, 2], rows: [] }],
      },
    ]);
    expectDetectReject([
      {
        alert: { eventIds: [1], reason: "r", at: 1 },
        context: [{ type: "table", columns: ["a"], rows: [[{}]] }],
      },
    ]);
    expectDetectReject([
      {
        alert: { eventIds: [1], reason: "r", at: 1 },
        context: [{ type: "table", columns: ["a", "b"], rows: [["only-one"]] }],
      },
    ]);
  });
});

describe("parseFindings: rejects a bad json value", () => {
  const withJson = (value: unknown) => [
    {
      alert: { eventIds: [1], reason: "r", at: 1 },
      context: [{ type: "json", value }],
    },
  ];

  it("a function, undefined, BigInt, or Symbol", () => {
    expectDetectReject(withJson(() => 1));
    expectDetectReject(withJson(undefined));
    expectDetectReject(withJson(10n));
    expectDetectReject(withJson(Symbol("s")));
  });

  it("a non-finite number", () => {
    expectDetectReject(withJson(Number.NaN));
    expectDetectReject(withJson(Number.POSITIVE_INFINITY));
    expectDetectReject(withJson({ n: Number.NaN }));
    expectDetectReject(withJson([Number.NaN]));
  });

  it("a Date, a Map, or a class instance", () => {
    expectDetectReject(withJson(new Date()));
    expectDetectReject(withJson(new Map()));
    class Thing {
      x = 1;
    }
    expectDetectReject(withJson(new Thing()));
  });

  it("a cycle, but not a shared non-cyclic reference", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expectDetectReject(withJson(cyclic));
  });
});

describe("parseFindings: hardening against untrusted input", () => {
  const withJson = (value: unknown) => [
    {
      alert: { eventIds: [1], reason: "r", at: 1 },
      context: [{ type: "json", value }],
    },
  ];

  it("rejects a json value nested past the depth cap, not a stack overflow", () => {
    let deep: unknown = 0;
    for (let i = 0; i < 300; i++) {
      deep = [deep];
    }
    expectDetectReject(withJson(deep));
  });

  it("rejects a boxed String reason that would slip past the scorer", () => {
    // Object("r") is a boxed String wrapper: same tag as a primitive, but an object.
    expectDetectReject([{ alert: { eventIds: [1], reason: Object("r"), at: 1 } }]);
  });

  it("rejects a boxed Number as a kv value", () => {
    expectDetectReject([
      {
        alert: { eventIds: [1], reason: "r", at: 1 },
        context: [{ type: "kv", entries: [{ label: "a", value: Object(5) }] }],
      },
    ]);
  });

  it("rejects a non-finite kv value or table cell", () => {
    expectDetectReject([
      {
        alert: { eventIds: [1], reason: "r", at: 1 },
        context: [{ type: "kv", entries: [{ label: "a", value: Number.NaN }] }],
      },
    ]);
    expectDetectReject([
      {
        alert: { eventIds: [1], reason: "r", at: 1 },
        context: [{ type: "table", columns: ["a"], rows: [[Number.POSITIVE_INFINITY]] }],
      },
    ]);
  });
});
