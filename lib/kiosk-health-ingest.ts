/**
 * lib/kiosk-health-ingest.ts — validation for POST /api/kiosk-health (W1 kiosk-health daemon sink).
 *
 * Envelope per event: { machine, room_id, install_id, boot_id, seq, source, kind, ts, payload }. Pure: no I/O, no logging.
 * Payload contents are never logged or inspected beyond size and Postgres-safety.
 *
 * validateKioskHealthBatch(body, now?) returns { rows, rejected, error? }.
 *   Batch-level faults set `error` (rows empty): "bad_body" (not { events: [...] }), "empty_batch" (0 items), "too_many_events" (> 500).
 *   Item-level faults are listed in `rejected` as { index, reason } and never fail the batch; the valid items stay in `rows`.
 */

export const MAX_EVENTS = 500;
export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_SEQ = 2 ** 53;
// Hard bounds on ts: anything parseable inside them is stored. Clock skew is data, not an error (received_at is the trusted time).
export const MIN_TS_MS = Date.UTC(2000, 0, 1);
export const MAX_TS_MS = Date.UTC(2100, 0, 1);
// Outside now-30d .. now+1h the event is still stored, with payload._clock_suspect = true.
export const SUSPECT_FUTURE_MS = 3_600_000;
export const SUSPECT_PAST_MS = 30 * 86_400_000;

export type KioskHealthRow = {
  machine: string;
  room_id: string | null;
  install_id: string | null;
  boot_id: string;
  seq: number;
  source: string;
  kind: string;
  ts: string; // ISO UTC
  payload: Record<string, unknown>;
};

export type KioskHealthBatch = {
  rows: KioskHealthRow[];
  rejected: { index: number; reason: string }[];
  error?: "bad_body" | "empty_batch" | "too_many_events";
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const nonEmpty = (x: unknown, max: number): x is string => typeof x === "string" && x.length > 0 && x.length <= max;

const KIND_RE = /^[a-z0-9_.-]+$/;
// Full ISO-8601 datetime with an explicit offset (the daemon sends UTC ms with Z).
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Real calendar and clock values (V8 would roll 2026-02-30 over to March and accept 24:00:00). */
function realDate(m: RegExpExecArray): boolean {
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() && h <= 23 && mi <= 59 && se <= 59;
}
// NUL and lone UTF-16 surrogates are refused by Postgres text/jsonb.
const BAD_STRING = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MAX_DEPTH = 12;

function stringsSafe(v: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (typeof v === "string") return !BAD_STRING.test(v);
  if (Array.isArray(v)) return v.every((x) => stringsSafe(x, depth + 1));
  if (isObj(v)) return Object.keys(v).every((k) => !BAD_STRING.test(k) && stringsSafe(v[k], depth + 1));
  return true;
}

function optId(x: unknown): string | null | undefined {
  if (x === undefined || x === null) return null;
  return nonEmpty(x, 64) ? x : undefined; // undefined = invalid
}

function validateItem(x: unknown, now: number): { ok: true; row: KioskHealthRow } | { ok: false; reason: string } {
  if (!isObj(x)) return { ok: false, reason: "not_object" };
  if (!nonEmpty(x.machine, 128)) return { ok: false, reason: "bad_machine" };
  if (!nonEmpty(x.boot_id, 64)) return { ok: false, reason: "bad_boot_id" };
  if (typeof x.seq !== "number" || !Number.isInteger(x.seq) || x.seq < 0 || x.seq > MAX_SEQ) return { ok: false, reason: "bad_seq" };
  if (!nonEmpty(x.source, 32)) return { ok: false, reason: "bad_source" };
  if (!nonEmpty(x.kind, 64) || !KIND_RE.test(x.kind)) return { ok: false, reason: "bad_kind" };

  const tm = typeof x.ts === "string" && x.ts.length <= 40 ? TS_RE.exec(x.ts) : null;
  if (!tm || !realDate(tm)) return { ok: false, reason: "bad_ts" };
  const t = new Date(x.ts as string).getTime();
  if (Number.isNaN(t)) return { ok: false, reason: "bad_ts" };
  if (t < MIN_TS_MS || t >= MAX_TS_MS) return { ok: false, reason: "ts_out_of_range" };
  const clockSuspect = t > now + SUSPECT_FUTURE_MS || t < now - SUSPECT_PAST_MS;

  const room = optId(x.room_id);
  if (room === undefined) return { ok: false, reason: "bad_room_id" };
  const install = optId(x.install_id);
  if (install === undefined) return { ok: false, reason: "bad_install_id" };

  let payload: Record<string, unknown> = {};
  if (x.payload !== undefined && x.payload !== null) {
    if (!isObj(x.payload)) return { ok: false, reason: "bad_payload" };
    if (Buffer.byteLength(JSON.stringify(x.payload), "utf8") > MAX_PAYLOAD_BYTES) return { ok: false, reason: "payload_too_large" };
    payload = x.payload;
  }
  if (![x.machine, x.boot_id, x.source, x.kind, room, install].every((s) => s === null || !BAD_STRING.test(s as string)) || !stringsSafe(payload)) {
    return { ok: false, reason: "unsafe_string" };
  }

  return {
    ok: true,
    row: {
      machine: x.machine,
      room_id: room,
      install_id: install,
      boot_id: x.boot_id,
      seq: x.seq,
      source: x.source,
      kind: x.kind,
      ts: new Date(t).toISOString(),
      payload: clockSuspect ? { ...payload, _clock_suspect: true } : payload,
    },
  };
}

export function validateKioskHealthBatch(body: unknown, now: number = Date.now()): KioskHealthBatch {
  if (!isObj(body) || !Array.isArray(body.events)) return { rows: [], rejected: [], error: "bad_body" };
  const events = body.events as unknown[];
  if (events.length === 0) return { rows: [], rejected: [], error: "empty_batch" };
  if (events.length > MAX_EVENTS) return { rows: [], rejected: [], error: "too_many_events" };

  const rows: KioskHealthRow[] = [];
  const rejected: { index: number; reason: string }[] = [];
  events.forEach((e, index) => {
    const r = validateItem(e, now);
    if (r.ok) rows.push(r.row);
    else rejected.push({ index, reason: r.reason });
  });
  return { rows, rejected };
}
