#!/usr/bin/env node
// dd-dev.mjs - the Detection Express local dev host.
//
// One zero-dependency file, Node built-ins only. It serves the packaged
// dev build over loopback, and manages the player's Algorithm files: create,
// watch, and open. Source flows to the browser over same-origin Server-Sent
// Events. See 12-PLAN.md, "The host".
//
// When run directly it binds a socket. When imported it opens nothing and
// exposes its seams, so tests drive them without a socket.

import { spawn as nodeSpawn } from "node:child_process";
import { watch as nodeWatch, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- Tuning constants -------------------------------------------------------

export const DEVHOST_DEFAULT_PORT = 4321;
export const DEVHOST_PORT_SPAN = 10;
export const DEVHOST_WATCH_DEBOUNCE_MS = 50;
export const DEVHOST_VERSION = "1.0.0";
export const ALGORITHMS_DIR = "./algorithms";
export const DEVHOST_MAX_SLUGS = 64;

const DEVHOST_KEEPALIVE_MS = 15_000;
const DEVHOST_BODY_LIMIT_BYTES = 1_000_000;
const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;
const LOOPBACK = "127.0.0.1";

// The keepalive is an SSE comment line: a leading colon, then a blank line.
export const KEEPALIVE_COMMENT = ":\n\n";

// --- Small value helpers ----------------------------------------------------

/** True only for a primitive string, with no coercion of numbers or objects. */
function isString(value) {
  return String(value) === value;
}

/** A scenario name is valid iff it is a string matching the slug pattern. */
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

// --- MIME map (every Vite-emitted asset type) -------------------------------

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
      // A spawn that launches but then exits nonzero (e.g. a headless xdg-open
      // with no handler) never emits "error"; catch the failing exit too.
      child.on("exit", (code) => {
        if (code != null && code !== 0) {
          onError(`opener exited with code ${code} (${filePath})`);
        }
      });
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
  const version = config.version ?? readPackageVersion();
  const maxSlugs = config.maxSlugs ?? DEVHOST_MAX_SLUGS;
  const debounceMs = config.debounceMs ?? DEVHOST_WATCH_DEBOUNCE_MS;
  const keepaliveMs = config.keepaliveMs ?? DEVHOST_KEEPALIVE_MS;
  const bodyLimit = config.bodyLimit ?? DEVHOST_BODY_LIMIT_BYTES;
  const readSource = config.readSource ?? ((filePath) => readWithRetry(filePath));
  // The static-asset read boundary, injectable like every other I/O seam so a test
  // can observe exactly which path is read (see the F6 canonical-read test).
  const readAsset = config.readAsset ?? ((filePath) => readFile(filePath));
  const onWatchError =
    config.onWatchError ?? ((err) => console.error(`watch error: ${err?.message ?? err}`));
  const onReadError =
    config.onReadError ??
    ((err, slug) => console.error(`watch read failed for ${slug}: ${err?.message ?? err}`));
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

  /** slug -> slug state. Each scenario is independent. */
  const slugs = new Map();

  // Get or create the state for a slug. Creation never marks a scenario active:
  // that happens only after activate() succeeds, so a failed activation cannot
  // leak a slot against the cap.
  function getState(slug) {
    let entry = slugs.get(slug);
    if (!entry) {
      entry = {
        slug,
        active: false,
        // A slot reserved synchronously at POST admission, before activate() awaits,
        // so two concurrent distinct-slug POSTs cannot both pass the cap check (F5).
        // Counts toward the cap like `active`; released on activation failure.
        reserved: false,
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
    return entry;
  }

  // Drop a slug's state when nothing is holding it: no live stream, not active,
  // and no watcher or cached state to preserve. Keeps the events path bounded.
  function maybeReap(entry) {
    if (
      entry.subscribers.size === 0 &&
      !entry.active &&
      !entry.reserved &&
      entry.watcher == null &&
      entry.cachedDefault == null
    ) {
      slugs.delete(entry.slug);
    }
  }

  // The cap counts both live scenarios and slots reserved by an in-flight POST, so
  // a reservation held across activate()'s await blocks a concurrent over-cap POST.
  function activeCount() {
    let count = 0;
    for (const entry of slugs.values()) {
      if (entry.active || entry.reserved) {
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
    // Copy first: a failing write drops the dead subscriber mid-iteration.
    for (const record of [...entry.subscribers]) {
      try {
        record.res.write(frame);
      } catch {
        // A dead socket rejects the write. Drop it and keep serving the rest.
        entry.subscribers.delete(record);
        timers.clearInterval(record.keepalive);
      }
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

  // A HostError carries a status and a message meant for the client, so relay it
  // verbatim. Any other error is unexpected: its message may embed absolute
  // local paths (Node fs errors do), so answer 500 with a generic message.
  function respondError(res, err) {
    if (err instanceof HostError) {
      respondText(res, err.status, err.message);
      return;
    }
    respondText(res, 500, "internal error");
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
    // A FSWatcher error is emitted as an "error" event; with no listener Node
    // would throw it as an uncaught exception and crash the host. Log it and
    // keep serving; the retained snapshot still covers reconnecting clients.
    if (entry.watcher?.on) {
      entry.watcher.on("error", (err) => onWatchError(err));
    }
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
      // Re-apply the symlink / non-regular guard on every re-read: a file
      // swapped for a symlink must never be read and broadcast to the browser.
      const stats = await lstat(filePath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        onReadError(
          new HostError(403, "watched target is a symlink or non-regular"),
          captured.slug,
        );
        return; // Do not read or broadcast the foreign target.
      }
      // F7 (accepted): the gap between this lstat and the read below is a residual
      // symlink TOCTOU. Closing it would need O_NOFOLLOW; instead it is accepted for
      // the loopback single-user threat model (it requires local write access to
      // ./algorithms/ to win the race), so this is deliberate, not an oversight.
      source = await readSource(filePath);
    } catch (err) {
      if (err?.code === "ENOENT") {
        missing = true;
      } else {
        // A non-ENOENT failure (e.g. EACCES) is surfaced, not silently dropped,
        // so a stuck stream does not look "connected but frozen".
        onReadError(err, captured.slug);
        return;
      }
    }
    if (missing) {
      // The file is gone: revert to the cached default and release the lock so
      // /api/health drops the scenario and a later POST re-locks with an init.
      entry.active = false;
      entry.path = null;
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

    // F7 (accepted): reading the file right after the lstat guard is a residual
    // symlink TOCTOU. It requires local write access to ./algorithms/ between the
    // two calls, so it is a deliberate choice for the loopback single-user threat
    // model, not an oversight. No O_NOFOLLOW is used.
    const source = await readFile(filePath, "utf8");

    // Commit transient activation state only after every fallible step above has
    // succeeded. A rejection (symlink guard, EACCES read, ...) then leaves
    // cachedDefault null and the entry reapable, so a failed activation cannot
    // wedge a dead entry that maybeReap refuses to collect (F1).
    entry.generation += 1;
    entry.cachedDefault = defaultSource;
    entry.path = filePath;
    entry.retained = { slug: entry.slug, path: filePath, source };
    emit(entry, initFrame(entry.slug, filePath, source));

    startWatch(entry);
    openInEditor(filePath, { spawn, platform });

    return { path: filePath, existed };
  }

  async function handlePost(req, res) {
    let raw;
    try {
      raw = await readBody(req, bodyLimit);
    } catch (err) {
      // Write the response first, then stop reading. For an oversized body the 413
      // must reach the client before the request is destroyed: destroying tears down
      // the socket, so a destroy-before-respond loses the 413 entirely (F2).
      respondError(res, err);
      if (err instanceof HostError && err.status === 413) {
        req.destroy?.();
      }
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
    if (!isString(body?.defaultSource)) {
      respondText(res, 400, "defaultSource must be a string");
      return;
    }
    const defaultSource = body.defaultSource;

    const existing = slugs.get(name);
    // A slug already holding a slot (active, or reserved by another in-flight POST)
    // is re-admitted past the cap; only a genuinely new slot is capped.
    const alreadyCounts = existing != null && (existing.active || existing.reserved);
    if (!alreadyCounts && activeCount() >= maxSlugs) {
      respondText(res, 503, `too many active scenarios (max ${maxSlugs})`);
      return;
    }

    const entry = getState(name);
    // Reserve the slot synchronously, before activate() awaits, so a concurrent
    // distinct-slug POST sees this slot counted and is refused past the cap (F5).
    const reservedByUs = !entry.active && !entry.reserved;
    if (reservedByUs) {
      entry.reserved = true;
    }
    try {
      const result = await entry.enqueueTransition(() => activate(entry, defaultSource));
      entry.active = true; // Lock the slot only after activate() succeeds.
      entry.reserved = false; // Reservation graduates to an active slot.
      respondJson(res, 200, result);
    } catch (err) {
      // Release our reservation so a failed activation never leaks a slot (F5).
      if (reservedByUs) {
        entry.reserved = false;
      }
      // Reap the entry when nothing else holds it. This covers both a
      // POST-created entry and one an SSE created that has since closed (its own
      // maybeReap was skipped while we held the reservation).
      maybeReap(entry);
      respondError(res, err);
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
    // Bound the events path too: a flood of distinct never-seen slugs must not
    // grow the map without limit. A slug already tracked is always admitted.
    if (!slugs.has(slug) && slugs.size >= maxSlugs) {
      respondText(res, 503, `too many active scenarios (max ${maxSlugs})`);
      return;
    }
    const entry = getState(slug);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const snap = entry.retained;
    const record = { res, keepalive: null };

    const dropSubscriber = () => {
      entry.subscribers.delete(record);
      if (record.keepalive != null) {
        timers.clearInterval(record.keepalive);
        record.keepalive = null;
      }
    };
    const cleanup = () => {
      dropSubscriber();
      // Reap a never-activated slug once its last stream closes, so distinct
      // open/close churn on the events path cannot leak entries.
      maybeReap(entry);
    };

    // The keepalive write is guarded exactly like emit(): a dead socket drops the
    // subscriber instead of letting the throw escape the interval callback.
    record.keepalive = timers.setInterval(() => {
      try {
        res.write(KEEPALIVE_COMMENT);
      } catch {
        cleanup();
      }
    }, keepaliveMs);
    entry.subscribers.add(record);

    // Send the retained snapshot so a reconnect never misses a state change. Guard
    // this initial write the same way: a socket already dead between the headers and
    // this frame drops the subscriber (and clears its keepalive) rather than throwing.
    try {
      res.write(initFrame(snap.slug, snap.path, snap.source));
    } catch {
      cleanup();
    }

    res.on("close", cleanup);
    // A socket error also ends the stream; without this listener the emitted
    // error would go unhandled and its resources would leak until exit.
    res.on("error", cleanup);
  }

  // --- Static serving -------------------------------------------------------

  // The build root with every symlink resolved, memoized. Confinement compares
  // realpath'd targets against this, so a symlinked temp root (e.g. macOS
  // /var -> /private/var) does not falsely reject its own assets.
  let canonicalBuildRoot = null;
  async function canonicalRoot() {
    if (canonicalBuildRoot == null) {
      try {
        canonicalBuildRoot = await realpath(buildRoot);
      } catch {
        canonicalBuildRoot = buildRoot;
      }
    }
    return canonicalBuildRoot;
  }

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
    // Confinement in depth: an intermediate symlinked directory can escape the
    // root even when the final component is a regular file. Resolve the real
    // path and confirm it still lives under the canonical build root.
    const root = await canonicalRoot();
    let real;
    try {
      real = await realpath(filePath);
    } catch {
      return false; // Vanished between lstat and realpath: treat as missing.
    }
    if (real !== root && !real.startsWith(root + path.sep)) {
      respondText(res, 403, "forbidden");
      return true;
    }
    const mime = mimeForExt(path.extname(filePath));
    if (method === "HEAD") {
      res.writeHead(200, { "Content-Type": mime, "Content-Length": stats.size });
      res.end();
      return true;
    }
    // Read the validated canonical path, not the original request path: an
    // intermediate directory swapped for a symlink after the realpath check would
    // otherwise let a read of `filePath` escape the confined root (F6).
    const bytes = await readAsset(real);
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
      // Give the same generic-message treatment used everywhere else: a HostError's
      // message is client-safe and passes through, but any other error (e.g. a raw
      // fs EACCES from a static read) may embed absolute local paths, so it becomes a
      // generic 500 with no path leaked (F3).
      respondError(res, err);
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

function readBody(req, limit = DEVHOST_BODY_LIMIT_BYTES) {
  // Event-based, not `for await`: throwing out of a `for await` loop invokes the
  // async iterator's return(), which destroys the request stream before the caller
  // can write the 413. Here an overflow only pauses the stream and rejects; the
  // caller writes the 413 and then destroys, so the client actually receives it (F2).
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const parts = [];
    const cleanup = () => {
      req.off?.("data", onData);
      req.off?.("end", onEnd);
      req.off?.("error", onError);
    };
    const onData = (chunk) => {
      if (settled) {
        return;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > limit) {
        settled = true;
        cleanup();
        // Stop consuming without killing the socket: the caller responds first.
        req.pause?.();
        reject(new HostError(413, "request body too large"));
        return;
      }
      parts.push(buf);
    };
    const onEnd = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(parts).toString("utf8"));
    };
    const onError = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

// --- Default build root -----------------------------------------------------

function defaultBuildRoot() {
  // The published package carries the dev build next to this file, so resolve
  // assets relative to the module, never the working directory.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "dist-devkit");
}

// --- Package version --------------------------------------------------------

/**
 * The package version, read from the package.json beside this bin at runtime so
 * /api/health reports the real published version. Falls back to the constant if
 * the file is missing or unreadable.
 */
function readPackageVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.resolve(here, "package.json"), "utf8"));
    return isString(pkg?.version) ? pkg.version : DEVHOST_VERSION;
  } catch {
    return DEVHOST_VERSION;
  }
}

// --- Direct-run detection ---------------------------------------------------

/**
 * True when this module is the program entrypoint. Resolves real paths on both
 * sides before comparing, so a bin symlink (pnpm dlx, an npm bin shim) still matches the
 * module it points at. Robust to realpath throwing on a vanished path.
 */
export function isRunDirectly(argv1, moduleUrl, realpath = realpathSync) {
  if (argv1 == null) {
    return false;
  }
  const resolve = (p) => {
    try {
      return realpath(p);
    } catch {
      return path.resolve(p);
    }
  };
  return resolve(argv1) === resolve(fileURLToPath(moduleUrl));
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
// v22.18+, so compare real paths instead (see isRunDirectly).
if (isRunDirectly(process.argv[1], import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
