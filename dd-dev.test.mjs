// @vitest-environment node
//
// Host-side tests for dd-dev.mjs. These drive the request handler and the
// exported seams directly, with injected spawn/watch/listen/timers/exit and
// temp dirs, so no unit test opens a real socket. Watch behavior is driven
// through the injected `watch` seam (a fake watcher) against real temp files,
// so the transition tests are deterministic and never wait on the OS.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildOpenPlan,
  changedFrame,
  createDevHost,
  createTransitionQueue,
  DEVHOST_MAX_SLUGS,
  decodeSourceB64,
  encodeSourceB64,
  initFrame,
  isRunDirectly,
  isValidSlug,
  listenWithPortWalk,
  mimeForExt,
  openInEditor,
  resolveStaticPath,
} from "./dd-dev.mjs";

// This test file lives at the repo root; `here` is that directory. Replaces Bun's
// `import.meta.dir`, which Node does not provide.
const here = path.dirname(fileURLToPath(import.meta.url));

const PORT = 4321;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;

// --- Fakes ------------------------------------------------------------------

/** A fake request: an async-iterable body plus method/url/headers and close. */
function makeReq(method, url, headers = {}, body = "") {
  const req = Readable.from([Buffer.from(body, "utf8")]);
  req.method = method;
  req.url = url;
  req.headers = headers;
  return req;
}

/** A fake response that records status, headers, and the written body. */
function makeRes() {
  const chunks = [];
  const listeners = new Map();
  return {
    statusCode: null,
    headers: null,
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers ?? {};
      return this;
    },
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk != null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      }
      this.ended = true;
    },
    on(event, cb) {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
      return this;
    },
    emit(event) {
      for (const cb of listeners.get(event) ?? []) {
        cb();
      }
    },
    get body() {
      return chunks.join("");
    },
    chunks,
  };
}

const GET_HEADERS = { host: HOST };
const POST_HEADERS = { host: HOST, origin: ORIGIN, "content-type": "application/json" };

// A recording spawn that never really launches anything.
function makeSpawn() {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { on() {}, unref() {} };
  };
  return { spawn, calls };
}

// A fake fs.watch factory. Each call records a watcher whose filesystem
// callback and event listeners the test drives by hand, so watch behavior is
// deterministic with no reliance on the OS delivering real change events.
// `emit("error", ...)` mimics an EventEmitter: an unhandled "error" throws.
function makeFakeWatch() {
  const watchers = [];
  const watch = (dir, listener) => {
    const handlers = new Map();
    const w = {
      dir,
      closed: false,
      on(event, cb) {
        const list = handlers.get(event) ?? [];
        list.push(cb);
        handlers.set(event, list);
        return w;
      },
      emit(event, arg) {
        const list = handlers.get(event) ?? [];
        if (list.length === 0 && event === "error") {
          throw arg; // Node's EventEmitter throws an unhandled "error".
        }
        for (const cb of list) {
          cb(arg);
        }
      },
      // Simulate the OS firing a change for `filename` under the watched dir.
      trigger(eventType, filename) {
        listener(eventType, filename);
      },
      close() {
        w.closed = true;
      },
    };
    watchers.push(w);
    return w;
  };
  return { watch, watchers };
}

// A recording response whose write can be flipped to throw, to model a dead
// socket that rejects further writes.
function makeFlakyRes() {
  const res = makeRes();
  res.failWrite = false;
  const realWrite = res.write.bind(res);
  res.write = (chunk) => {
    if (res.failWrite) {
      throw new Error("EPIPE: write to a closed socket");
    }
    return realWrite(chunk);
  };
  return res;
}

let tmpRoot;
let algorithmsDir;
let buildRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "dd-dev-"));
  algorithmsDir = path.join(tmpRoot, "algorithms");
  buildRoot = path.join(tmpRoot, "build");
  mkdirSync(algorithmsDir, { recursive: true });
  mkdirSync(buildRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeHost(over = {}) {
  const { spawn, calls } = makeSpawn();
  const host = createDevHost({
    algorithmsDir,
    buildRoot,
    spawn,
    platform: "darwin",
    port: PORT,
    ...over,
  });
  return { host, calls };
}

// Open an SSE subscriber for a slug and return its recording res.
function subscribe(host, slug) {
  const req = makeReq("GET", `/api/algorithm/events?slug=${slug}`, GET_HEADERS);
  const res = makeRes();
  host.handleRequest(req, res);
  return res;
}

async function post(host, name, defaultSource = "") {
  const req = makeReq(
    "POST",
    "/api/algorithm",
    POST_HEADERS,
    JSON.stringify({ name, defaultSource }),
  );
  const res = makeRes();
  await host.handleRequest(req, res);
  return res;
}

function decodeFrame(frameText) {
  // Parse the last complete event frame in the written body.
  const frames = frameText.split("\n\n").filter((f) => f.includes("data:"));
  const last = frames[frames.length - 1];
  const eventLine = last.split("\n").find((l) => l.startsWith("event:"));
  const dataLine = last.split("\n").find((l) => l.startsWith("data:"));
  const event = eventLine.slice("event:".length).trim();
  const data = JSON.parse(decodeSourceB64(dataLine.slice("data:".length).trim()));
  return { event, data };
}

// --- Seam 7: port walk ------------------------------------------------------

describe("listenWithPortWalk", () => {
  it("returns the first port that binds", async () => {
    const tried = [];
    const listen = (port) => {
      tried.push(port);
      return Promise.resolve({ port });
    };
    const { port } = await listenWithPortWalk(listen, 4321, 10);
    expect(port).toBe(4321);
    expect(tried).toEqual([4321]);
  });

  it("retries on EADDRINUSE and returns the next free port", async () => {
    const tried = [];
    const listen = (port) => {
      tried.push(port);
      if (port < 4323) {
        const err = new Error("in use");
        err.code = "EADDRINUSE";
        return Promise.reject(err);
      }
      return Promise.resolve({ port });
    };
    const { port } = await listenWithPortWalk(listen, 4321, 10);
    expect(port).toBe(4323);
    expect(tried).toEqual([4321, 4322, 4323]);
  });

  it("walks the inclusive range and then rejects when exhausted", async () => {
    const tried = [];
    const listen = (port) => {
      tried.push(port);
      const err = new Error("in use");
      err.code = "EADDRINUSE";
      return Promise.reject(err);
    };
    await expect(listenWithPortWalk(listen, 4321, 10)).rejects.toThrow("in use");
    expect(tried).toEqual([4321, 4322, 4323, 4324, 4325, 4326, 4327, 4328, 4329, 4330]);
  });

  it("aborts at once on a non-EADDRINUSE failure", async () => {
    const tried = [];
    const listen = (port) => {
      tried.push(port);
      const err = new Error("no permission");
      err.code = "EACCES";
      return Promise.reject(err);
    };
    await expect(listenWithPortWalk(listen, 4321, 10)).rejects.toThrow("no permission");
    expect(tried).toEqual([4321]);
  });
});

// --- Seam 3: name and path safety ------------------------------------------

describe("name and path safety", () => {
  it("accepts only the slug pattern", () => {
    expect(isValidSlug("kiosk-pin-attack")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
    expect(isValidSlug("a".repeat(64))).toBe(true);
  });

  it("rejects separators, dot-dot, unicode, empty, and non-strings", () => {
    for (const bad of ["", "..", "a/b", "a\\b", "a.b", "A", "café", "a".repeat(65), " ", "a b"]) {
      expect(isValidSlug(bad)).toBe(false);
    }
    expect(isValidSlug(123)).toBe(false);
    expect(isValidSlug(null)).toBe(false);
    expect(isValidSlug(undefined)).toBe(false);
  });

  it("rejects an invalid POST name with 400 and writes no file", async () => {
    const { host } = makeHost();
    const res = await post(host, "../escape");
    expect(res.statusCode).toBe(400);
    expect(host.slugs.size).toBe(0);
  });

  it("builds detection-express-<name>.js under the algorithms dir", async () => {
    const { host } = makeHost();
    const res = await post(host, "kiosk-pin-attack", "x");
    const body = JSON.parse(res.body);
    expect(body.path).toBe(path.join(algorithmsDir, "detection-express-kiosk-pin-attack.js"));
  });

  it("confines a static path with .. inside the build root", () => {
    expect(resolveStaticPath(buildRoot, "/../secret")).toBeNull();
    expect(resolveStaticPath(buildRoot, "/a/../../secret")).toBeNull();
    expect(resolveStaticPath(buildRoot, "/assets/app.js")).toBe(
      path.join(buildRoot, "assets/app.js"),
    );
  });
});

// --- Seam 5: static serving -------------------------------------------------

describe("static serving", () => {
  beforeEach(() => {
    writeFileSync(path.join(buildRoot, "index.html"), "<html>index</html>");
    writeFileSync(path.join(buildRoot, "app.js"), "console.log(1)");
    writeFileSync(path.join(buildRoot, "app.css"), "body{}");
  });

  it("maps extensions to MIME types", () => {
    expect(mimeForExt(".js")).toBe("text/javascript");
    expect(mimeForExt(".css")).toBe("text/css");
    expect(mimeForExt(".html")).toBe("text/html");
  });

  async function get(host, url, method = "GET") {
    const req = makeReq(method, url, GET_HEADERS);
    const res = makeRes();
    await host.handleRequest(req, res);
    return res;
  }

  it("serves a .js asset with the right MIME on GET", async () => {
    const { host } = makeHost();
    const res = await get(host, "/app.js");
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/javascript");
    expect(res.body).toBe("console.log(1)");
  });

  it("answers HEAD with headers and no body", async () => {
    const { host } = makeHost();
    const res = await get(host, "/app.css", "HEAD");
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/css");
    expect(res.body).toBe("");
  });

  it("maps / and a directory path to index.html", async () => {
    const { host } = makeHost();
    expect((await get(host, "/")).body).toContain("index");
    expect((await get(host, "/levels/")).body).toContain("index");
    expect((await get(host, "/some-client-route")).body).toContain("index");
  });

  it("falls back to index.html for a missing asset", async () => {
    const { host } = makeHost();
    const res = await get(host, "/missing.js");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("index");
  });

  it("rejects a non-GET/HEAD method with 405", async () => {
    const { host } = makeHost();
    const req = makeReq("PUT", "/app.js", { host: HOST, origin: ORIGIN });
    const res = makeRes();
    await host.handleRequest(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("rejects a symlinked asset with 403", async () => {
    const { host } = makeHost();
    const secret = path.join(tmpRoot, "secret.js");
    writeFileSync(secret, "secret");
    symlinkSync(secret, path.join(buildRoot, "link.js"));
    const res = await get(host, "/link.js");
    expect(res.statusCode).toBe(403);
  });
});

// --- Seam 4: same-origin guard ---------------------------------------------

describe("same-origin guard", () => {
  beforeEach(() => {
    writeFileSync(path.join(buildRoot, "index.html"), "index");
  });

  it("rejects a POST with a missing, null, or foreign Origin", async () => {
    const { host } = makeHost();
    for (const origin of [undefined, "null", "http://evil.example"]) {
      const headers = { host: HOST, "content-type": "application/json" };
      if (origin !== undefined) {
        headers.origin = origin;
      }
      const req = makeReq("POST", "/api/algorithm", headers, JSON.stringify({ name: "x" }));
      const res = makeRes();
      await host.handleRequest(req, res);
      expect(res.statusCode).toBe(403);
    }
  });

  it("rejects a POST with a foreign Host", async () => {
    const { host } = makeHost();
    const req = makeReq(
      "POST",
      "/api/algorithm",
      { host: "evil.example", origin: ORIGIN },
      JSON.stringify({ name: "x" }),
    );
    const res = makeRes();
    await host.handleRequest(req, res);
    expect(res.statusCode).toBe(403);
  });

  it("accepts a GET with no Origin but a matching Host", async () => {
    const { host } = makeHost();
    const req = makeReq("GET", "/", { host: HOST });
    const res = makeRes();
    await host.handleRequest(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("rejects a GET with a foreign Origin", async () => {
    const { host } = makeHost();
    const req = makeReq("GET", "/", { host: HOST, origin: "http://evil.example" });
    const res = makeRes();
    await host.handleRequest(req, res);
    expect(res.statusCode).toBe(403);
  });

  it("rejects a GET whose Sec-Fetch-Site is cross-site", async () => {
    const { host } = makeHost();
    const req = makeReq("GET", "/", { host: HOST, "sec-fetch-site": "cross-site" });
    const res = makeRes();
    await host.handleRequest(req, res);
    expect(res.statusCode).toBe(403);
  });

  it("accepts a GET whose Sec-Fetch-Site is none (top-level navigation)", async () => {
    const { host } = makeHost();
    const req = makeReq("GET", "/", { host: HOST, "sec-fetch-site": "none" });
    const res = makeRes();
    await host.handleRequest(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("accepts the exact loopback origin on GET and POST", async () => {
    const { host } = makeHost();
    const getRes = makeRes();
    await host.handleRequest(makeReq("GET", "/", { host: HOST, origin: ORIGIN }), getRes);
    expect(getRes.statusCode).toBe(200);
    const postRes = await post(host, "kiosk");
    expect(postRes.statusCode).toBe(200);
  });
});

// --- Seam 2: API handler ----------------------------------------------------

describe("API handler", () => {
  it("reports health with the marker and active slugs", async () => {
    const { host } = makeHost();
    await post(host, "kiosk", "x");
    const req = makeReq("GET", "/api/health", GET_HEADERS);
    const res = makeRes();
    await host.handleRequest(req, res);
    const body = JSON.parse(res.body);
    expect(body.app).toBe("detection-express-devhost");
    const pkg = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8"));
    expect(body.version).toBe(pkg.version);
    expect(body.activeSlugs).toEqual(["kiosk"]);
  });

  it("creates the file with wx seeded from defaultSource and opens it", async () => {
    const { host, calls } = makeHost();
    const res = await post(host, "kiosk", "const x = 1;");
    const body = JSON.parse(res.body);
    expect(body.existed).toBe(false);
    expect(body.path).toBe(path.join(algorithmsDir, "detection-express-kiosk.js"));
    const onDisk = await readFile(body.path, "utf8");
    expect(onDisk).toBe("const x = 1;");
    expect(calls[0].command).toBe("open");
    expect(calls[0].args).toEqual([body.path]);
  });

  it("does not overwrite an existing file and reports existed:true", async () => {
    const { host } = makeHost();
    await post(host, "kiosk", "first");
    const res = await post(host, "kiosk", "second");
    const body = JSON.parse(res.body);
    expect(body.existed).toBe(true);
    expect(await readFile(body.path, "utf8")).toBe("first");
  });

  it("caches defaultSource by slug for the delete revert", async () => {
    const { host } = makeHost();
    await post(host, "kiosk", "the-default");
    expect(host.slugs.get("kiosk").cachedDefault).toBe("the-default");
  });

  it("pushes an init frame carrying the file content to a subscriber", async () => {
    const { host } = makeHost();
    const sub = subscribe(host, "kiosk");
    await post(host, "kiosk", "seed-source");
    const { event, data } = decodeFrame(sub.body);
    expect(event).toBe("init");
    expect(data.slug).toBe("kiosk");
    expect(data.source).toBe("seed-source");
  });

  it("returns 404 for an unknown /api route", async () => {
    const { host } = makeHost();
    const req = makeReq("GET", "/api/nope", GET_HEADERS);
    const res = makeRes();
    await host.handleRequest(req, res);
    expect(res.statusCode).toBe(404);
  });
});

// --- Seam 6: SSE framing + base64 unicode ----------------------------------

describe("SSE framing", () => {
  it("builds the exact changed frame", () => {
    const frame = changedFrame("kiosk", "hello");
    const data = encodeSourceB64(JSON.stringify({ slug: "kiosk", source: "hello" }));
    expect(frame).toBe(`event: changed\ndata: ${data}\n\n`);
  });

  it("builds the exact init frame with the {slug, path, source} schema", () => {
    const frame = initFrame("kiosk", "/tmp/x.js", "src");
    const [eventLine, dataLine] = frame.split("\n");
    expect(eventLine).toBe("event: init");
    const decoded = JSON.parse(decodeSourceB64(dataLine.slice("data: ".length)));
    expect(decoded).toEqual({ slug: "kiosk", path: "/tmp/x.js", source: "src" });
  });

  it("carries the cold-start snapshot on connect", () => {
    const { host } = makeHost();
    const sub = subscribe(host, "kiosk");
    const { event, data } = decodeFrame(sub.body);
    expect(event).toBe("init");
    expect(data).toEqual({ slug: "kiosk", path: null, source: null });
  });

  it("round-trips unicode and multi-line source through base64", () => {
    const source = "// café ☕\nconst π = 3.14;\nconst 日本 = '🎯';\n";
    expect(decodeSourceB64(encodeSourceB64(source))).toBe(source);
    const { data } = decodeFrame(changedFrame("x", source));
    expect(data.source).toBe(source);
  });

  it("uses a colon keepalive comment", async () => {
    const fakeInterval = { fn: null };
    const timers = {
      setTimeout,
      clearTimeout,
      setInterval: (fn) => {
        fakeInterval.fn = fn;
        return 1;
      },
      clearInterval: () => {},
    };
    const { host } = makeHost({ timers });
    const sub = subscribe(host, "kiosk");
    const before = sub.body;
    fakeInterval.fn();
    expect(sub.body.slice(before.length)).toBe(":\n\n");
  });
});

// --- Seam 9: open in the OS default handler --------------------------------

describe("open in the OS default handler", () => {
  it("uses open with the path as one argv entry on macOS", () => {
    const plan = buildOpenPlan("/tmp/a b.js", "darwin");
    expect(plan).toEqual({ command: "open", args: ["/tmp/a b.js"], env: {} });
  });

  it("uses xdg-open on Linux", () => {
    const plan = buildOpenPlan("/tmp/x.js", "linux");
    expect(plan).toEqual({ command: "xdg-open", args: ["/tmp/x.js"], env: {} });
  });

  it("uses PowerShell Start-Process with the path in DD_OPEN on Windows", () => {
    const weird = "C:\\a&b|c;d.js";
    const plan = buildOpenPlan(weird, "win32");
    expect(plan.command).toBe("powershell");
    expect(plan.args).toEqual(["-NoProfile", "-Command", "Start-Process -FilePath $Env:DD_OPEN"]);
    expect(plan.env).toEqual({ DD_OPEN: weird });
    // The path never appears in the command string itself.
    expect(plan.args.join(" ")).not.toContain(weird);
  });

  it("never throws when spawn fails", () => {
    const spawn = () => {
      throw new Error("ENOENT");
    };
    let reported = null;
    expect(() =>
      openInEditor("/tmp/x.js", { spawn, platform: "darwin", onError: (r) => (reported = r) }),
    ).not.toThrow();
    expect(reported).toBe("ENOENT");
  });
});

// --- Seam 15: transition queue ---------------------------------------------

describe("transition queue", () => {
  it("keeps the tail fulfilled after a rejected transition", async () => {
    const { enqueueTransition } = createTransitionQueue();
    const order = [];
    const bad = enqueueTransition(async () => {
      order.push("bad");
      throw new Error("boom");
    });
    await expect(bad).rejects.toThrow("boom");
    const good = enqueueTransition(async () => {
      order.push("good");
      return 42;
    });
    expect(await good).toBe(42);
    expect(order).toEqual(["bad", "good"]);
  });

  it("serializes transitions in order", async () => {
    const { enqueueTransition } = createTransitionQueue();
    const order = [];
    const a = enqueueTransition(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("a");
    });
    const b = enqueueTransition(async () => {
      order.push("b");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
  });
});

// --- Seams 8 + 13: watch and delete-revert ---------------------------------
//
// These drive a fake watcher (the host's `watch` seam) so the transition logic
// runs against real files on disk without depending on the OS delivering
// change events. The `recreates` case is a real-fs smoke test off the watch
// path: it only exercises create/delete/recreate, no watch frame.

describe("watch and delete-revert", () => {
  it("fires an SSE frame on a temp-file-and-rename save", async () => {
    const { watch, watchers } = makeFakeWatch();
    const { host } = makeHost({ watch, debounceMs: 5 });
    const sub = subscribe(host, "kiosk");
    const res = await post(host, "kiosk", "original");
    const filePath = JSON.parse(res.body).path;

    const tmp = path.join(algorithmsDir, "tmp-save");
    await writeFile(tmp, "edited-source");
    await rename(tmp, filePath); // atomic rename over the watched file
    watchers[0].trigger("rename", path.basename(filePath));

    const frame = await waitForFrame(sub, "changed", (d) => d.source === "edited-source");
    expect(frame.data.source).toBe("edited-source");
  });

  it("reverts to the cached default when the file is deleted", async () => {
    const { watch, watchers } = makeFakeWatch();
    const { host } = makeHost({ watch, debounceMs: 5 });
    const sub = subscribe(host, "kiosk");
    const res = await post(host, "kiosk", "the-default");
    const filePath = JSON.parse(res.body).path;

    rmSync(filePath);
    watchers[0].trigger("rename", path.basename(filePath));

    // The cold-start init also has path null; wait for the revert with a source.
    const frame = await waitForFrame(sub, "init", (d) => d.path === null && d.source !== null);
    expect(frame.data).toEqual({ slug: "kiosk", path: null, source: "the-default" });
  });

  it("recreates the file on a following POST after delete", async () => {
    const { host } = makeHost({ debounceMs: 20 });
    const first = await post(host, "kiosk", "the-default");
    const filePath = JSON.parse(first.body).path;
    rmSync(filePath);
    const second = await post(host, "kiosk", "ignored-because-exists-logic");
    const body = JSON.parse(second.body);
    expect(body.existed).toBe(false);
    expect(await readFile(filePath, "utf8")).toBe("ignored-because-exists-logic");
  });
});

// --- Seam 16: retained snapshot --------------------------------------------

describe("retained snapshot", () => {
  it("gives a fresh connection the post-delete revert, not cold null", async () => {
    const { watch, watchers } = makeFakeWatch();
    const { host } = makeHost({ watch, debounceMs: 5 });
    const sub = subscribe(host, "kiosk");
    const res = await post(host, "kiosk", "the-default");
    const filePath = JSON.parse(res.body).path;
    rmSync(filePath);
    watchers[0].trigger("rename", path.basename(filePath));
    await waitForFrame(sub, "init", (d) => d.path === null && d.source !== null);

    // A brand-new subscriber must still hear the revert, not cold null.
    const fresh = subscribe(host, "kiosk");
    const { data } = decodeFrame(fresh.body);
    expect(data).toEqual({ slug: "kiosk", path: null, source: "the-default" });
  });
});

// --- Seam 17: per-slug isolation -------------------------------------------

describe("per-slug isolation", () => {
  it("delivers a save only to the matching slug's stream", async () => {
    const { watch, watchers } = makeFakeWatch();
    const { host } = makeHost({ watch, debounceMs: 5 });
    const subA = subscribe(host, "scenario-a");
    const subB = subscribe(host, "scenario-b");
    const resA = await post(host, "scenario-a", "a-default");
    await post(host, "scenario-b", "b-default");

    const filePathA = JSON.parse(resA.body).path;
    await writeFile(filePathA, "a-edited");
    // watchers[0] belongs to scenario-a (activated first).
    watchers[0].trigger("change", path.basename(filePathA));

    const frameA = await waitForFrame(subA, "changed", (d) => d.source === "a-edited");
    expect(frameA.data.source).toBe("a-edited");

    // Give any stray delivery a chance to land, then prove B stayed clean.
    await new Promise((r) => setTimeout(r, 30));
    expect(subB.body).not.toContain(
      encodeSourceB64(JSON.stringify({ slug: "scenario-a", source: "a-edited" })),
    );
    for (const block of subB.body.split("\n\n").filter((f) => f.includes("data:"))) {
      const data = JSON.parse(
        decodeSourceB64(
          block
            .split("\n")
            .find((l) => l.startsWith("data:"))
            .slice("data:".length)
            .trim(),
        ),
      );
      expect(data.slug).toBe("scenario-b");
    }
  });
});

// --- Seam 18: channel validation -------------------------------------------

describe("channel validation", () => {
  async function events(host, query) {
    const req = makeReq("GET", `/api/algorithm/events${query}`, GET_HEADERS);
    const res = makeRes();
    await host.handleRequest(req, res);
    return res;
  }

  it("rejects a missing slug with 400 and allocates no state", async () => {
    const { host } = makeHost();
    const res = await events(host, "");
    expect(res.statusCode).toBe(400);
    expect(host.slugs.size).toBe(0);
  });

  it("rejects a duplicate slug with 400", async () => {
    const { host } = makeHost();
    const res = await events(host, "?slug=a&slug=b");
    expect(res.statusCode).toBe(400);
    expect(host.slugs.size).toBe(0);
  });

  it("rejects a malformed slug with 400", async () => {
    const { host } = makeHost();
    const res = await events(host, "?slug=Bad_Slug!");
    expect(res.statusCode).toBe(400);
    expect(host.slugs.size).toBe(0);
  });
});

// --- Seam 19: resource lifecycle -------------------------------------------

describe("resource lifecycle", () => {
  it("removes a subscriber when its SSE request closes", async () => {
    const { host } = makeHost();
    for (let i = 0; i < 3; i += 1) {
      const sub = subscribe(host, "kiosk");
      expect(host.slugs.get("kiosk").subscribers.size).toBe(1);
      sub.emit("close");
      // A never-activated slug is reaped once its last stream closes.
      expect(host.slugs.get("kiosk")?.subscribers.size ?? 0).toBe(0);
    }
  });

  it("keeps the watcher after a client disconnects", async () => {
    const { host } = makeHost({ debounceMs: 20 });
    const sub = subscribe(host, "kiosk");
    await post(host, "kiosk", "x");
    expect(host.slugs.get("kiosk").watcher).not.toBeNull();
    sub.emit("close");
    expect(host.slugs.get("kiosk").watcher).not.toBeNull();
  });

  it("returns 503 past the slug cap with no eviction", async () => {
    // A tiny cap keeps the test cheap.
    const { host } = makeHost({ maxSlugs: 2 });
    expect((await post(host, "one")).statusCode).toBe(200);
    expect((await post(host, "two")).statusCode).toBe(200);
    const over = await post(host, "three");
    expect(over.statusCode).toBe(503);
    expect(over.body).toContain("scenario"); // domain wording, not "level"
    expect(host.activeSlugs().sort()).toEqual(["one", "two"]);
    // A re-activation of an existing slug is still allowed past the cap.
    expect((await post(host, "one")).statusCode).toBe(200);
  });

  it("uses the real DEVHOST_MAX_SLUGS default of 64", () => {
    expect(DEVHOST_MAX_SLUGS).toBe(64);
  });

  it("shuts down once, ignores a second signal, and the fallback forces exit", () => {
    const timeouts = [];
    let exited = null;
    const timers = {
      setTimeout: (fn) => {
        timeouts.push(fn);
        return timeouts.length;
      },
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
    };
    const { host } = makeHost({ timers, exit: (code) => (exited = code) });

    // A server whose close callback never fires simulates a hung close.
    let closeCalls = 0;
    host.setServer({
      close() {
        closeCalls += 1;
      },
    });

    host.shutdown();
    expect(closeCalls).toBe(1);
    host.shutdown(); // second signal is a no-op
    expect(closeCalls).toBe(1);

    // The fallback timer forces exit(0) when close hangs.
    expect(exited).toBeNull();
    timeouts[0]();
    expect(exited).toBe(0);
  });

  it("clears the fallback and exits when close completes orderly", () => {
    let cleared = false;
    let exited = null;
    const timers = {
      setTimeout: () => 99,
      clearTimeout: (id) => {
        cleared = id === 99;
      },
      setInterval: () => 0,
      clearInterval: () => {},
    };
    const { host } = makeHost({ timers, exit: (code) => (exited = code) });
    host.setServer({
      close(cb) {
        cb();
      },
    });
    host.shutdown();
    expect(cleared).toBe(true);
    expect(exited).toBe(0);
  });
});

// --- Fix B2: direct-run detection through a symlinked bin --------------------

describe("direct-run detection", () => {
  const moduleUrl = new URL("./dd-dev.mjs", import.meta.url).href;
  const modulePath = fileURLToPath(new URL("./dd-dev.mjs", import.meta.url));

  it("is true when argv[1] is a symlink resolving to the module", () => {
    const link = path.join(tmpRoot, "bin-link.mjs");
    symlinkSync(modulePath, link);
    expect(isRunDirectly(link, moduleUrl)).toBe(true);
  });

  it("is true when argv[1] is the module path itself", () => {
    expect(isRunDirectly(modulePath, moduleUrl)).toBe(true);
  });

  it("is false for an unrelated argv[1] or a missing one", () => {
    expect(isRunDirectly(path.join(tmpRoot, "other.js"), moduleUrl)).toBe(false);
    expect(isRunDirectly(null, moduleUrl)).toBe(false);
    expect(isRunDirectly(undefined, moduleUrl)).toBe(false);
  });
});

// --- Fix M1: activation failure never leaks the slug cap ---------------------

describe("activation failure rollback", () => {
  // Pre-planting a symlink at the target path forces activate() to reject at
  // its symlink guard, exercising a failed activation deterministically.
  function plantSymlinkTarget(slug) {
    const secret = path.join(tmpRoot, `secret-${slug}.js`);
    writeFileSync(secret, "secret");
    symlinkSync(secret, path.join(algorithmsDir, `detection-express-${slug}.js`));
  }

  it("does not count a slug whose activation fails and never exhausts the cap", async () => {
    const { host } = makeHost({ maxSlugs: 2 });
    plantSymlinkTarget("evil");
    for (let i = 0; i < 5; i += 1) {
      const res = await post(host, "evil", "x");
      expect(res.statusCode).toBe(403);
    }
    // The failed slug is not tracked and not counted against the cap.
    expect(host.slugs.has("evil")).toBe(false);
    expect(host.activeSlugs()).toEqual([]);
    // Two genuinely new slugs still fit within the cap.
    expect((await post(host, "one", "x")).statusCode).toBe(200);
    expect((await post(host, "two", "x")).statusCode).toBe(200);
  });

  it("keeps an existing active slug when a re-activation fails", async () => {
    const { host } = makeHost();
    await post(host, "kiosk", "first");
    expect(host.activeSlugs()).toEqual(["kiosk"]);
    // Swap the file for a symlink, then a re-POST fails its guard.
    rmSync(path.join(algorithmsDir, "detection-express-kiosk.js"));
    plantSymlinkTarget("kiosk");
    const res = await post(host, "kiosk", "second");
    expect(res.statusCode).toBe(403);
    // The previously active slug is retained, still active.
    expect(host.activeSlugs()).toEqual(["kiosk"]);
  });

  // F1: an SSE-created entry whose POST fails must not linger holding cachedDefault,
  // or maybeReap can never collect it and repeated failures exhaust the events cap.
  it("reaps a failed-activation entry once the SSE closes and never exhausts the cap", async () => {
    const { host } = makeHost({ maxSlugs: 2 });
    const target = path.join(algorithmsDir, "detection-express-evil.js");
    for (let i = 0; i < 5; i += 1) {
      // SSE-connect first (creates the entry), then a POST that fails its guard.
      const sub = subscribe(host, "evil");
      plantSymlinkTarget("evil");
      const res = await post(host, "evil", "x");
      expect(res.statusCode).toBe(403);
      // The failed POST left cachedDefault null, so closing the SSE reaps the entry.
      expect(host.slugs.get("evil").cachedDefault).toBeNull();
      sub.emit("close");
      expect(host.slugs.has("evil")).toBe(false);
      rmSync(target); // clear the planted symlink for the next round
    }
    // The cap is intact: two genuine slugs still fit within it.
    expect((await post(host, "one", "x")).statusCode).toBe(200);
    expect((await post(host, "two", "x")).statusCode).toBe(200);
  });

  // The SSE can close WHILE the POST is in flight (its maybeReap is skipped because
  // the POST holds the reservation). The failed POST's own catch must then reap.
  it("reaps a failed-activation entry even when the SSE closes during the in-flight POST", async () => {
    const { host } = makeHost({ maxSlugs: 1 });
    const sub = subscribe(host, "evil");
    plantSymlinkTarget("evil");
    const posting = post(host, "evil", "x");
    sub.emit("close");
    expect((await posting).statusCode).toBe(403);
    expect(host.slugs.has("evil")).toBe(false);
    // No leaked events-cap slot: a different slug still opens at cap 1.
    expect(subscribe(host, "good").statusCode).toBe(200);
  });
});

// --- F5: concurrent distinct-slug POSTs cannot exceed the cap ----------------

describe("concurrent activation cap", () => {
  function plantSymlinkTarget(slug) {
    const secret = path.join(tmpRoot, `secret-${slug}.js`);
    writeFileSync(secret, "secret");
    symlinkSync(secret, path.join(algorithmsDir, `detection-express-${slug}.js`));
  }

  it("admits exactly one of two concurrent distinct-slug POSTs at cap 1", async () => {
    const { host } = makeHost({ maxSlugs: 1 });
    const [resA, resB] = await Promise.all([post(host, "alpha", "a"), post(host, "beta", "b")]);
    const statuses = [resA.statusCode, resB.statusCode].sort();
    expect(statuses).toEqual([200, 503]);
    // Exactly one slug became active; the reservation blocked the second.
    expect(host.activeSlugs().length).toBe(1);
  });

  it("frees the reserved slot when an activation fails", async () => {
    const { host } = makeHost({ maxSlugs: 1 });
    plantSymlinkTarget("evil");
    expect((await post(host, "evil", "x")).statusCode).toBe(403);
    // The released reservation frees the slot, so a genuine slug still fits at cap 1.
    expect((await post(host, "good", "x")).statusCode).toBe(200);
    expect(host.activeSlugs()).toEqual(["good"]);
  });
});

// --- Fix M2: the file watcher survives an emitted error ----------------------

describe("watcher error handling", () => {
  it("keeps the host alive and reports when the watcher emits an error", async () => {
    const { watch, watchers } = makeFakeWatch();
    const errors = [];
    const { host } = makeHost({ watch, onWatchError: (err) => errors.push(err) });
    await post(host, "kiosk", "x"); // activation installs the watcher
    expect(watchers.length).toBe(1);
    expect(() => watchers[0].emit("error", new Error("watch boom"))).not.toThrow();
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe("watch boom");
  });
});

// --- Fix M3: SSE emit tolerates a dead subscriber ----------------------------

describe("SSE dead-subscriber tolerance", () => {
  it("drops a subscriber whose write throws and still emits to the rest", async () => {
    const { host } = makeHost();
    const good = subscribe(host, "kiosk");
    const badReq = makeReq("GET", "/api/algorithm/events?slug=kiosk", GET_HEADERS);
    const bad = makeFlakyRes();
    await host.handleRequest(badReq, bad);
    expect(host.slugs.get("kiosk").subscribers.size).toBe(2);

    bad.failWrite = true;
    const goodBefore = good.body.length;
    await post(host, "kiosk", "src"); // activate() emits an init frame to all

    // The dead subscriber is dropped; the healthy one still received the frame.
    expect(host.slugs.get("kiosk").subscribers.size).toBe(1);
    expect(good.body.length).toBeGreaterThan(goodBefore);
  });

  it("removes a subscriber when its SSE response emits an error", () => {
    const { host } = makeHost();
    const sub = subscribe(host, "kiosk");
    expect(host.slugs.get("kiosk").subscribers.size).toBe(1);
    sub.emit("error");
    expect(host.slugs.get("kiosk")?.subscribers.size ?? 0).toBe(0);
  });
});

// --- Fix M4: the events path is bounded and reaps idle slugs -----------------

describe("events-path slug bounds", () => {
  it("reaps a closed stream for a never-activated slug", () => {
    const { host } = makeHost();
    const sub = subscribe(host, "kiosk");
    expect(host.slugs.has("kiosk")).toBe(true);
    sub.emit("close");
    expect(host.slugs.has("kiosk")).toBe(false);
  });

  it("stays bounded under a flood of distinct open-then-close streams", () => {
    const { host } = makeHost({ maxSlugs: 3 });
    for (let i = 0; i < 20; i += 1) {
      const sub = subscribe(host, `flood-${i}`);
      sub.emit("close");
    }
    expect(host.slugs.size).toBe(0);
  });

  it("rejects a new SSE slug past the cap with 503 and tracks no state", () => {
    const { host } = makeHost({ maxSlugs: 2 });
    subscribe(host, "a"); // held open
    subscribe(host, "b"); // held open
    const res = subscribe(host, "c");
    expect(res.statusCode).toBe(503);
    expect(host.slugs.has("c")).toBe(false);
  });

  it("keeps an active slug's entry even after its last stream closes", async () => {
    const { host } = makeHost();
    const sub = subscribe(host, "kiosk");
    await post(host, "kiosk", "x"); // now active with a watcher
    sub.emit("close");
    expect(host.slugs.has("kiosk")).toBe(true);
  });
});

// --- Fix M5: an intermediate symlink cannot escape the build root -----------

describe("static confinement through intermediate symlinks", () => {
  beforeEach(() => {
    writeFileSync(path.join(buildRoot, "index.html"), "<html>index</html>");
  });

  it("rejects a request whose intermediate directory symlinks outside the root", async () => {
    const { host } = makeHost();
    const outside = path.join(tmpRoot, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "secret.js"), "SECRET");
    symlinkSync(outside, path.join(buildRoot, "pub")); // buildRoot/pub -> outside
    const req = makeReq("GET", "/pub/secret.js", GET_HEADERS);
    const res = makeRes();
    await host.handleRequest(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("SECRET");
  });

  it("still serves a genuine asset under the (possibly symlinked) temp root", async () => {
    const { host } = makeHost();
    writeFileSync(path.join(buildRoot, "app.js"), "console.log(1)");
    const req = makeReq("GET", "/app.js", GET_HEADERS);
    const res = makeRes();
    await host.handleRequest(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("console.log(1)");
  });

  // F6: the read must target the canonicalized `real` path, not the original request
  // path, so a swap of an intermediate directory after the realpath check cannot make
  // the read escape the root.
  it("reads the canonical realpath, not the raw request path", async () => {
    writeFileSync(path.join(buildRoot, "app.js"), "asset");
    // An in-root intermediate symlink: /via -> buildRoot, so /via/app.js resolves back
    // to buildRoot/app.js. The request path keeps the symlink; `real` is canonical.
    symlinkSync(buildRoot, path.join(buildRoot, "via"));
    const reads = [];
    const { host } = makeHost({
      readAsset: (p) => {
        reads.push(p);
        return Promise.resolve(Buffer.from("asset"));
      },
    });
    const req = makeReq("GET", "/via/app.js", GET_HEADERS);
    const res = makeRes();
    await host.handleRequest(req, res);
    expect(res.statusCode).toBe(200);
    // The read used the symlink-resolved canonical path, not buildRoot/via/app.js.
    expect(reads).toEqual([path.join(realpathSync(buildRoot), "app.js")]);
  });
});

// --- Keepalive/init write isolation -----------------------------------------

describe("SSE initial-write isolation", () => {
  it("drops a subscriber whose initial snapshot write throws, clearing its keepalive", () => {
    const cleared = [];
    const timers = {
      setTimeout,
      clearTimeout,
      setInterval: () => 777,
      clearInterval: (id) => cleared.push(id),
    };
    const { host } = makeHost({ timers });
    const req = makeReq("GET", "/api/algorithm/events?slug=kiosk", GET_HEADERS);
    const res = makeFlakyRes();
    res.failWrite = true; // the initial snapshot write throws
    expect(() => host.handleRequest(req, res)).not.toThrow();
    // No lingering subscriber, and its keepalive interval was cleared.
    expect(host.slugs.get("kiosk")?.subscribers.size ?? 0).toBe(0);
    expect(cleared).toContain(777);
  });
});

// --- Fixes M6 + M9: the watch re-read is guarded and surfaces errors ---------

describe("watch re-read safety", () => {
  it("does not broadcast when the watched file is swapped for a symlink", async () => {
    const { watch, watchers } = makeFakeWatch();
    const readErrors = [];
    const { host } = makeHost({ watch, debounceMs: 5, onReadError: (err) => readErrors.push(err) });
    const sub = subscribe(host, "kiosk");
    const res = await post(host, "kiosk", "seed");
    const filePath = JSON.parse(res.body).path;

    const secret = path.join(tmpRoot, "secret.js");
    writeFileSync(secret, "SECRET");
    rmSync(filePath);
    symlinkSync(secret, filePath); // swap the tracked file for a symlink

    watchers[0].trigger("change", path.basename(filePath));
    await new Promise((r) => setTimeout(r, 40));

    // The foreign content is never framed to the browser.
    expect(sub.body).not.toContain(
      encodeSourceB64(JSON.stringify({ slug: "kiosk", source: "SECRET" })),
    );
    expect(readErrors.length).toBe(1);
  });

  it("surfaces a non-ENOENT read failure instead of silently dropping it", async () => {
    const { watch, watchers } = makeFakeWatch();
    const readErrors = [];
    const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const { host } = makeHost({
      watch,
      debounceMs: 5,
      readSource: () => Promise.reject(eacces),
      onReadError: (err) => readErrors.push(err),
    });
    const sub = subscribe(host, "kiosk");
    const res = await post(host, "kiosk", "seed");
    const before = sub.body.length;

    watchers[0].trigger("change", path.basename(JSON.parse(res.body).path));
    await new Promise((r) => setTimeout(r, 40));

    expect(readErrors.some((e) => e.code === "EACCES")).toBe(true);
    expect(sub.body.length).toBe(before); // no frame emitted on the failure
  });
});

// --- Fix M10: openInEditor reports a nonzero child exit ----------------------

describe("openInEditor exit handling", () => {
  it("reports failure when the opener exits with a nonzero code", () => {
    const handlers = new Map();
    const spawn = () => ({
      on(event, cb) {
        handlers.set(event, cb);
      },
      unref() {},
    });
    let reported = null;
    openInEditor("/tmp/x.js", { spawn, platform: "linux", onError: (r) => (reported = r) });
    handlers.get("exit")(3, null);
    expect(reported).toContain("3");
  });

  it("does not report failure on a clean (zero) exit", () => {
    const handlers = new Map();
    const spawn = () => ({
      on(event, cb) {
        handlers.set(event, cb);
      },
      unref() {},
    });
    let reported = null;
    openInEditor("/tmp/x.js", { spawn, platform: "linux", onError: (r) => (reported = r) });
    handlers.get("exit")(0, null);
    expect(reported).toBeNull();
  });
});

// --- Fix: delete-revert clears active/path so health drops the slug ----------

describe("delete-revert bookkeeping", () => {
  it("clears active and path on the delete revert", async () => {
    const { watch, watchers } = makeFakeWatch();
    const { host } = makeHost({ watch, debounceMs: 5 });
    const sub = subscribe(host, "kiosk");
    const res = await post(host, "kiosk", "the-default");
    const filePath = JSON.parse(res.body).path;
    expect(host.activeSlugs()).toEqual(["kiosk"]);

    rmSync(filePath);
    watchers[0].trigger("rename", path.basename(filePath));
    await waitForFrame(sub, "init", (d) => d.path === null && d.source !== null);

    expect(host.activeSlugs()).toEqual([]);
    expect(host.slugs.get("kiosk").path).toBeNull();
  });
});

// --- Fix: defaultSource must be a string -------------------------------------

describe("defaultSource validation", () => {
  it("rejects a missing or non-string defaultSource with 400 and writes no file", async () => {
    const { host } = makeHost();
    const cases = [
      { name: "kiosk" },
      { name: "kiosk", defaultSource: null },
      { name: "kiosk", defaultSource: 123 },
      { name: "kiosk", defaultSource: {} },
    ];
    for (const payload of cases) {
      const req = makeReq("POST", "/api/algorithm", POST_HEADERS, JSON.stringify(payload));
      const res = makeRes();
      await host.handleRequest(req, res);
      expect(res.statusCode).toBe(400);
    }
    expect(host.slugs.has("kiosk")).toBe(false);
  });
});

// --- Fix: an oversized body is rejected and the request is destroyed ---------

describe("oversized request body", () => {
  it("rejects a body past the limit with 413 and destroys the request", async () => {
    const { host } = makeHost({ bodyLimit: 8 });
    const req = makeReq(
      "POST",
      "/api/algorithm",
      POST_HEADERS,
      JSON.stringify({ name: "kiosk", defaultSource: "far past the tiny limit" }),
    );
    let destroyed = false;
    const realDestroy = req.destroy.bind(req);
    req.destroy = () => {
      destroyed = true;
      return realDestroy();
    };
    const res = makeRes();
    await host.handleRequest(req, res);
    expect(res.statusCode).toBe(413);
    expect(destroyed).toBe(true);
  });

  // F2: the 413 must be written to the client BEFORE the request is destroyed, or
  // destroying tears down the socket and the client never receives the response. A
  // controlled request (not Readable.from, which auto-destroys) isolates the one
  // destroy call the host makes, so the ordering assertion is exact.
  it("writes the 413 to the client before destroying the request", async () => {
    const { host } = makeHost({ bodyLimit: 8 });
    const order = [];
    const listeners = new Map();
    const req = {
      method: "POST",
      url: "/api/algorithm",
      headers: POST_HEADERS,
      on(evt, cb) {
        const list = listeners.get(evt) ?? [];
        list.push(cb);
        listeners.set(evt, list);
        return req;
      },
      off(evt, cb) {
        listeners.set(
          evt,
          (listeners.get(evt) ?? []).filter((f) => f !== cb),
        );
        return req;
      },
      pause() {},
      destroy() {
        order.push("destroy");
      },
    };
    const emit = (evt, arg) => {
      for (const cb of [...(listeners.get(evt) ?? [])]) {
        cb(arg);
      }
    };
    const res = makeRes();
    const realWriteHead = res.writeHead.bind(res);
    res.writeHead = (status, headers) => {
      order.push(`respond:${status}`);
      return realWriteHead(status, headers);
    };

    // handleRequest suspends at readBody with the listeners attached; feeding an
    // over-limit chunk then drives the overflow path.
    const done = host.handleRequest(req, res);
    emit("data", Buffer.from("way past the tiny limit", "utf8"));
    await done;

    expect(res.statusCode).toBe(413);
    expect(order).toEqual(["respond:413", "destroy"]);
  });
});

// --- Fix: unexpected errors do not leak local paths --------------------------

describe("error message hygiene", () => {
  it("responds generically for an unexpected (non-HostError) failure", async () => {
    // Point the algorithms dir at an existing file, so mkdir() throws a raw fs
    // error whose message carries the absolute path.
    const notADir = path.join(tmpRoot, "not-a-dir");
    writeFileSync(notADir, "x");
    const { host } = makeHost({ algorithmsDir: notADir });
    const res = await post(host, "kiosk", "src");
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe("internal error");
    expect(res.body).not.toContain(tmpRoot);
  });

  // F3: a raw fs error from a static read escapes serveFile and handleStatic and lands
  // in the OUTER handleRequest catch. It must be sanitized there too, not echoed
  // verbatim, since a Node fs error message embeds the absolute local path.
  it("does not leak an absolute path when a static read fails in the outer catch", async () => {
    writeFileSync(path.join(buildRoot, "app.js"), "console.log(1)");
    const leakyPath = path.join(buildRoot, "app.js");
    const { host } = makeHost({
      // A read that rejects with a path-bearing fs error, reaching the outer catch.
      readAsset: () =>
        Promise.reject(
          Object.assign(new Error(`EACCES: permission denied, open '${leakyPath}'`), {
            code: "EACCES",
          }),
        ),
    });
    const req = makeReq("GET", "/app.js", GET_HEADERS);
    const res = makeRes();
    await host.handleRequest(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe("internal error");
    expect(res.body).not.toContain(tmpRoot);
  });
});

// --- Fix: health reports the real package version ----------------------------

describe("health version", () => {
  it("reflects the package.json version, not a hardcoded constant", async () => {
    const { host } = makeHost();
    const req = makeReq("GET", "/api/health", GET_HEADERS);
    const res = makeRes();
    await host.handleRequest(req, res);
    const body = JSON.parse(res.body);
    const pkg = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8"));
    expect(body.version).toBe(pkg.version);
  });

  it("honors an explicit version override", async () => {
    const { host } = makeHost({ version: "9.9.9" });
    const req = makeReq("GET", "/api/health", GET_HEADERS);
    const res = makeRes();
    await host.handleRequest(req, res);
    expect(JSON.parse(res.body).version).toBe("9.9.9");
  });
});

// --- helpers ----------------------------------------------------------------

async function waitForFrame(sub, event, predicate = () => true, timeoutMs = 2000) {
  const start = Date.now();
  let seen = 0;
  while (Date.now() - start < timeoutMs) {
    const frames = sub.body.split("\n\n").filter((f) => f.includes("data:"));
    for (let i = seen; i < frames.length; i += 1) {
      const block = frames[i];
      const evt = block
        .split("\n")
        .find((l) => l.startsWith("event:"))
        .slice("event:".length)
        .trim();
      const data = JSON.parse(
        decodeSourceB64(
          block
            .split("\n")
            .find((l) => l.startsWith("data:"))
            .slice("data:".length)
            .trim(),
        ),
      );
      if (evt === event && predicate(data)) {
        return { event: evt, data };
      }
    }
    seen = frames.length;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${event} frame; body:\n${sub.body}`);
}
