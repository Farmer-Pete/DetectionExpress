/**
 * The dev-host client: the browser glue that subscribes to one Scenario's Algorithm
 * file over same-origin Server-Sent Events and pushes each saved source into the
 * run. It lives in `game/` because it touches the network; `sim/` stays pure. It is
 * referenced only under `DEV_KIT` and loaded by a dynamic import, so it is never a
 * static input to the CDN build.
 *
 * The stream is scoped by `?slug=<scenarioSlug>`, so a client hears only its own
 * Scenario. SSE is ordered, so there is no fetch race and no abort guard; source flows
 * through the one ordered channel. As defense in depth, the client still drops any
 * frame whose `slug` is not its own, and `disconnect()` marks the client disposed so
 * no late frame applies source after teardown.
 */

/** The dev state the panel renders. The App maps `path` to the store's lock. */
export interface DevState {
  status: "off" | "connected" | "error";
  /** The active file path, once the Scenario file is created; null otherwise. */
  path: string | null;
  message: string | null;
}

/** The subset of `EventSource` the client needs, so tests inject a fake. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
}

/**
 * The subset of `fetch` the client needs. The global `fetch` is assignable to it,
 * and a test fake need not carry Bun's extra `fetch.preconnect` member.
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface DevHostClientDeps {
  /** The Scenario this client subscribes to. */
  scenarioSlug: string;
  /** Push a source into the run: `setAlgorithmSource` then `run()`. */
  applySource: (text: string) => void;
  onState: (state: DevState) => void;
  /** Injected in tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Injected in tests; defaults to a real same-origin `EventSource`. */
  eventSource?: (url: string) => EventSourceLike;
}

export interface DevHostClient {
  /** Open `/api/algorithm/events?slug=<scenarioSlug>`. */
  connect(): void;
  /** Close the stream, dispose, and drop any late callbacks. */
  disconnect(): void;
  /** Create or activate the Scenario file, open it in the OS editor, and start the watch. */
  editInIde(name: string, defaultSource: string): Promise<{ path: string; existed: boolean }>;
}

/** An `init` frame: the retained per-slug snapshot. */
interface InitFrame {
  slug: string;
  path: string | null;
  source: string | null;
}

/** A `changed` frame: a save, source only. */
interface ChangedFrame {
  slug: string;
  source: string;
}

/** Reverse the host's framing: base64 back to the UTF-8 JSON text of the payload. */
function decodeFrameText(data: string): string {
  const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** A string primitive, by its tag rather than a representation check. */
function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

/** A boolean primitive, by its tag. */
function isBoolean(value: unknown): value is boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]";
}

/** A string or an explicit null: the shape of `path` and `source` on an init frame. */
function isStringOrNull(value: unknown): value is string | null {
  return value === null || isString(value);
}

/**
 * Decode, JSON-parse, and confirm an object from a frame's base64 data, or null on any
 * malformed input. A bad base64 string or non-JSON body would otherwise throw inside
 * the EventSource listener and surface as an uncaught error in the tab, so the error
 * boundary lives here and each frame's decode is contained.
 */
function parseFrameObject(data: string): object | null {
  try {
    const value = JSON.parse(decodeFrameText(data));
    return value instanceof Object ? value : null;
  } catch {
    return null;
  }
}

/** Parse an `init` frame's base64 data into the retained snapshot, or null. */
function asInitFrame(data: string): InitFrame | null {
  const value = parseFrameObject(data);
  if (value === null || !("slug" in value && "path" in value && "source" in value)) {
    return null;
  }
  const { slug, path, source } = value;
  if (isString(slug) && isStringOrNull(path) && isStringOrNull(source)) {
    return { slug, path, source };
  }
  return null;
}

/** Parse a `changed` frame's base64 data into a save, or null. */
function asChangedFrame(data: string): ChangedFrame | null {
  const value = parseFrameObject(data);
  if (value === null || !("slug" in value && "source" in value)) {
    return null;
  }
  const { slug, source } = value;
  if (isString(slug) && isString(source)) {
    return { slug, source };
  }
  return null;
}

/** Parse the `/api/algorithm` reply, reading only `{ path, existed }`. */
function asEditReply(value: unknown): { path: string; existed: boolean } {
  if (value instanceof Object && "path" in value && "existed" in value) {
    const { path, existed } = value;
    if (isString(path) && isBoolean(existed)) {
      return { path, existed };
    }
  }
  throw new Error("The dev host returned an unexpected response to /api/algorithm.");
}

export function createDevHostClient(deps: DevHostClientDeps): DevHostClient {
  const doFetch = deps.fetch ?? fetch;
  const openStream = deps.eventSource ?? ((url: string): EventSourceLike => new EventSource(url));

  let stream: EventSourceLike | null = null;
  let disposed = false;
  let path: string | null = null;

  const report = (status: DevState["status"], message: string | null): void => {
    if (disposed) {
      return;
    }
    deps.onState({ status, path, message });
  };

  const handleInit = (event: { data: string }): void => {
    if (disposed) {
      return;
    }
    const frame = asInitFrame(event.data);
    if (frame === null || frame.slug !== deps.scenarioSlug) {
      return; // defense: a foreign or malformed frame changes nothing
    }
    path = frame.path;
    report("connected", null);
    if (frame.source !== null) {
      deps.applySource(frame.source);
    }
  };

  const handleChanged = (event: { data: string }): void => {
    if (disposed) {
      return;
    }
    const frame = asChangedFrame(event.data);
    if (frame === null || frame.slug !== deps.scenarioSlug) {
      return;
    }
    deps.applySource(frame.source);
  };

  const handleError = (): void => {
    report("error", "The dev host stream errored. Retry when the host is back.");
  };

  return {
    connect(): void {
      if (disposed || stream !== null) {
        return;
      }
      const url = `/api/algorithm/events?slug=${encodeURIComponent(deps.scenarioSlug)}`;
      stream = openStream(url);
      stream.addEventListener("init", handleInit);
      stream.addEventListener("changed", handleChanged);
      stream.addEventListener("error", handleError);
      report("connected", null);
    },

    disconnect(): void {
      disposed = true;
      stream?.close();
      stream = null;
    },

    async editInIde(name, defaultSource): Promise<{ path: string; existed: boolean }> {
      const response = await doFetch("/api/algorithm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, defaultSource }),
      });
      // The host returns its failure reason as a text/plain body (503 at capacity,
      // 400 invalid name, 403 symlink). Surface that reason rather than blindly
      // JSON-parsing an error body, so the panel shows the specific message.
      if (!response.ok) {
        const reason = (await response.text()).trim();
        throw new Error(
          reason.length > 0 ? reason : `The dev host rejected the request (${response.status}).`,
        );
      }
      return asEditReply(await response.json());
    },
  };
}
