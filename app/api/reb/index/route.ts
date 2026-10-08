/**
 * /api/reb/index — the Neon index of the REB palimpsest's R2 track store (reb_track_index, migration 0135; REB-SPEC v2.3 section 4).
 *
 * POST  Authorization: Bearer ${REB_INDEX_TOKEN} (constant-time; 401 wrong/missing; 503 when REB_INDEX_TOKEN is unset).
 *       Body: one row object or an array of 1..500 rows. Row fields: window_id, ist_date (YYYY-MM-DD), room_id, layer, engine, version,
 *       config_hash, status (ok|empty|failed|skipped), r2_key, sha256 (64 hex) required; t0_ms, t1_ms, bytes (integers), model, reason, machine,
 *       started_at, finished_at (ISO 8601 with zone), shadow (boolean, default false) optional. A bad row -> 400 naming the row index; nothing is written.
 *       INSERT ... ON CONFLICT (window_id, layer, engine, version, config_hash, shadow) DO NOTHING. A row that hits the key is "existing" when the
 *       stored sha256 equals the sent one, a conflict when it differs (the stored row is never changed).
 *       -> { ok, inserted, existing, conflicts: [{ key, stored_sha, sent_sha }] }; HTTP 409 when conflicts is non-empty (inserted rows stand).
 * GET   Authorization: Bearer ${REB_INDEX_READ_TOKEN} or ${REB_INDEX_TOKEN} (same 401/503 rule: 503 only when neither is set).
 *       Query: window_id | ist_date (one required), optional layer, engine, room_id; shadow rows are excluded unless shadow=1;
 *       keyset pagination by id: limit (default 1000, max 5000), cursor (the previous next_cursor). -> { ok, count, rows, next_cursor }.
 * Bound parameters only. No patient identifiers: ids, engine names, R2 keys and hashes.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { headers: { "cache-control": "no-store" } };
const MAX_ROWS = 500;
const STATUSES = ["ok", "empty", "failed", "skipped"];
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, ...NO_STORE });
const bad = (message: string) => json({ error: { code: "VALIDATION_FAILED", message } }, 400);

/** YYYY-MM-DD naming a real calendar day (no rollover: 2026-02-30 and 2026-13-01 are not dates). */
const isDay = (d: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`).getTime();
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
};

/** ISO 8601 date-time with an explicit zone (what Postgres timestamptz accepts unambiguously); JS Date alone also takes "1". */
const ISO_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}(:?\d{2})?)$/;

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** 200-path guard: null = allowed; else the refusal. Unset/blank tokens never match; none configured at all -> 503. */
function authorize(req: NextRequest, tokenNames: string[]): NextResponse | null {
  const expected = tokenNames.map((n) => (process.env[n] ?? "").trim()).filter((t) => t !== "");
  if (expected.length === 0) return json({ error: { code: "NOT_CONFIGURED", message: "index token not configured" } }, 503);
  const header = req.headers.get("authorization") || "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const a = digest(presented);
  let ok = false;
  for (const t of expected) if (timingSafeEqual(a, digest(t)) && presented !== "") ok = true; // no early exit: every candidate is compared
  return ok ? null : json({ error: { code: "UNAUTHORIZED", message: "token required" } }, 401);
}

type Row = {
  window_id: string; ist_date: string; room_id: string; t0_ms: number | null; t1_ms: number | null; layer: string; engine: string;
  model: string | null; version: string; config_hash: string; shadow: boolean; status: string; reason: string | null; machine: string | null;
  r2_key: string; sha256: string; bytes: number | null; started_at: string | null; finished_at: string | null;
};

const REQUIRED_TEXT = ["window_id", "room_id", "layer", "engine", "version", "config_hash", "r2_key"] as const;
const OPTIONAL_TEXT = ["model", "reason", "machine"] as const;
const OPTIONAL_INT = ["t0_ms", "t1_ms", "bytes"] as const;
const OPTIONAL_TS = ["started_at", "finished_at"] as const;

/** A validated Row, or the reason it is not. */
function parseRow(raw: unknown): Row | string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "row must be an object";
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of REQUIRED_TEXT) {
    const v = r[k];
    if (typeof v !== "string" || v.trim() === "") return `${k} must be a non-empty string`;
    out[k] = v;
  }
  for (const k of OPTIONAL_TEXT) {
    const v = r[k];
    if (v === undefined || v === null) out[k] = null;
    else if (typeof v === "string") out[k] = v;
    else return `${k} must be a string or null`;
  }
  for (const k of OPTIONAL_INT) {
    const v = r[k];
    if (v === undefined || v === null) out[k] = null;
    else if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out[k] = v;
    else return `${k} must be a non-negative integer or null`;
  }
  for (const k of OPTIONAL_TS) {
    const v = r[k];
    if (v === undefined || v === null) out[k] = null;
    else if (typeof v === "string" && ISO_TS.test(v) && !Number.isNaN(new Date(v).getTime())) out[k] = v;
    else return `${k} must be an ISO timestamp or null`;
  }
  const d = r.ist_date;
  if (typeof d !== "string" || !isDay(d)) return "ist_date must be a valid YYYY-MM-DD date";
  out.ist_date = d;
  if (typeof r.status !== "string" || !STATUSES.includes(r.status)) return `status must be one of ${STATUSES.join("|")}`;
  out.status = r.status;
  if (typeof r.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(r.sha256)) return "sha256 must be 64 hex characters";
  out.sha256 = r.sha256;
  if (r.shadow === undefined || r.shadow === null) out.shadow = false;
  else if (typeof r.shadow === "boolean") out.shadow = r.shadow;
  else return "shadow must be a boolean";
  return out as Row;
}

const keyOf = (r: { window_id: string; layer: string; engine: string; version: string; config_hash: string; shadow: boolean }) =>
  JSON.stringify([r.window_id, r.layer, r.engine, r.version, r.config_hash, r.shadow]);

export async function POST(req: NextRequest) {
  const denied = authorize(req, ["REB_INDEX_TOKEN"]);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("body is not valid JSON");
  }
  const list = Array.isArray(body) ? body : [body];
  if (list.length === 0) return bad("no rows");
  if (list.length > MAX_ROWS) return bad(`at most ${MAX_ROWS} rows per request (got ${list.length})`);
  const rows: Row[] = [];
  for (let i = 0; i < list.length; i++) {
    const p = parseRow(list[i]);
    if (typeof p === "string") return bad(`row ${i}: ${p}`);
    rows.push(p);
  }
  const payload = JSON.stringify(rows);

  try {
    const ins = (await sql`
      INSERT INTO reb_track_index (window_id, ist_date, room_id, t0_ms, t1_ms, layer, engine, model, version, config_hash, shadow, status, reason,
                                   machine, r2_key, sha256, bytes, started_at, finished_at)
      SELECT window_id, ist_date, room_id, t0_ms, t1_ms, layer, engine, model, version, config_hash, shadow, status, reason,
             machine, r2_key, sha256, bytes, started_at, finished_at
        FROM jsonb_to_recordset(${payload}::jsonb) AS r(
          window_id text, ist_date date, room_id text, t0_ms bigint, t1_ms bigint, layer text, engine text, model text, version text,
          config_hash text, shadow boolean, status text, reason text, machine text, r2_key text, sha256 text, bytes bigint,
          started_at timestamptz, finished_at timestamptz)
      ON CONFLICT ON CONSTRAINT reb_track_index_key DO NOTHING
      RETURNING window_id, layer, engine, version, config_hash, shadow`) as Array<Row>;
    const insertedKeys = new Set(ins.map((r) => keyOf(r)));

    // What is stored now under each sent key (the row we just wrote, or the one that was already there).
    const stored = (await sql`
      SELECT t.window_id, t.layer, t.engine, t.version, t.config_hash, t.shadow, t.sha256
        FROM reb_track_index t
        JOIN (SELECT DISTINCT window_id, layer, engine, version, config_hash, shadow
                FROM jsonb_to_recordset(${payload}::jsonb) AS r(window_id text, layer text, engine text, version text, config_hash text, shadow boolean)) k
          ON t.window_id = k.window_id AND t.layer = k.layer AND t.engine = k.engine AND t.version = k.version
         AND t.config_hash = k.config_hash AND t.shadow = k.shadow`) as Array<Row>;
    const storedSha = new Map(stored.map((r) => [keyOf(r), r.sha256]));

    let inserted = 0;
    let existing = 0;
    const conflicts: Array<{ key: string; stored_sha: string | null; sent_sha: string }> = [];
    const credited = new Set<string>();
    for (const r of rows) {
      const k = keyOf(r);
      const have = storedSha.get(k) ?? null;
      if (have !== null && have.toLowerCase() === r.sha256.toLowerCase()) {
        if (insertedKeys.has(k) && !credited.has(k)) { inserted++; credited.add(k); } else existing++;
      } else {
        conflicts.push({ key: `${r.window_id}/${r.layer}.${r.engine}__${r.version}__${r.config_hash}${r.shadow ? "/shadow" : ""}`, stored_sha: have, sent_sha: r.sha256 });
      }
    }
    return json({ ok: conflicts.length === 0, inserted, existing, conflicts }, conflicts.length ? 409 : 200);
  } catch (e) {
    console.error(`[reb-index] write failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    return json({ error: { code: "WRITE_FAILED", message: "write failed" } }, 500);
  }
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function GET(req: NextRequest) {
  const denied = authorize(req, ["REB_INDEX_READ_TOKEN", "REB_INDEX_TOKEN"]);
  if (denied) return denied;

  const p = req.nextUrl.searchParams;
  const windowId = p.get("window_id") || null;
  const istDate = p.get("ist_date") || null;
  if (!windowId && !istDate) return bad("window_id or ist_date is required");
  if (istDate && !isDay(istDate)) return bad("ist_date must be YYYY-MM-DD");
  const layer = p.get("layer") || null;
  const engine = p.get("engine") || null;
  const roomId = p.get("room_id") || null;
  const withShadow = p.get("shadow") === "1";
  const limitRaw = p.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null && limitRaw !== "") {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) return bad("limit must be a positive integer");
    limit = Math.min(limit, MAX_LIMIT);
  }
  const cursorRaw = p.get("cursor");
  let cursor = 0;
  if (cursorRaw !== null && cursorRaw !== "") {
    cursor = Number(cursorRaw);
    if (!Number.isSafeInteger(cursor) || cursor < 0) return bad("cursor must be a non-negative integer");
  }

  try {
    const got = (await sql`
      SELECT id, window_id, to_char(ist_date, 'YYYY-MM-DD') AS ist_date, room_id, t0_ms, t1_ms, layer, engine, model, version, config_hash, shadow,
             status, reason, machine, r2_key, sha256, bytes, started_at, finished_at, indexed_at
        FROM reb_track_index
       WHERE id > ${cursor}
         AND (${windowId}::text IS NULL OR window_id = ${windowId})
         AND (${istDate}::text IS NULL OR ist_date = ${istDate}::date)
         AND (${layer}::text IS NULL OR layer = ${layer})
         AND (${engine}::text IS NULL OR engine = ${engine})
         AND (${roomId}::text IS NULL OR room_id = ${roomId})
         AND (${withShadow}::boolean OR shadow = false)
       ORDER BY id
       LIMIT ${limit + 1}`) as Array<Record<string, unknown>>;
    const page = got.slice(0, limit);
    const out = page.map((r) => ({
      ...r,
      id: Number(r.id),
      t0_ms: num(r.t0_ms),
      t1_ms: num(r.t1_ms),
      bytes: num(r.bytes),
      started_at: iso(r.started_at),
      finished_at: iso(r.finished_at),
      indexed_at: iso(r.indexed_at),
    }));
    const next_cursor = got.length > limit ? out[out.length - 1]!.id : null;
    return json({ ok: true, count: out.length, rows: out, next_cursor });
  } catch (e) {
    console.error(`[reb-index] read failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    return json({ error: { code: "READ_FAILED", message: "read failed" } }, 500);
  }
}
