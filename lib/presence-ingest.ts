/**
 * lib/presence-ingest.ts — validation for POST /api/presence (T-PRESENCE-5).
 *
 * Two producers, two exact shapes. Unknown top-level keys are rejected, so the
 * promoted columns can only come from known fields. `payload` is the original
 * event, stored verbatim.
 */

export const EXT_KEYS = [
  "machine_id", "room", "email", "display_name", "event", "encounter_id",
  "prescription_ref", "ts", "tab_focus", "impersonating", "ext_version", "reason",
] as const;

export const POLLER_KEYS = [
  "machine", "ts", "idle_s", "locked", "chrome_running", "console_user", "state", "poller_version",
] as const;

export const EXT_EVENTS = ["login", "logout", "encounter_open", "encounter_close", "idle", "active", "locked", "heartbeat"];

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

function parseTs(x: unknown): string | null {
  if (typeof x !== "string" || x.length > 64) return null;
  const d = new Date(x);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function exactKeys(o: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of Object.keys(o)) if (!keys.includes(k)) return `unknown key: ${k.slice(0, 40)}`;
  for (const k of keys) if (!(k in o)) return `missing key: ${k}`;
  return null;
}

export function validateItem(x: unknown): ItemResult {
  if (!isObj(x)) return { ok: false, reason: "item is not an object" };
  const isExt = "event" in x;
  const isPoller = "state" in x || "machine" in x;
  if (isExt === isPoller) return { ok: false, reason: "unknown shape" };

  if (isExt) {
    const bad = exactKeys(x, EXT_KEYS);
    if (bad) return { ok: false, reason: bad };
    for (const k of ["machine_id", "room", "email", "display_name", "encounter_id", "prescription_ref", "reason"]) {
      if (!nstr(x[k])) return { ok: false, reason: `bad ${k}` };
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

  const bad = exactKeys(x, POLLER_KEYS);
  if (bad) return { ok: false, reason: bad };
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

export function validateBatch(body: unknown, maxItems: number): { ok: true; rows: PresenceRow[] } | { ok: false; status: 413 | 422; message: string } {
  const items = Array.isArray(body) ? body : [body];
  if (items.length > maxItems) return { ok: false, status: 413, message: "batch too large" };
  const rows: PresenceRow[] = [];
  for (let i = 0; i < items.length; i++) {
    const r = validateItem(items[i]);
    if (!r.ok) return { ok: false, status: 422, message: `item ${i}: ${r.reason}` };
    rows.push(r.row);
  }
  return { ok: true, rows };
}
