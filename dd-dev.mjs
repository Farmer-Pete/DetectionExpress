#!/usr/bin/env node
// dd-dev.mjs - the Detection Express local dev host.
//
// One zero-dependency file, Node and Bun built-ins only. It serves the packaged
// dev build over loopback, and manages the player's Algorithm files: create,
// watch, and open. Source flows to the browser over same-origin Server-Sent
// Events. See 12-PLAN.md, "The host".
//
// When run directly it binds a socket. When imported it opens nothing and
// exposes its seams, so tests drive them without a socket.

import { spawn as nodeSpawn } from "node:child_process";
import { watch as nodeWatch } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// --- Tuning constants -------------------------------------------------------

export const DEVHOST_DEFAULT_PORT = 4321;
export const DEVHOST_PORT_SPAN = 10;
export const DEVHOST_WATCH_DEBOUNCE_MS = 50;
export const DEVHOST_VERSION = "1.0.0";
export const ALGORITHMS_DIR = "./algorithms";
export const DEVHOST_MAX_SLUGS = 64;

const DEVHOST_KEEPALIVE_MS = 15_000;
const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;
const LOOPBACK = "127.0.0.1";

// The keepalive is an SSE comment line: a leading colon, then a blank line.
export const KEEPALIVE_COMMENT = ":\n\n";

// --- Small value helpers ----------------------------------------------------

/** True only for a primitive string, with no coercion of numbers or objects. */
function isString(value) {
  return String(value) === value;
}

/** A logical level name is valid iff it is a string matching the slug pattern. */
export function isValidSlug(name) {
  return isString(name) && SLUG_PATTERN.test(name);
}

/** An error that carries the HTTP status to report to the client. */
class HostError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// --- Base64 / SSE framing ---------------------------------------------------

/** Encode a UTF-8 string as base64, so any Unicode and any newline survive. */
export function encodeSourceB64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

/** Reverse of encodeSourceB64: base64 back to a UTF-8 string. */
export function decodeSourceB64(b64) {
  return Buffer.from(b64, "base64").toString("utf8");
}

/** A `changed` frame: base64 JSON of { slug, source }. */
export function changedFrame(slug, source) {
  const data = encodeSourceB64(JSON.stringify({ slug, source }));
  return `event: changed\ndata: ${data}\n\n`;
}

/** An `init` frame: base64 JSON of { slug, path, source }. */
export function initFrame(slug, filePath, source) {
  const data = encodeSourceB64(JSON.stringify({ slug, path: filePath, source }));
  return `event: init\ndata: ${data}\n\n`;
}

// --- MIME map (every Bun-emitted asset type) --------------------------------

const MIME_BY_EXT = new Map([
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".css", "text/css"],
  [".html", "text/html"],
  [".map", "application/json"],
  [".json", "application/json"],
  [".wasm", "application/wasm"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain"],
]);

/** The MIME type for a file extension, defaulting to a byte stream. */
export function mimeForExt(ext) {
  return MIME_BY_EXT.get(ext.toLowerCase()) ?? "application/octet-stream";
}

// --- Static path confinement ------------------------------------------------

/**
 * Resolve a URL path against the canonical build root and confirm containment.
 * Returns the absolute path, or null if the request escapes the root. Symlink
 * and non-regular checks happen at serve time against the filesystem.
 */
export function resolveStaticPath(buildRoot, decodedPathname) {
  const root = path.resolve(buildRoot);
  const resolved = path.resolve(root, `.${decodedPathname}`);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  return resolved;
}

// --- The OS "open in default handler" plan ----------------------------------

/**
 * Build the argv and extra env to open a path in the OS default handler.
 * Windows never touches cmd: it runs PowerShell's Start-Process and passes the
 * path in the DD_OPEN environment variable, never in the command string.
 */
export function buildOpenPlan(filePath, platform) {
  if (platform === "darwin") {
    return { command: "open", args: [filePath], env: {} };
  }
  if (platform === "win32") {
    return {
      command: "powershell",
      args: ["-NoProfile", "-Command", "Start-Process -FilePath $Env:DD_OPEN"],
      env: { DD_OPEN: filePath },
    };
  }
  return { command: "xdg-open", args: [filePath], env: {} };
}

/**
 * Open a path in the OS default handler. Spawns with shell:false and the path
 * as one argv entry. Never throws: a spawn failure is reported, not fatal.
 */
export function openInEditor(filePath, deps) {
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? nodeSpawn;
  const baseEnv = deps.env ?? process.env;
  const onError =
    deps.onError ?? ((reason) => console.error(`open failed: ${reason} (${filePath})`));
  const plan = buildOpenPlan(filePath, platform);
  try {
    const child = spawn(plan.command, plan.args, {
      shell: false,
      stdio: "ignore",
      env: { ...baseEnv, ...plan.env },
    });
    if (child?.on) {
      child.on("error", (err) => onError(err?.message ?? String(err)));
    }
    if (child?.unref) {
      child.unref();
    }
  } catch (err) {
    onError(err?.message ?? String(err));
  }
}

// --- Port walk --------------------------------------------------------------

/**
 * Try `base`, then walk up `span - 1` more ports on EADDRINUSE. A non-EADDRINUSE
 * failure aborts at once. Exhausting the inclusive range base..base+span-1
 * rejects with the last error. `listen(port)` resolves to a server or rejects.
 */
export async function listenWithPortWalk(listen, base, span) {
  let lastError;
  for (let offset = 0; offset < span; offset += 1) {
    const port = base + offset;
    try {
      const server = await listen(port);
      return { server, port };
    } catch (err) {
      lastError = err;
      if (err?.code !== "EADDRINUSE") {
        throw err;
      }
    }
  }
  throw lastError;
}

// --- Transition queue -------------------------------------------------------

/**
 * A per-slug serial queue. Each fn runs after the previous, whatever its
 * outcome, so one rejection never stalls the tail. The caller still sees the
 * real result or error of its own transition.
 */
export function createTransitionQueue() {
  let tail = Promise.resolve();
  const enqueueTransition = (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
  return { enqueueTransition };
}

// --- Misc -------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readWithRetry(filePath, attempts = 5, delayMs = 10) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await readFile(filePath, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT" || i === attempts - 1) {
        throw err;
      }
      await sleep(delayMs);
    }
  }
  throw new Error("unreachable");
}

// --- The host ---------------------------------------------------------------

/**
 * Build a dev host. All I/O boundaries are injectable, so tests drive the
 * handler and the seams without a socket. Returns the request handler, the
 * lifecycle controls, and read access to the per-slug state.
 */
export function createDevHost(config = {}) {
  const algorithmsDir = path.resolve(
    config.algorithmsDir ?? path.resolve(process.cwd(), ALGORITHMS_DIR),
  );
  const buildRoot = path.resolve(config.buildRoot ?? defaultBuildRoot());
  const spawn = config.spawn ?? nodeSpawn;
  const platform = config.platform ?? process.platform;
  const watch = config.watch ?? nodeWatch;
  const version = config.version ?? DEVHOST_VERSION;
  const maxSlugs = config.maxSlugs ?? DEVHOST_MAX_SLUGS;
  const debounceMs = config.debounceMs ?? DEVHOST_WATCH_DEBOUNCE_MS;
  const keepaliveMs = config.keepaliveMs ?? DEVHOST_KEEPALIVE_MS;
  const timers = config.timers ?? {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  const exit = config.exit ?? ((code) => process.exit(code));

  const state = {
    port: config.port ?? DEVHOST_DEFAULT_PORT,
    server: config.server ?? null,
    shuttingDown: false,
  };

  /** slug -> slug state. Each level is independent. */
  const slugs = new Map();

  function getState(slug, activate) {
    let entry = slugs.get(slug);
    if (!entry) {
      entry = {
        slug,
        active: false,
        path: null,
        cachedDefault: null,
        retained: { slug, path: null, source: null },
        subscribers: new Set(),
        watcher: null,
        debounceTimer: null,
        generation: 0,
        ...createTransitionQueue(),
      };
      slugs.set(slug, entry);
    }
    if (activate) {
      entry.active = true;
    }
    return entry;
  }

  function activeCount() {
    let count = 0;
    for (const entry of slugs.values()) {
      if (entry.active) {
        count += 1;
      }
    }
    return count;
  }

  function activeSlugs() {
    const list = [];
    for (const entry of slugs.values()) {
      if (entry.active) {
        list.push(entry.slug);
      }
    }
    return list;
  }

  function emit(entry, frame) {
    for (const record of entry.subscribers) {
      record.res.write(frame);
    }
  }

  // --- Same-origin guard ----------------------------------------------------

  function expectedHost() {
    return `${LOOPBACK}:${state.port}`;
  }

  function expectedOrigin() {
    return `http://${expectedHost()}`;
  }

  function passesOriginGuard(req) {
    const host = req.headers.host;
    if (host !== expectedHost()) {
      return false;
    }
    const origin = req.headers.origin;
    const isWrite = req.method === "POST";
    if (isWrite) {
      // A blind form POST omits or forges Origin; require the exact match.
      return origin === expectedOrigin();
    }
    // Read-only: a same-origin EventSource omits Origin, so allow missing.
    if (origin != null && origin !== expectedOrigin()) {
      return false;
    }
    // A top-level navigation (typing the URL, a bookmark) sends `none`; a same-origin
    // fetch/EventSource sends `same-origin`. Both are legitimate. Only a foreign
    // context (`cross-site`/`same-site`) is refused. Browsers forbid a page from
    // forging Sec-Fetch-Site, so this cannot be spoofed.
    const secFetchSite = req.headers["sec-fetch-site"];
    if (secFetchSite != null && secFetchSite !== "same-origin" && secFetchSite !== "none") {
      return false;
    }
    return true;
  }

  // --- Responses ------------------------------------------------------------

  function respondJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function respondText(res, status, text) {
    res.writeHead(status, {
      "Content-Type": "text/plain",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  // --- Watch ----------------------------------------------------------------

  function startWatch(entry) {
    if (entry.watcher) {
      return; // Created on first activation, kept even with no listeners.
    }
    const base = `detection-express-${entry.slug}.js`;
    entry.watcher = watch(algorithmsDir, (_eventType, filename) => {
      // A null filename is relevant; otherwise filter to our basename.
      if (filename != null && filename !== base) {
        return;
      }
      scheduleWatchTransition(entry);
    });
  }

  function scheduleWatchTransition(entry) {
    if (entry.debounceTimer) {
      timers.clearTimeout(entry.debounceTimer);
    }
    entry.debounceTimer = timers.setTimeout(() => {
      entry.debounceTimer = null;
      const captured = { slug: entry.slug, generation: entry.generation };
      entry.enqueueTransition(() => processWatchEvent(entry, captured));
    }, debounceMs);
  }

  async function processWatchEvent(entry, captured) {
    if (captured.generation !== entry.generation) {
      return; // A stale event for a superseded file does nothing.
    }
    const filePath = entry.path;
    if (filePath == null) {
      return;
    }
    let source = null;
    let missing = false;
    try {
      source = await readWithRetry(filePath);
    } catch (err) {
      if (err?.code === "ENOENT") {
        missing = true;
      } else {
        throw err;
      }
    }
    if (missing) {
      entry.retained = { slug: captured.slug, path: null, source: entry.cachedDefault };
      emit(entry, initFrame(captured.slug, null, entry.cachedDefault));
    } else {
      entry.retained = { slug: captured.slug, path: filePath, source };
      emit(entry, changedFrame(captured.slug, source));
    }
  }

  // --- POST /api/algorithm --------------------------------------------------

  async function activate(entry, defaultSource) {
    const fileName = `detection-express-${entry.slug}.js`;
    const filePath = path.resolve(algorithmsDir, fileName);
    // Defense in depth: the built name must land directly under the root.
    if (path.dirname(filePath) !== algorithmsDir) {
      throw new HostError(400, "resolved path escapes the algorithms directory");
    }
    await mkdir(algorithmsDir, { recursive: true });

    entry.generation += 1;
    entry.cachedDefault = defaultSource;

    let existed;
    try {
      await writeFile(filePath, defaultSource, { flag: "wx" });
      existed = false;
    } catch (err) {
      if (err?.code === "EEXIST") {
        existed = true;
      } else {
        throw err;
      }
    }

    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new HostError(403, "refusing a symlink or non-regular target");
    }

    entry.path = filePath;
    const source = await readFile(filePath, "utf8");
    entry.retained = { slug: entry.slug, path: filePath, source };
    emit(entry, initFrame(entry.slug, filePath, source));

    startWatch(entry);
    openInEditor(filePath, { spawn, platform });

    return { path: filePath, existed };
  }

  async function handlePost(req, res) {
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      respondText(res, err?.status ?? 400, err?.message ?? "bad request");
      return;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      respondText(res, 400, "invalid JSON body");
      return;
    }
    const name = body?.name;
    if (!isValidSlug(name)) {
      respondText(res, 400, "invalid name");
      return;
    }
    const defaultSource = isString(body?.defaultSource) ? body.defaultSource : "";

    const existing = slugs.get(name);
    const alreadyActive = existing?.active === true;
    if (!alreadyActive && activeCount() >= maxSlugs) {
      respondText(res, 503, `too many active levels (max ${maxSlugs})`);
      return;
    }

    const entry = getState(name, true);
    try {
      const result = await entry.enqueueTransition(() => activate(entry, defaultSource));
      respondJson(res, 200, result);
    } catch (err) {
      respondText(res, err?.status ?? 500, err?.message ?? "activation failed");
    }
  }

  // --- GET /api/algorithm/events (SSE) --------------------------------------

  function handleEvents(res, url) {
    const slugValues = url.searchParams.getAll("slug");
    if (slugValues.length !== 1 || !isValidSlug(slugValues[0])) {
      respondText(res, 400, "exactly one valid ?slug is required");
      return;
    }
    const slug = slugValues[0];
    const entry = getState(slug, false);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send the retained snapshot so a reconnect never misses a state change.
    const snap = entry.retained;
    res.write(initFrame(snap.slug, snap.path, snap.source));

    const keepalive = timers.setInterval(() => res.write(KEEPALIVE_COMMENT), keepaliveMs);
    const record = { res, keepalive };
    entry.subscribers.add(record);

    const cleanup = () => {
      entry.subscribers.delete(record);
      timers.clearInterval(keepalive);
    };
    res.on("close", cleanup);
  }

  // --- Static serving -------------------------------------------------------

  async function serveFile(res, filePath, method) {
    let stats;
    try {
      stats = await lstat(filePath);
    } catch {
      return false; // Missing: let the caller fall back to index.html.
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      respondText(res, 403, "forbidden");
      return true;
    }
    const mime = mimeForExt(path.extname(filePath));
    if (method === "HEAD") {
      res.writeHead(200, { "Content-Type": mime, "Content-Length": stats.size });
      res.end();
      return true;
    }
    const bytes = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mime, "Content-Length": bytes.length });
    res.end(bytes);
    return true;
  }

  async function serveIndex(res, method) {
    const indexPath = path.resolve(buildRoot, "index.html");
    const served = await serveFile(res, indexPath, method);
    if (!served) {
      respondText(res, 404, "not found");
    }
  }

  async function handleStatic(req, res, url) {
    const method = req.method;
    if (method !== "GET" && method !== "HEAD") {
      respondText(res, 405, "method not allowed");
      return;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      respondText(res, 400, "bad path");
      return;
    }
    // Map "/" and any directory or extension-less client route to index.html,
    // before the regular-file check.
    if (path.extname(decoded) === "") {
      await serveIndex(res, method);
      return;
    }
    const resolved = resolveStaticPath(buildRoot, decoded);
    if (resolved == null) {
      respondText(res, 403, "forbidden");
      return;
    }
    const served = await serveFile(res, resolved, method);
    if (!served) {
      // A missing asset falls back to index.html.
      await serveIndex(res, method);
    }
  }

  // --- Routing --------------------------------------------------------------

  async function handleRequest(req, res) {
    try {
      const url = new URL(req.url, expectedOrigin());
      if (!passesOriginGuard(req)) {
        respondText(res, 403, "forbidden");
        return;
      }
      const pathname = url.pathname;
      if (pathname.startsWith("/api/")) {
        if (pathname === "/api/health" && req.method === "GET") {
          respondJson(res, 200, {
            app: "detection-express-devhost",
            version,
            activeSlugs: activeSlugs(),
          });
          return;
        }
        if (pathname === "/api/algorithm/events" && req.method === "GET") {
          handleEvents(res, url);
          return;
        }
        if (pathname === "/api/algorithm" && req.method === "POST") {
          await handlePost(req, res);
          return;
        }
        respondText(res, 404, "not found");
        return;
      }
      await handleStatic(req, res, url);
    } catch (err) {
      respondText(res, err?.status ?? 500, err?.message ?? "internal error");
    }
  }

  // --- Lifecycle ------------------------------------------------------------

  function setPort(port) {
    state.port = port;
  }

  function setServer(server) {
    state.server = server;
  }

  function shutdown() {
    if (state.shuttingDown) {
      return; // Idempotent: later signals are ignored.
    }
    state.shuttingDown = true;

    const fallback = timers.setTimeout(() => exit(0), 2000);
    const finish = () => {
      timers.clearTimeout(fallback);
      exit(0);
    };

    if (state.server) {
      state.server.close(finish);
    }

    for (const entry of slugs.values()) {
      if (entry.watcher) {
        entry.watcher.close();
        entry.watcher = null;
      }
      if (entry.debounceTimer) {
        timers.clearTimeout(entry.debounceTimer);
        entry.debounceTimer = null;
      }
      for (const record of entry.subscribers) {
        timers.clearInterval(record.keepalive);
        record.res.end();
      }
      entry.subscribers.clear();
    }

    if (!state.server) {
      finish();
    }
  }

  return {
    handleRequest,
    listenWithPortWalk,
    openInEditor,
    activeSlugs,
    setPort,
    setServer,
    shutdown,
    slugs,
    algorithmsDir,
    buildRoot,
  };
}

// --- Request body -----------------------------------------------------------

async function readBody(req, limit = 1_000_000) {
  let size = 0;
  const parts = [];
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) {
      throw new HostError(413, "request body too large");
    }
    parts.push(buf);
  }
  return Buffer.concat(parts).toString("utf8");
}

// --- Default build root -----------------------------------------------------

function defaultBuildRoot() {
  // The published package carries the dev build next to this file, so resolve
  // assets relative to the module, never the working directory.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "dist-devkit");
}

// --- Real listen wrapper ----------------------------------------------------

function realListen(handler) {
  return (port) =>
    new Promise((resolve, reject) => {
      const server = createServer(handler);
      const onError = (err) => reject(err);
      server.once("error", onError);
      server.listen(port, LOOPBACK, () => {
        server.off("error", onError);
        resolve(server);
      });
    });
}

// --- Entrypoint -------------------------------------------------------------

async function main() {
  const host = createDevHost({});
  const { server, port } = await listenWithPortWalk(
    realListen((req, res) => host.handleRequest(req, res)),
    DEVHOST_DEFAULT_PORT,
    DEVHOST_PORT_SPAN,
  );
  host.setPort(port);
  host.setServer(server);
  console.log(`Detection Express dev host running at http://${LOOPBACK}:${port}`);
  process.on("SIGINT", () => host.shutdown());
  process.on("SIGTERM", () => host.shutdown());
}

// Portable entry check: start only when run directly. import.meta.main is Node
// v22.18+, so compare argv[1]'s file URL to this module's URL instead.
const runDirectly =
  process.argv[1] != null && pathToFileURL(process.argv[1]).href === import.meta.url;
if (runDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
