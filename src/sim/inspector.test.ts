import { describe, expect, it } from "vitest";
import { createInspector } from "./inspector";

/** An object that cites itself, so `JSON.stringify` throws on it. */
function makeCircular(): { self?: unknown } {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  return circular;
}

describe("createInspector ring", () => {
  it("pairs raw with normalized and keeps events id-ordered", () => {
    const inspector = createInspector({ ringSize: 10 });
    inspector.captureNormalized(0, 0, "kiosk-v1", { u: "bob" }, { user: "bob" });
    inspector.captureNormalized(1, 2, "kiosk-v1", { u: "amy" }, { user: "amy" });
    const { events } = inspector.snapshot();
    expect(events).toEqual([
      { id: 0, ts: 0, endpoint: "kiosk-v1", raw: { u: "bob" }, normalized: { user: "bob" } },
      { id: 1, ts: 2, endpoint: "kiosk-v1", raw: { u: "amy" }, normalized: { user: "amy" } },
    ]);
  });

  it("evicts the oldest event once past ringSize, keeping id order", () => {
    const inspector = createInspector({ ringSize: 3 });
    for (let id = 0; id < 5; id++) {
      inspector.captureNormalized(id, id, "kiosk-v1", { id }, { id });
    }
    const { events } = inspector.snapshot();
    expect(events.map((e) => e.id)).toEqual([2, 3, 4]);
  });

  it("stores a null placeholder for a non-serializable raw, but keeps the entry", () => {
    const inspector = createInspector({ ringSize: 10 });
    const circular = makeCircular();
    inspector.captureNormalized(0, 0, "kiosk-v1", circular, { user: "bob" });
    const { events } = inspector.snapshot();
    expect(events).toHaveLength(1); // the entry is kept, not dropped: id continuity holds
    expect(events[0]?.raw).toBeNull();
    expect(events[0]?.normalized).toEqual({ user: "bob" });
  });

  it("stores a null placeholder for a non-serializable normalized form independently", () => {
    const inspector = createInspector({ ringSize: 10 });
    const circular = makeCircular();
    inspector.captureNormalized(0, 0, "kiosk-v1", { u: "bob" }, circular);
    const { events } = inspector.snapshot();
    expect(events[0]?.raw).toEqual({ u: "bob" });
    expect(events[0]?.normalized).toBeNull();
  });

  it("never throws on a non-serializable form", () => {
    const inspector = createInspector({ ringSize: 10 });
    const circular = makeCircular();
    expect(() => inspector.captureNormalized(0, 0, "kiosk-v1", circular, circular)).not.toThrow();
  });
});

describe("createInspector watermark", () => {
  it("markProcessed increments the count and never goes backward", () => {
    const inspector = createInspector({ ringSize: 10 });
    expect(inspector.snapshot().processed).toBe(0);
    inspector.markProcessed();
    expect(inspector.snapshot().processed).toBe(1);
    inspector.markProcessed();
    inspector.markProcessed();
    expect(inspector.snapshot().processed).toBe(3);
  });
});

describe("createInspector resolveEvents", () => {
  it("resolves present ids in id order, regardless of the ids array's own order", () => {
    const inspector = createInspector({ ringSize: 10 });
    for (let id = 0; id < 5; id++) {
      inspector.captureNormalized(id, id, "kiosk-v1", { id }, { id });
    }
    const resolved = inspector.resolveEvents([3, 1, 4]);
    expect(resolved.map((e) => e.id)).toEqual([1, 3, 4]);
  });

  it("omits ids evicted from the ring, keeping the rest", () => {
    const inspector = createInspector({ ringSize: 3 });
    for (let id = 0; id < 5; id++) {
      inspector.captureNormalized(id, id, "kiosk-v1", { id }, { id });
    }
    // ids 0 and 1 evicted past ringSize 3; only 2, 3, 4 remain.
    const resolved = inspector.resolveEvents([0, 1, 2, 3, 4]);
    expect(resolved.map((e) => e.id)).toEqual([2, 3, 4]);
  });

  it("returns an empty array when every cited id is missing or evicted", () => {
    const inspector = createInspector({ ringSize: 10 });
    inspector.captureNormalized(0, 0, "kiosk-v1", {}, {});
    expect(inspector.resolveEvents([99])).toEqual([]);
  });

  it("returns an empty array for an empty ids list", () => {
    const inspector = createInspector({ ringSize: 10 });
    inspector.captureNormalized(0, 0, "kiosk-v1", {}, {});
    expect(inspector.resolveEvents([])).toEqual([]);
  });

  it("returns entries already frozen, the same ring records the snapshot shares", () => {
    const inspector = createInspector({ ringSize: 10 });
    inspector.captureNormalized(0, 0, "kiosk-v1", { u: "bob" }, { user: "bob" });
    const resolved = inspector.resolveEvents([0]);
    expect(resolved[0] !== undefined && Object.isFrozen(resolved[0])).toBe(true);
  });
});

describe("createInspector snapshot", () => {
  it("returns a fresh frozen events array on every call", () => {
    const inspector = createInspector({ ringSize: 10 });
    inspector.captureNormalized(0, 0, "kiosk-v1", {}, {});
    const first = inspector.snapshot();
    expect(Object.isFrozen(first.events)).toBe(true);
    const second = inspector.snapshot();
    expect(second.events).not.toBe(first.events); // a new array each call
    expect(second.events).toEqual(first.events); // with the same contents
  });

  it("does not let a caller mutate future snapshots through the returned array", () => {
    const inspector = createInspector({ ringSize: 10 });
    inspector.captureNormalized(0, 0, "kiosk-v1", {}, {});
    const first = inspector.snapshot();
    inspector.captureNormalized(1, 2, "kiosk-v1", {}, {});
    expect(first.events).toHaveLength(1); // the earlier snapshot did not grow
  });

  it("deep-freezes each event and its payloads, so a snapshot cannot be mutated", () => {
    const inspector = createInspector({ ringSize: 10 });
    inspector.captureNormalized(0, 0, "kiosk-v1", { u: "bob" }, { user: "bob" });
    const event = inspector.snapshot().events[0];
    expect(event !== undefined && Object.isFrozen(event)).toBe(true);
    expect(event !== undefined && Object.isFrozen(event.raw)).toBe(true);
    expect(event !== undefined && Object.isFrozen(event.normalized)).toBe(true);
  });
});
