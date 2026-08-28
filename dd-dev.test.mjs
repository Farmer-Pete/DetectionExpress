// Host-side tests for dd-dev.mjs. These drive the request handler and the
// exported seams directly, with injected fetch/spawn/listen/timers/exit and
// temp dirs, so no unit test opens a real socket. A few integration tests use
// real fs.watch on a temp dir; they stay fast and deterministic.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  buildOpenPlan,
  changedFrame,
  createDevHost,
  createTransitionQueue,
  DEVHOST_MAX_SLUGS,
  decodeSourceB64,
  encodeSourceB64,
  initFrame,
  isValidSlug,
  listenWithPortWalk,
  mimeForExt,
  openInEditor,
  resolveStaticPath,
} from "./dd-dev.mjs";

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
    expect(body.version).toBe("1.0.0");
    expect(body.activeSlugs).toEqual(["kiosk"]);
  });

  it("creates the file with wx seeded from defaultSource and opens it", async () => {
    const { host, calls } = makeHost();
    const res = await post(host, "kiosk", "const x = 1;");
    const body = JSON.parse(res.body);
    expect(body.existed).toBe(false);
    expect(body.path).toBe(path.join(algorithmsDir, "detection-express-kiosk.js"));
    const onDisk = await Bun.file(body.path).text();
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
    expect(await Bun.file(body.path).text()).toBe("first");
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

// --- Seams 8 + 13: watch and delete-revert (integration) -------------------

describe("watch and delete-revert", () => {
  it("fires an SSE frame on a temp-file-and-rename save", async () => {
    const { host } = makeHost({ debounceMs: 20 });
    const sub = subscribe(host, "kiosk");
    const res = await post(host, "kiosk", "original");
    const filePath = JSON.parse(res.body).path;

    const tmp = path.join(algorithmsDir, "tmp-save");
    await writeFile(tmp, "edited-source");
    await rename(tmp, filePath); // atomic rename over the watched file

    const frame = await waitForFrame(sub, "changed", (d) => d.source === "edited-source");
    expect(frame.data.source).toBe("edited-source");
  });

  it("reverts to the cached default when the file is deleted", async () => {
    const { host } = makeHost({ debounceMs: 20 });
    const sub = subscribe(host, "kiosk");
    const res = await post(host, "kiosk", "the-default");
    const filePath = JSON.parse(res.body).path;

    rmSync(filePath);

    // The cold-start init also has path null; wait for the revert with a source.
    const frame = await waitForFrame(sub, "init", (d) => d.path === null && d.source !== null);
    expect(frame.data).toEqual({ slug: "kiosk", path: null, source: "the-default" });
  });

  it("recreates the file on a following POST after delete", async () => {
    const { host } = makeHost({ debounceMs: 20 });
    const first = await post(host, "kiosk", "the-default");
    const filePath = JSON.parse(first.body).path;
    rmSync(filePath);
    await new Promise((r) => setTimeout(r, 60));
    const second = await post(host, "kiosk", "ignored-because-exists-logic");
    const body = JSON.parse(second.body);
    expect(body.existed).toBe(false);
    expect(await Bun.file(filePath).text()).toBe("ignored-because-exists-logic");
  });
});

// --- Seam 16: retained snapshot --------------------------------------------

describe("retained snapshot", () => {
  it("gives a fresh connection the post-delete revert, not cold null", async () => {
    const { host } = makeHost({ debounceMs: 20 });
    const sub = subscribe(host, "kiosk");
    const res = await post(host, "kiosk", "the-default");
    const filePath = JSON.parse(res.body).path;
    rmSync(filePath);
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
    const { host } = makeHost({ debounceMs: 20 });
    const subA = subscribe(host, "level-a");
    const subB = subscribe(host, "level-b");
    const resA = await post(host, "level-a", "a-default");
    await post(host, "level-b", "b-default");

    const filePathA = JSON.parse(resA.body).path;
    await writeFile(filePathA, "a-edited");

    const frameA = await waitForFrame(subA, "changed", (d) => d.source === "a-edited");
    expect(frameA.data.source).toBe("a-edited");

    // Give any stray delivery a chance to land, then prove B stayed clean.
    await new Promise((r) => setTimeout(r, 60));
    expect(subB.body).not.toContain(
      encodeSourceB64(JSON.stringify({ slug: "level-a", source: "a-edited" })),
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
      expect(data.slug).toBe("level-b");
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
      expect(host.slugs.get("kiosk").subscribers.size).toBe(0);
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
