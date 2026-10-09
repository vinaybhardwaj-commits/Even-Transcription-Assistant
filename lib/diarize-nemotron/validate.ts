/**
 * lib/diarize-nemotron/validate.ts — PURE checks for what the Nemotron worker posts (epic #23, ticket b).
 *
 * Every body is checked here before any SQL runs, and every check REFUSES rather than repairs: a turn list
 * that needed fixing is a worker bug, and a stored row that was quietly fixed would hide it.
 *
 * THE BODY IS A CLOSED SHAPE (PRD §7.1). An unknown top-level key is refused, not dropped: this table must
 * never become a place where text, names or embeddings can arrive under a field nobody reads.
 *
 * payload_sha256 leaves out worker_id and machine: it fingerprints the RESULT, so the same turns from the box
 * and from HF are a duplicate, not a conflict (Orchestrator ruling, 9 Oct 2026).
 *
 * CANONICAL JSON (used for config_hash and payload_sha256): object keys sorted, no whitespace, arrays in
 * order — the output of Python's `json.dumps(obj, sort_keys=True, separators=(",", ":"))` for the values
 * allowed here. That is why config values are restricted to integers, booleans and short ASCII strings:
 * floats and non-ASCII are where the two serialisers differ.
 */
import { createHash } from "node:crypto";

export const NEMOTRON_ENGINE = "nemotron";
export const MAX_SPEAKERS = 8;
export const MAX_TURNS = 5000;
/** 4 h. A bench window is 900 s; anything near this bound is a unit mistake (seconds sent as ms × 1000). */
export const MAX_AUDIO_MS = 4 * 3600 * 1000;
export const MAX_ATTEMPTS = 3;
/** Codes after which another attempt cannot help (PRD §6.1: decode failure is terminal). */
export const TERMINAL_ERROR_CODES: ReadonlySet<string> = new Set(["decode_failed"]);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WORKER_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MODEL_RE = /^[A-Za-z0-9._\/-]{1,128}$/;
const REV_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const CODE_RE = /^[a-z0-9_]{1,64}$/;
const LABEL_RE = /^spk\d{1,2}$/;
const CONFIG_KEY_RE = /^[a-z0-9_]{1,40}$/;
const CONFIG_STR_RE = /^[\x20-\x7e]{0,64}$/;
/** Heartbeat descriptors (host, "Tesla T4", a revision): short, printable, no quotes or control characters. */
const HB_TOKEN_RE = /^[A-Za-z0-9 ._:\/-]{1,128}$/;

export type IngestStatus = "ok" | "empty" | "failed";
export type Turn = [number, number, string];

export type IngestBody = {
  window_id: string;
  room_day_id: string;
  engine: "nemotron";
  model: string;
  model_rev: string;
  config: Record<string, number | string | boolean>;
  config_hash: string;
  worker_id: string;
  machine: "box" | "hf";
  audio_ms: number;
  clip_sha256: string | null;
  status: IngestStatus;
  error_code: string | null;
  turns: Turn[];
};

export type Derived = { speaker_count: number; turn_count: number; speech_ms: number; overlap_ms: number };

export type IngestCheck =
  | { ok: true; body: IngestBody; derived: Derived; payload_sha256: string }
  | { ok: false; error: string };

const INGEST_KEYS = [
  "window_id", "room_day_id", "engine", "model", "model_rev", "config", "config_hash", "worker_id",
  "machine", "audio_ms", "clip_sha256", "status", "error_code", "turns",
] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** PURE — canonical JSON: sorted keys, no whitespace. Throws on a value JSON cannot carry. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObj(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  }
  throw new Error(`cannot canonicalise ${typeof v}`);
}

export const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** PURE — the config's own hash, as the worker must compute it. */
export const configHash = (config: Record<string, unknown>): string => sha256Hex(canonicalJson(config));

/**
 * PURE — speech (time covered by at least one turn) and overlap (time covered by two or more), by a sweep
 * over turn edges. Both in ms. Turns must already be validated.
 */
export function speechAndOverlap(turns: ReadonlyArray<Turn>): { speech_ms: number; overlap_ms: number } {
  const edges: Array<[number, number]> = [];
  for (const [s, e] of turns) edges.push([s, 1], [e, -1]);
  // Ends before starts at the same instant: two turns that only touch do not overlap.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let depth = 0;
  let prev = 0;
  let speech = 0;
  let overlap = 0;
  for (const [t, d] of edges) {
    if (depth >= 1) speech += t - prev;
    if (depth >= 2) overlap += t - prev;
    depth += d;
    prev = t;
  }
  return { speech_ms: speech, overlap_ms: overlap };
}

function checkConfig(v: unknown): string | null {
  if (!isObj(v)) return "bad_config";
  const keys = Object.keys(v);
  if (keys.length === 0 || keys.length > 32) return "bad_config";
  for (const k of keys) {
    if (!CONFIG_KEY_RE.test(k)) return "bad_config";
    const x = v[k];
    if (isInt(x) || typeof x === "boolean") continue;
    if (typeof x === "string" && CONFIG_STR_RE.test(x)) continue;
    return "bad_config";
  }
  return null;
}

function checkTurns(v: unknown, audioMs: number): { turns: Turn[] } | { error: string } {
  if (!Array.isArray(v)) return { error: "bad_turns" };
  if (v.length > MAX_TURNS) return { error: "too_many_turns" };
  const turns: Turn[] = [];
  const labels = new Set<string>();
  let last: Turn | null = null;
  for (const t of v) {
    if (!Array.isArray(t) || t.length !== 3) return { error: "bad_turn" };
    const [s, e, l] = t as unknown[];
    if (!isInt(s) || !isInt(e) || typeof l !== "string") return { error: "bad_turn" };
    if (!LABEL_RE.test(l)) return { error: "bad_speaker_label" };
    if (!(s >= 0 && s < e && e <= audioMs)) return { error: "turn_out_of_range" };
    if (last && (s < last[0] || (s === last[0] && e < last[1]))) return { error: "turns_not_sorted" };
    labels.add(l);
    last = [s, e, l];
    turns.push(last);
  }
  if (labels.size > MAX_SPEAKERS) return { error: "too_many_speakers" };
  return { turns };
}

/** PURE — the whole ingest body, or the first reason it is refused. */
export function checkIngest(raw: unknown): IngestCheck {
  if (!isObj(raw)) return { ok: false, error: "bad_body" };
  for (const k of Object.keys(raw)) if (!(INGEST_KEYS as readonly string[]).includes(k)) return { ok: false, error: "unknown_field" };
  for (const k of INGEST_KEYS) if (!(k in raw)) return { ok: false, error: `missing_${k}` };
  const b = raw as Record<(typeof INGEST_KEYS)[number], unknown>;

  if (typeof b.window_id !== "string" || !ID_RE.test(b.window_id)) return { ok: false, error: "bad_window_id" };
  if (typeof b.room_day_id !== "string" || !ID_RE.test(b.room_day_id)) return { ok: false, error: "bad_room_day_id" };
  if (b.engine !== NEMOTRON_ENGINE) return { ok: false, error: "bad_engine" };
  if (typeof b.model !== "string" || !MODEL_RE.test(b.model)) return { ok: false, error: "bad_model" };
  if (typeof b.model_rev !== "string" || !REV_RE.test(b.model_rev)) return { ok: false, error: "bad_model_rev" };
  const cfgErr = checkConfig(b.config);
  if (cfgErr) return { ok: false, error: cfgErr };
  if (typeof b.config_hash !== "string" || !SHA_RE.test(b.config_hash)) return { ok: false, error: "bad_config_hash" };
  if (configHash(b.config as Record<string, unknown>) !== b.config_hash) return { ok: false, error: "config_hash_mismatch" };
  if (typeof b.worker_id !== "string" || !WORKER_RE.test(b.worker_id)) return { ok: false, error: "bad_worker_id" };
  if (b.machine !== "box" && b.machine !== "hf") return { ok: false, error: "bad_machine" };
  if (b.status !== "ok" && b.status !== "empty" && b.status !== "failed") return { ok: false, error: "bad_status" };
  const status = b.status;
  if (!isInt(b.audio_ms) || b.audio_ms < 0 || b.audio_ms > MAX_AUDIO_MS) return { ok: false, error: "bad_audio_ms" };
  if (status !== "failed" && b.audio_ms === 0) return { ok: false, error: "bad_audio_ms" };
  if (b.clip_sha256 !== null && (typeof b.clip_sha256 !== "string" || !SHA_RE.test(b.clip_sha256))) return { ok: false, error: "bad_clip_sha256" };
  // A result was computed from a clip, so it must say which clip. Only a failure may lack one (the fetch itself can fail).
  if (status !== "failed" && b.clip_sha256 === null) return { ok: false, error: "missing_clip_sha256" };
  if (status === "failed") {
    if (typeof b.error_code !== "string" || !CODE_RE.test(b.error_code)) return { ok: false, error: "bad_error_code" };
  } else if (b.error_code !== null) return { ok: false, error: "error_code_without_failure" };

  const t = checkTurns(b.turns, b.audio_ms);
  if ("error" in t) return { ok: false, error: t.error };
  if (status === "ok" && t.turns.length === 0) return { ok: false, error: "ok_without_turns" };
  if (status !== "ok" && t.turns.length > 0) return { ok: false, error: `turns_with_${status}` };

  const body: IngestBody = {
    window_id: b.window_id,
    room_day_id: b.room_day_id,
    engine: NEMOTRON_ENGINE,
    model: b.model,
    model_rev: b.model_rev,
    config: b.config as IngestBody["config"],
    config_hash: b.config_hash,
    worker_id: b.worker_id,
    machine: b.machine,
    audio_ms: b.audio_ms,
    clip_sha256: b.clip_sha256 as string | null,
    status,
    error_code: b.error_code as string | null,
    turns: t.turns,
  };
  const so = speechAndOverlap(t.turns);
  const derived: Derived = {
    speaker_count: new Set(t.turns.map((x) => x[2])).size,
    turn_count: t.turns.length,
    speech_ms: so.speech_ms,
    overlap_ms: so.overlap_ms,
  };
  const { worker_id: _w, machine: _m, ...result } = body;
  return { ok: true, body, derived, payload_sha256: sha256Hex(canonicalJson(result)) };
}

// ---------------------------------------------------------------------------
// Heartbeat (PRD §6.1). Allow-listed fields; anything else is dropped, never stored.
// ---------------------------------------------------------------------------

const HB_INT_FIELDS = ["queue_depth", "oldest_wait_s", "windows_24h", "hf_jobs_24h"] as const;
const HB_TOKEN_FIELDS = ["host", "gpu", "model_rev", "last_error_code"] as const;

export type HeartbeatCheck =
  | { ok: true; worker_id: string; payload: Record<string, string | number | null> }
  | { ok: false; error: string };

/** PURE — a heartbeat body. Unknown fields are DROPPED (a heartbeat is advisory; a newer worker may send more). */
export function checkHeartbeat(raw: unknown): HeartbeatCheck {
  if (!isObj(raw)) return { ok: false, error: "bad_body" };
  if (typeof raw.worker_id !== "string" || !WORKER_RE.test(raw.worker_id)) return { ok: false, error: "bad_worker_id" };
  const payload: Record<string, string | number | null> = {};
  for (const k of HB_INT_FIELDS) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    if (!isInt(v) || v < 0) return { ok: false, error: `bad_${k}` };
    payload[k] = v;
  }
  for (const k of HB_TOKEN_FIELDS) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || !HB_TOKEN_RE.test(v)) return { ok: false, error: `bad_${k}` };
    payload[k] = v;
  }
  if (raw.config_hash !== undefined && raw.config_hash !== null) {
    if (typeof raw.config_hash !== "string" || !SHA_RE.test(raw.config_hash)) return { ok: false, error: "bad_config_hash" };
    payload.config_hash = raw.config_hash;
  }
  if (raw.hf_usd_24h !== undefined && raw.hf_usd_24h !== null) {
    const v = raw.hf_usd_24h;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 10_000) return { ok: false, error: "bad_hf_usd_24h" };
    payload.hf_usd_24h = Math.round(v * 100) / 100;
  }
  if (raw.last_ok_at !== undefined && raw.last_ok_at !== null) {
    const v = raw.last_ok_at;
    if (typeof v !== "string" || v.length > 40 || Number.isNaN(Date.parse(v))) return { ok: false, error: "bad_last_ok_at" };
    payload.last_ok_at = new Date(v).toISOString();
  }
  return { ok: true, worker_id: raw.worker_id, payload };
}

/** PURE — the `?limit=` of /pending: 1..8, default 4. */
export function pendingLimit(v: string | null): number {
  const n = v === null || v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(8, Math.max(1, Math.trunc(n))) : 4;
}

export const isWorkerId = (v: unknown): v is string => typeof v === "string" && WORKER_RE.test(v);
