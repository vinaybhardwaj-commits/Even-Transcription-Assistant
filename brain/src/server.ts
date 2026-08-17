/**
 * brain/src/server.ts — Even Scribe Ambient Encounter Brain (skeleton).
 *
 * PRD build-order step 1 (§12): Cloud Run, POST /cues records evidence and
 * echoes the graph, GET /rooms/:room_id/state reads Neon, /health probes.
 * No Gemini, no Pulse, no Mini, no warehouse, no audio. Plain node:http.
 *
 * Routes
 *   GET  /health                    → { ok, now, db:{ ok, latency_ms } }     (no auth)
 *   POST /cues                      → { ok, cue_id, state }                  (bearer)
 *   GET  /rooms/:room_id/state      → { ok, state }                          (bearer)
 *        ?ist_date=YYYY-MM-DD       read a specific IST day (default: today IST)
 *
 * Auth: Authorization: Bearer <BRAIN_SERVICE_TOKEN> (env var NAME; V sets the
 * value). Constant-time compare via SHA-256 digests + timingSafeEqual so a
 * length mismatch does not short-circuit. Missing env → 503, fail closed.
 *
 * Errors: every failure becomes a JSON { ok:false, error } response. The
 * process never exits on a request error; unhandledRejection/uncaughtException
 * are logged and swallowed. SIGTERM drains and closes the pool.
 */

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { probe, closePool, getPool } from "./db.js";
import { withRoomDayLock } from "./lock.js";
import { findRoomDay, insertCue, isIstDateString, istDate, readGraph, resolveRoomDay, roomExists } from "./state.js";

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN_ENV = "BRAIN_SERVICE_TOKEN";
const MAX_BODY_BYTES = 1_000_000; // 1 MB — cues are small; transcript turns are text
const MAX_ID_LEN = 128;
const MAX_TYPE_LEN = 64;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function log(lvl: "info" | "warn" | "error", msg: string, extra: Json = {}): void {
  // One JSON line per event; Cloud Logging parses it. Never log request bodies
  // (cue payloads carry room transcript text — PRD §15A).
  const line = JSON.stringify({ at: new Date().toISOString(), lvl, msg, ...extra });
  if (lvl === "error") console.error(line);
  else console.log(line);
}

function sendJson(res: http.ServerResponse, status: number, body: Json): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buf.length,
    "cache-control": "no-store",
  });
  res.end(buf);
}

function fail(res: http.ServerResponse, status: number, error: string, extra: Json = {}): void {
  sendJson(res, status, { ok: false, error, ...extra });
}

class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

/** Read the request body as UTF-8, capped at MAX_BODY_BYTES. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (e) => reject(e));
  });
}

/** Constant-time bearer check. Returns null when authorized, else an HttpError. */
function checkAuth(req: http.IncomingMessage): HttpError | null {
  const expected = process.env[TOKEN_ENV];
  if (!expected) return new HttpError(503, "service_token_not_configured");
  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return new HttpError(401, "unauthorized");
  const a = createHash("sha256").update(m[1]!).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) ? null : new HttpError(401, "unauthorized");
}

function parseAt(v: unknown): Date {
  if (v === undefined || v === null || v === "") return new Date();
  const d = typeof v === "number" ? new Date(v) : typeof v === "string" ? new Date(v) : new Date(NaN);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, "invalid_at");
  return d;
}

function requireIdString(v: unknown, code: string, max: number): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new HttpError(400, code);
  return v;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleHealth(res: http.ServerResponse): Promise<void> {
  const db = await probe();
  // 200 either way: this is liveness for Cloud Run; `ok` carries the truth.
  sendJson(res, 200, { ok: db.ok, now: new Date().toISOString(), db, service: "even-scribe-brain", version: process.env.K_REVISION ?? null });
}

/**
 * POST /cues { room_id, type, at?, payload? }
 * resolve-or-create today's room_day (IST) → advisory lock → insert cue → echo graph.
 */
async function handlePostCue(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = raw.length ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "invalid_body");
  const b = body as Json;

  const roomId = requireIdString(b.room_id, "room_id_required", MAX_ID_LEN);
  const type = requireIdString(b.type, "type_required", MAX_TYPE_LEN);
  const at = parseAt(b.at);
  const payload = b.payload; // any JSON; undefined → SQL NULL

  if (!(await roomExists(roomId))) throw new HttpError(404, "unknown_room");

  // "Today" is the server's IST date (Asia/Kolkata), not the cue's `at`.
  const date = istDate();
  const day = await resolveRoomDay(roomId, date);

  const out = await withRoomDayLock(day.id, async (client) => {
    const cue = await insertCue(client, day.id, { type, at, payload });
    const state = await readGraph(client, roomId, date, day.id);
    return { cue, state };
  });

  sendJson(res, 200, { ok: true, cue_id: out.cue.id, cue_at: out.cue.at, state: out.state });
}

/** GET /rooms/:room_id/state[?ist_date=YYYY-MM-DD] — read-only, never creates. */
async function handleGetState(res: http.ServerResponse, roomId: string, url: URL): Promise<void> {
  const qd = url.searchParams.get("ist_date");
  if (qd !== null && !isIstDateString(qd)) throw new HttpError(400, "invalid_ist_date");
  const date = qd ?? istDate();
  if (!(await roomExists(roomId))) throw new HttpError(404, "unknown_room");
  const day = await findRoomDay(roomId, date);
  const state = await readGraph(getPool(), roomId, date, day?.id ?? null);
  sendJson(res, 200, { ok: true, state });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const STATE_RE = /^\/rooms\/([^/]+)\/state\/?$/;

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();

  if (path === "/health" || path === "/health/") {
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method_not_allowed");
    return handleHealth(res);
  }

  // Everything below requires the service token.
  const authErr = checkAuth(req);
  if (authErr) throw authErr;

  if (path === "/cues" || path === "/cues/") {
    if (method !== "POST") throw new HttpError(405, "method_not_allowed");
    return handlePostCue(req, res);
  }

  const m = STATE_RE.exec(path);
  if (m) {
    if (method !== "GET") throw new HttpError(405, "method_not_allowed");
    let roomId: string;
    try {
      roomId = decodeURIComponent(m[1]!);
    } catch {
      throw new HttpError(400, "invalid_room_id");
    }
    if (roomId.length > MAX_ID_LEN) throw new HttpError(400, "invalid_room_id");
    return handleGetState(res, roomId, url);
  }

  throw new HttpError(404, "not_found");
}

const server = http.createServer((req, res) => {
  const t0 = Date.now();
  const method = req.method ?? "GET";
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  route(req, res)
    .catch((e: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof HttpError) {
        fail(res, e.status, e.code);
        return;
      }
      // pg errors surface here: FK violations, timeouts, connection failures.
      const err = e as { code?: string; message?: string };
      const pgCode = typeof err?.code === "string" ? err.code : undefined;
      if (pgCode === "23503") {
        // FK — most likely room_id vanished between check and insert.
        fail(res, 404, "unknown_room");
        return;
      }
      if (pgCode === "42P01") {
        // undefined_table — migration 0042 not applied yet.
        fail(res, 503, "brain_tables_missing", { hint: "run migration 0042 via /api/run-migrations" });
        return;
      }
      log("error", "request_failed", { method, path, code: pgCode ?? null, err: String(err?.message ?? e) });
      fail(res, 500, "internal_error");
    })
    .finally(() => {
      log("info", "req", { method, path, status: res.statusCode, ms: Date.now() - t0 });
    });
});

server.keepAliveTimeout = 65_000; // > Cloud Run's 60s idle to avoid races
server.headersTimeout = 66_000;

server.on("error", (e) => log("error", "server_error", { err: String(e) }));

process.on("unhandledRejection", (r) => log("error", "unhandledRejection", { err: String((r as Error)?.message ?? r) }));
process.on("uncaughtException", (e) => log("error", "uncaughtException", { err: String(e?.message ?? e) }));

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutdown", { signal });
  server.close(() => {
    closePool().finally(() => process.exit(0));
  });
  // Cloud Run gives ~10s after SIGTERM; don't hang on stuck sockets.
  setTimeout(() => process.exit(0), 8_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, "0.0.0.0", () => {
  log("info", "listening", { port: PORT, token_env_set: Boolean(process.env[TOKEN_ENV]), db_env_set: Boolean(process.env.BRAIN_DATABASE_URL) });
});
