import { describe, expect, it } from "bun:test";
import {
  createDevHostClient,
  type DevHostClientDeps,
  type DevState,
  type EventSourceLike,
  type FetchLike,
} from "./dev-host-client";

const SLUG = "kiosk-pin-attack";

/** Base64 of the JSON a real host would put in an SSE frame's `data:` line. */
function frameData(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/** A fake EventSource the test drives frame by frame. */
class FakeEventSource implements EventSourceLike {
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  /** Deliver a named SSE frame with a base64 JSON payload. */
  emit(type: string, payload: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: frameData(payload) });
    }
  }

  /** Deliver a named SSE frame with a raw (possibly malformed) `data` string. */
  emitRaw(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data });
    }
  }

  /** Deliver a stream error. */
  emitError(): void {
    for (const listener of this.listeners.get("error") ?? []) {
      listener({ data: "" });
    }
  }
}

interface Harness {
  client: ReturnType<typeof createDevHostClient>;
  source: FakeEventSource;
  states: DevState[];
  applied: string[];
  fetchCalls: Array<{ url: string; body: unknown }>;
}

function harness(overrides: Partial<DevHostClientDeps> = {}): Harness {
  const states: DevState[] = [];
  const applied: string[] = [];
  const fetchCalls: Array<{ url: string; body: unknown }> = [];
  let source: FakeEventSource | undefined;

  const fakeFetch: FetchLike = async (input, init) => {
    const url = input;
    const body =
      init.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body));
    fetchCalls.push({ url, body });
    return new Response(
      JSON.stringify({ path: "/algorithms/detection-express-kiosk-pin-attack.js", existed: false }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  const client = createDevHostClient({
    scenarioSlug: SLUG,
    applySource: (text) => applied.push(text),
    onState: (state) => states.push(state),
    fetch: fakeFetch,
    eventSource: (url) => {
      source = new FakeEventSource(url);
      return source;
    },
    ...overrides,
  });

  return {
    client,
    get source() {
      if (source === undefined) {
        throw new Error("connect() was not called");
      }
      return source;
    },
    states,
    applied,
    fetchCalls,
  };
}

describe("dev-host client", () => {
  it("opens the slug-scoped stream and reports connected", () => {
    const h = harness();
    h.client.connect();
    expect(h.source.url).toBe(`/api/algorithm/events?slug=${SLUG}`);
    expect(h.states.at(-1)?.status).toBe("connected");
  });

  it("stays unlocked on a cold {path:null, source:null} init and applies nothing", () => {
    const h = harness();
    h.client.connect();
    h.source.emit("init", { slug: SLUG, path: null, source: null });
    expect(h.states.at(-1)?.path).toBeNull();
    expect(h.applied).toEqual([]);
  });

  it("locks and applies on an activate init with a path and source", () => {
    const h = harness();
    h.client.connect();
    h.source.emit("init", {
      slug: SLUG,
      path: "/algorithms/x.js",
      source: "export function match(){}",
    });
    expect(h.states.at(-1)?.path).toBe("/algorithms/x.js");
    expect(h.applied).toEqual(["export function match(){}"]);
  });

  it("reverts and unlocks on a delete init that carries the cached default", () => {
    const h = harness();
    h.client.connect();
    h.source.emit("init", { slug: SLUG, path: "/algorithms/x.js", source: "active" });
    h.source.emit("init", { slug: SLUG, path: null, source: "the default" });
    expect(h.states.at(-1)?.path).toBeNull();
    expect(h.applied).toEqual(["active", "the default"]);
  });

  it("applies a changed frame's decoded source", () => {
    const h = harness();
    h.client.connect();
    h.source.emit("changed", { slug: SLUG, source: "edited source" });
    expect(h.applied).toEqual(["edited source"]);
  });

  it("round-trips Unicode and newlines through the frame decoder", () => {
    const h = harness();
    h.client.connect();
    const src = "// café\nexport function match(e){ return e; }\n";
    h.source.emit("changed", { slug: SLUG, source: src });
    expect(h.applied).toEqual([src]);
  });

  it("drops a frame whose slug is not this client's Scenario", () => {
    const h = harness();
    h.client.connect();
    h.source.emit("init", { slug: "other-scenario", path: "/x.js", source: "nope" });
    h.source.emit("changed", { slug: "other-scenario", source: "nope" });
    expect(h.applied).toEqual([]);
    expect(h.states.every((s) => s.path === null)).toBe(true);
  });

  it("editInIde posts the name and default and reads only {path, existed}", async () => {
    const h = harness();
    const result = await h.client.editInIde(SLUG, "the default source");
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0]?.url).toBe("/api/algorithm");
    expect(h.fetchCalls[0]?.body).toEqual({ name: SLUG, defaultSource: "the default source" });
    expect(result).toEqual({
      path: "/algorithms/detection-express-kiosk-pin-attack.js",
      existed: false,
    });
    // The saved source arrives over SSE, never from the POST reply.
    expect(h.applied).toEqual([]);
  });

  it("ignores a malformed frame instead of letting it throw in the tab", () => {
    const h = harness();
    h.client.connect();
    // A frame whose data is not valid base64, and one that is base64 but not JSON.
    expect(() => h.source.emitRaw("init", "@@@ not base64 @@@")).not.toThrow();
    expect(() =>
      h.source.emitRaw("changed", Buffer.from("not json", "utf8").toString("base64")),
    ).not.toThrow();
    expect(h.applied).toEqual([]);
    // A good frame still applies after a bad one, so the stream is not wedged.
    h.source.emit("changed", { slug: SLUG, source: "recovered" });
    expect(h.applied).toEqual(["recovered"]);
  });

  it("surfaces the host's error text when editInIde fails a non-ok response", async () => {
    const failFetch: FetchLike = async () =>
      new Response("The dev host is at capacity.", {
        status: 503,
        headers: { "content-type": "text/plain" },
      });
    const h = harness({ fetch: failFetch });
    await expect(h.client.editInIde(SLUG, "source")).rejects.toThrow(
      "The dev host is at capacity.",
    );
  });

  it("reports error on a stream error", () => {
    const h = harness();
    h.client.connect();
    h.source.emitError();
    expect(h.states.at(-1)?.status).toBe("error");
  });

  it("drops late callbacks after disconnect", () => {
    const h = harness();
    h.client.connect();
    const before = h.source;
    h.client.disconnect();
    expect(before.closed).toBe(true);
    before.emit("init", { slug: SLUG, path: "/x.js", source: "late" });
    before.emit("changed", { slug: SLUG, source: "late" });
    before.emitError();
    expect(h.applied).toEqual([]);
    expect(h.states.at(-1)?.status).not.toBe("error");
  });
});
