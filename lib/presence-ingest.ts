/**
 * lib/presence-ingest.ts — validation for POST /api/presence (T-PRESENCE-5).
 *
 * Two producers, two shapes. An item must carry every known key of one shape. Unknown extra
 * top-level keys are kept in `payload` (the event verbatim) and never promoted, so the queryable
 * columns come only from known fields.
 *
 * EXTENSION 0.1.1 (17 fields). Beyond the 13 base fields the extension now sends page_name (first name from the Pulse home greeting,
 * a witness never an identity), instance_id (32 hex, one per install), cookie_uid and cookie_name (non-null only on the new
 * `identity_stale` event: the stale Google-cookie identity). The four are OPTIONAL here, so a 13-field event queued by an older build
 * still validates; when present each must be null or a bounded string. `reason` stays free text (stale_cookie, absent_401,
 * invalid_no_doctor, name_absent_<n>, ... — the extension owns that vocabulary; the sink never narrows it). The whole event is stored
 * verbatim in `payload`, so the new fields are queryable as payload->>'page_name' etc. without a migration. Any fault in one item rejects that item only; the caller
 * counts it and inserts the rest. Strings and timestamps are checked to what Postgres/jsonb accepts.
 */

export const EXT_KEYS = [
  "machine_id", "room", "email", "display_name", "event", "encounter_id",
  "prescription_ref", "ts", "tab_focus", "impersonating", "ext_version", "reason",
] as const;

export const POLLER_KEYS = [
  "machine", "ts", "idle_s", "locked", "chrome_running", "console_user", "state", "poller_version",
] as const;

/** Fields added in extension 0.1.1: optional (absent on an older build's queued events), null-or-bounded-string when present. */
export const EXT_OPTIONAL_STRING_KEYS = ["page_name", "instance_id", "cookie_uid", "cookie_name"] as const;

export const EXT_EVENTS = ["login", "logout", "encounter_open", "encounter_close", "idle", "active", "locked", "heartbeat", "identity_stale"];

export type PresenceRow = {
  source: "ext" | "poller";
  machine: string | null;
  room: string | null;
  event: string | null;
  ts: string; // ISO UTC
  email: string | null;
  payload: Record<string, unknown>;
};

export type ItemResult = { ok: true; row: PresenceRow } | { ok: false; reason: string };

const MAX_STR = 512;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const nstr = (x: unknown) => x === null || (typeof x === "string" && x.length <= MAX_STR);
const str = (x: unknown) => typeof x === "string" && x.length > 0 && x.length <= MAX_STR;

// Lone UTF-16 surrogates and NUL are rejected by Postgres jsonb/text.
const BAD_STRING = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MAX_DEPTH = 8;
const MAX_ITEM_CHARS = 16_384;

/** True when every string (keys included) anywhere in v is safe for Postgres jsonb. */
function stringsSafe(v: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (typeof v === "string") return !BAD_STRING.test(v);
  if (Array.isArray(v)) return v.every((x) => stringsSafe(x, depth + 1));
  if (isObj(v)) return Object.keys(v).every((k) => !BAD_STRING.test(k) && stringsSafe(v[k], depth + 1));
  return true;
}

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

/** Full ISO-8601 datetime with an offset, real calendar values, years 2000-2100. Returns ISO UTC or null. */
export function parseTs(x: unknown): string | null {
  if (typeof x !== "string" || x.length > 40) return null;
  const m = TS_RE.exec(x);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return null;
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  if (m[7] !== "Z" && (Number(m[8]) > 14 || Number(m[9]) > 59)) return null;
  const t = new Date(x).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function hasKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((k) => k in o);
}

export function validateItem(x: unknown): ItemResult {
  if (!isObj(x)) return { ok: false, reason: "item is not an object" };
  const isExt = hasKeys(x, EXT_KEYS);
  const isPoller = hasKeys(x, POLLER_KEYS);
  if (isExt === isPoller) return { ok: false, reason: "unknown shape" };
  if (!stringsSafe(x)) return { ok: false, reason: "unsafe string" };
  if (JSON.stringify(x).length > MAX_ITEM_CHARS) return { ok: false, reason: "item too large" };

  if (isExt) {
    for (const k of ["machine_id", "room", "email", "display_name", "encounter_id", "prescription_ref", "reason"]) {
      if (!nstr(x[k])) return { ok: false, reason: `bad ${k}` };
    }
    for (const k of EXT_OPTIONAL_STRING_KEYS) {
      if (k in x && !nstr(x[k])) return { ok: false, reason: `bad ${k}` };
    }
    if (typeof x.event !== "string" || !EXT_EVENTS.includes(x.event)) return { ok: false, reason: "bad event" };
    const ts = parseTs(x.ts);
    if (!ts) return { ok: false, reason: "bad ts" };
    if (typeof x.tab_focus !== "boolean" || typeof x.impersonating !== "boolean") return { ok: false, reason: "bad boolean" };
    if (!str(x.ext_version)) return { ok: false, reason: "bad ext_version" };
    return {
      ok: true,
      row: { source: "ext", machine: x.machine_id as string | null, room: x.room as string | null, event: x.event, ts, email: x.email as string | null, payload: x },
    };
  }

  if (!str(x.machine)) return { ok: false, reason: "bad machine" };
  const ts = parseTs(x.ts);
  if (!ts) return { ok: false, reason: "bad ts" };
  if (typeof x.idle_s !== "number" || !Number.isFinite(x.idle_s) || x.idle_s < 0) return { ok: false, reason: "bad idle_s" };
  if (typeof x.locked !== "boolean" || typeof x.chrome_running !== "boolean") return { ok: false, reason: "bad boolean" };
  if (!nstr(x.console_user)) return { ok: false, reason: "bad console_user" };
  if (!str(x.state)) return { ok: false, reason: "bad state" };
  if (!str(x.poller_version)) return { ok: false, reason: "bad poller_version" };
  return {
    ok: true,
    row: { source: "poller", machine: x.machine as string, room: null, event: x.state as string, ts, email: null, payload: x },
  };
}

/** Per-item validation. Only an oversize batch fails as a whole; bad items are counted, not fatal. */
export function validateBatch(body: unknown, maxItems: number): { ok: true; rows: PresenceRow[]; rejected: number } | { ok: false; status: 413; message: string } {
  const items = Array.isArray(body) ? body : [body];
  if (items.length > maxItems) return { ok: false, status: 413, message: "batch too large" };
  const rows: PresenceRow[] = [];
  let rejected = 0;
  for (const it of items) {
    const r = validateItem(it);
    if (r.ok) rows.push(r.row);
    else rejected++;
  }
  return { ok: true, rows, rejected };
}
