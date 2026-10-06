/**
 * lib/kiosk-health-read.ts — the READ half of the kiosk-health bench rules (R11–R17, lib/kiosk-health-rules.ts).
 *
 * Source: kiosk_health_events (migration 0126), rows POSTed by the root daemon on each clinic Mac. One row per event, append-only.
 * `ts` is EVENT time — pmset-log rows can be backfilled 12–17 h late, so a row can be hours old by `ts` and seconds old by `received_at`.
 * `received_at` is the trusted arrival time. Every read here is bounded on `received_at`; ordering of power events is by `ts`.
 *
 * FOUR queries, all `machine = ANY($keys)` and `received_at` bounded above by asOf and below by asOf − 24 h (asOf − 7 days for query 4), all bound parameters (Neon HTTP driver: no sql.unsafe):
 *   1. newest row per (machine, kind) — DISTINCT ON over the 24 h window (rides kiosk_health_events_machine_ts_idx).
 *   2. one window CTE over power.* / drift / audio.error(start_failure) rows, split three ways: audio start failures in the last 10 min (a count per
 *      machine), power events in the last 12 h (newest 50 per machine, row_number cap), drift rows in the 24 h (newest 100 per machine).
 *   3. recorder.log rows whose line mentions signature_mismatch: count + newest line per machine.
 *   4. the newest row per machine of ANY kind in the last 7 days (kiosk_health_events_machine_received_idx, migration 0127): decides `enrolled` and
 *      last_seen_received_at, so a daemon that stopped hours ago stays visible instead of vanishing once its last row leaves the 24 h window.
 *
 * MACHINE SPELLINGS. Daemon rows can name a Mac as "EHRC-ECHOs-Mac-mini", "ehrc-echos-mac-mini.local", etc. Rows are matched on lower-cased names with a
 * trailing ".local" stripped, and the SQL key list carries the plain, lower-cased and ".local" variants of every key (exact `= ANY` keeps the index).
 *
 * Failure contract: a failed read never takes the panel down. Any error is caught, ONE warning is logged (generic text, never row contents) and the
 * result is `{ snapshots: <empty map>, ok: false }` — the rules then see no kiosk-health evidence and raise nothing, and the caller marks the source degraded.
 */
import type { WindowsDb } from "@/lib/encounter-windows/db";
import { POLLER_LEGACY_KEYS } from "@/lib/encounter-windows/machine-keys";
import { normalizeHostname } from "@/lib/encounter-windows/types";

export const KH_WINDOW_H = 24;
export const KH_POWER_WINDOW_H = 12;
export const KH_START_FAILURE_WINDOW_MIN = 10;
export const KH_POWER_CAP = 50;
export const KH_DRIFT_CAP = 100;
export const KH_ENROLLED_DAYS = 7;

export type KhPowerEvent = {
  kind: string;
  ts: string;
  received_at: string;
  reason: string | null;
  kAESleep: string | null;
};

export type KhDriftRow = {
  ts: string;
  received_at: string;
  field: string;
  expected: string | null;
  actual: string | null;
  change: string | null;
  resolved: boolean;
};

export type KioskHealthSnapshot = {
  /** canonical machine key (normalised hostname, the key ext-health uses) */
  machine: string;
  /** room_id as the daemon stamped it on its newest row, or null */
  room_id: string | null;
  /** any row at all in the last 7 days */
  enrolled: boolean;
  /** received_at of the newest row of any kind in the last 7 days, or null */
  last_seen_received_at: string | null;
  last_heartbeat_received_at: string | null;
  /** newest power.* event (any kind) by ts in the 12 h window */
  last_power: KhPowerEvent | null;
  /** the 12 h power events, oldest first by ts (newest 50) */
  power_events: KhPowerEvent[];
  last_display_state: { ts: string; received_at: string; state: string | null; origin: string | null } | null;
  /** newest audio.devices row from `system_profiler` (the only method the rules read) */
  last_audio_devices: { ts: string; received_at: string; default_input_present: boolean; default_input_name: string | null } | null;
  audio_start_failures_10m: number;
  /** ts of the newest start_failure row inside the 10 min window, or null */
  audio_start_failure_newest_ts: string | null;
  /** latest drift row per field (24 h) */
  last_drift_by_field: Record<string, KhDriftRow>;
  last_drift_summary: { ts: string; received_at: string; drift_count: number; items: Array<{ field: string; expected: string | null; actual: string | null }> } | null;
  last_watchdog: { ts: string; received_at: string; trigger: string | null; action: string | null; outcome: string | null; failure_reasons: string[] } | null;
  last_ladder: { ts: string; received_at: string; rung: string | null; trigger: string | null; outcome: string | null; reason: string | null } | null;
  last_chrome_profile: { ts: string; received_at: string; running: boolean | null; last_used: string | null; guest: boolean | null; presence_ok: boolean | null } | null;
  last_chrome_alert: { ts: string; received_at: string; reason: string | null; last_used: string | null; guest: boolean | null; presence_ok: boolean | null } | null;
  recorder_update_failures_24h: { count: number; newest_line: string | null; newest_ts: string | null };
  last_recorder_status: { ts: string; received_at: string; state: string | null; session_open: string | null; pending_piece_count: number | null } | null;
};

// ---------------------------------------------------------------------------
// Payload helpers — the payload is jsonb the daemon wrote; never trust a key to exist or have its documented type.
// ---------------------------------------------------------------------------

const toIso = (x: unknown): string | null => {
  if (x === null || x === undefined) return null;
  const t = new Date(x as string | number | Date).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const obj = (x: unknown): Record<string, unknown> => {
  if (typeof x === "string") {
    try {
      const p = JSON.parse(x);
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
};
const str = (x: unknown, max = 300): string | null => (typeof x === "string" && x.length > 0 ? x.slice(0, max) : typeof x === "number" ? String(x) : null);
const bool = (x: unknown): boolean | null => (typeof x === "boolean" ? x : null);
const numOrNull = (x: unknown): number | null => {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
/** An expected/actual value of any JSON type as a short display string. */
const show = (x: unknown): string | null => {
  if (x === null || x === undefined) return null;
  if (typeof x === "string") return x.slice(0, 120);
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  try {
    return JSON.stringify(x).slice(0, 120);
  } catch {
    return null;
  }
};

/** The spelling-insensitive comparison key: trimmed, lower-cased, trailing ".local" removed. */
export const matchKey = (k: string): string => k.trim().toLowerCase().replace(/\.local$/, "");
const stripLocal = (k: string): string => k.trim().replace(/\.local$/i, "");
/** Every spelling worth sending to `= ANY`: the key as given, without ".local", lower-cased, and each with ".local" appended. */
export function expandKeys(given: readonly string[]): string[] {
  const out = new Set<string>();
  for (const k of given) {
    const base = stripLocal(k);
    for (const v of [k.trim(), base, base.toLowerCase()]) {
      out.add(v);
      out.add(`${v}.local`);
    }
  }
  return [...out].filter((v) => v.length > 0);
}

/** Canonical machine key for any spelling machineKeys() knows (raw hostname, normalised hostname, pre-5-Oct poller short key). */
export function canonicalMachine(key: string): string {
  return POLLER_LEGACY_KEYS[key] ?? normalizeHostname(key);
}

type NewestRow = { machine: string; room_id: string | null; kind: string; ts: unknown; received_at: unknown; payload: unknown };
type WindowRow = { part: string; machine: string; kind: string; ts: unknown; received_at: unknown; payload: unknown; n: unknown };
type RecorderRow = { machine: string; n: unknown; line: string | null; ts: unknown };
type SeenRow = { machine: string; received_at: unknown; kind: string };

const emptySnapshot = (machine: string): KioskHealthSnapshot => ({
  machine,
  room_id: null,
  enrolled: false,
  last_seen_received_at: null,
  last_heartbeat_received_at: null,
  last_power: null,
  power_events: [],
  last_display_state: null,
  last_audio_devices: null,
  audio_start_failures_10m: 0,
  audio_start_failure_newest_ts: null,
  last_drift_by_field: {},
  last_drift_summary: null,
  last_watchdog: null,
  last_ladder: null,
  last_chrome_profile: null,
  last_chrome_alert: null,
  recorder_update_failures_24h: { count: 0, newest_line: null, newest_ts: null },
  last_recorder_status: null,
});

const newer = (a: string, b: string | null | undefined): boolean => !b || Date.parse(a) > Date.parse(b);

/**
 * Per canonical machine, the evidence the kiosk-health rules read. `machineKeys` is every spelling of every machine to read (the flat union of
 * machineKeys(hostname) per fleet Mac). Read-only. On ANY error: one warning, empty map.
 */
export async function readKioskHealth(sql: WindowsDb, machineKeys: string[], asOf: string): Promise<{ snapshots: Map<string, KioskHealthSnapshot>; ok: boolean }> {
  const out = new Map<string, KioskHealthSnapshot>();
  try {
    const given = [...new Set(machineKeys.filter((k) => typeof k === "string" && k.trim().length > 0))];
    if (given.length === 0) return { snapshots: out, ok: true };
    const keyToCanon = new Map<string, string>();
    for (const k of given) {
      const canon = canonicalMachine(stripLocal(k));
      keyToCanon.set(matchKey(k), canon);
      keyToCanon.set(matchKey(canon), canon);
    }
    const keys = expandKeys(given);
    const at = new Date(asOf);
    if (!Number.isFinite(at.getTime())) throw new Error("bad asOf");
    const hi = at.toISOString();

    const snap = (rawMachine: string): KioskHealthSnapshot | null => {
      const canon = keyToCanon.get(matchKey(rawMachine));
      if (!canon) return null;
      let s = out.get(canon);
      if (!s) {
        s = emptySnapshot(canon);
        out.set(canon, s);
      }
      return s;
    };

    // 1 — newest row per (machine, kind). Ordered by event time; the heartbeat's ts and received_at agree. For audio.devices only the system_profiler
    // shape (boolean default_input_present) is wanted, so the ioreg rows never compete for "newest" and their large payloads never travel.
    const newest = (await sql`
      SELECT DISTINCT ON (k.machine, k.kind) k.machine, k.room_id, k.kind, k.ts, k.received_at, k.payload
        FROM kiosk_health_events k
       WHERE k.machine = ANY(${keys}::text[])
         AND k.received_at >= ${hi}::timestamptz - interval '24 hours'
         AND k.received_at <= ${hi}::timestamptz
         AND (k.kind <> 'audio.devices' OR jsonb_typeof(k.payload->'default_input_present') = 'boolean')
       ORDER BY k.machine, k.kind, k.ts DESC, k.received_at DESC
    `) as unknown as NewestRow[];

    // 2 — the detail window: audio start failures (10 min count), power events (12 h, newest 50 per machine), drift rows (24 h, newest 100 per machine).
    const detail = (await sql`
      WITH w AS (
        SELECT k.machine, k.kind, k.ts, k.received_at, k.payload
          FROM kiosk_health_events k
         WHERE k.machine = ANY(${keys}::text[])
           AND k.received_at >= ${hi}::timestamptz - interval '24 hours'
           AND k.received_at <= ${hi}::timestamptz
           AND (k.kind LIKE 'power.%' OR k.kind = 'drift' OR (k.kind = 'audio.error' AND (k.payload->'start_failure') = 'true'::jsonb))
      ),
      p AS (
        SELECT w.machine, w.kind, w.ts, w.received_at,
               jsonb_build_object('reason', w.payload->'reason', 'kAESleep', w.payload->'kAESleep') AS payload,
               row_number() OVER (PARTITION BY w.machine ORDER BY w.ts DESC, w.received_at DESC) AS rn
          FROM w
         WHERE w.kind LIKE 'power.%' AND w.received_at >= ${hi}::timestamptz - interval '12 hours'
      ),
      d AS (
        SELECT w.machine, w.kind, w.ts, w.received_at, w.payload,
               row_number() OVER (PARTITION BY w.machine ORDER BY w.ts DESC, w.received_at DESC) AS rn
          FROM w
         WHERE w.kind = 'drift'
      )
      SELECT 'power' AS part, p.machine, p.kind, p.ts, p.received_at, p.payload, NULL::int AS n FROM p WHERE p.rn <= 50
      UNION ALL
      SELECT 'drift', d.machine, d.kind, d.ts, d.received_at, d.payload, NULL::int FROM d WHERE d.rn <= 100
      UNION ALL
      SELECT 'start_failure', f.machine, 'audio.error', max(f.ts), max(f.received_at), NULL::jsonb, count(*)::int
        FROM w f
       WHERE f.kind = 'audio.error' AND f.received_at >= ${hi}::timestamptz - interval '10 minutes'
       GROUP BY f.machine
    `) as unknown as WindowRow[];

    // 3 — recorder self-update failures: count + newest line per machine.
    const recorder = (await sql`
      SELECT DISTINCT ON (r.machine) r.machine, count(*) OVER (PARTITION BY r.machine)::int AS n, r.payload->>'line' AS line, r.ts
        FROM kiosk_health_events r
       WHERE r.machine = ANY(${keys}::text[])
         AND r.received_at >= ${hi}::timestamptz - interval '24 hours'
         AND r.received_at <= ${hi}::timestamptz
         AND r.kind = 'recorder.log' AND r.payload->>'line' LIKE '%signature_mismatch%'
       ORDER BY r.machine, r.ts DESC, r.received_at DESC
    `) as unknown as RecorderRow[];

    for (const r of newest) {
      const s = snap(r.machine);
      const ts = toIso(r.ts);
      const rec = toIso(r.received_at);
      if (!s || !ts || !rec) continue;
      s.enrolled = true;
      if (r.room_id && !s.room_id) s.room_id = r.room_id;
      const p = obj(r.payload);
      switch (r.kind) {
        case "heartbeat":
          if (newer(rec, s.last_heartbeat_received_at)) s.last_heartbeat_received_at = rec;
          break;
        case "display.state":
          if (!s.last_display_state || newer(ts, s.last_display_state.ts)) s.last_display_state = { ts, received_at: rec, state: str(p.state, 20), origin: str(p.origin, 20) };
          break;
        case "audio.devices": {
          const present = bool(p.default_input_present);
          if (present === null) break;
          if (!s.last_audio_devices || newer(ts, s.last_audio_devices.ts)) {
            s.last_audio_devices = { ts, received_at: rec, default_input_present: present, default_input_name: str(obj(p.default_input).name, 120) };
          }
          break;
        }
        case "drift.summary": {
          if (s.last_drift_summary && !newer(ts, s.last_drift_summary.ts)) break;
          const items = Array.isArray(p.items) ? p.items : [];
          s.last_drift_summary = {
            ts,
            received_at: rec,
            drift_count: numOrNull(p.drift_count) ?? items.length,
            items: items.slice(0, 20).map((i) => {
              const o = obj(i);
              return { field: str(o.field, 80) ?? "?", expected: show(o.expected), actual: show(o.actual) };
            }),
          };
          break;
        }
        case "watchdog.action":
          if (!s.last_watchdog || newer(ts, s.last_watchdog.ts)) {
            const ev = obj(p.evidence);
            s.last_watchdog = {
              ts,
              received_at: rec,
              trigger: str(p.trigger, 120),
              action: str(p.action, 120),
              outcome: str(p.outcome, 40),
              failure_reasons: Array.isArray(ev.failure_reasons) ? ev.failure_reasons.map((x) => str(x, 120)).filter((x): x is string => x !== null).slice(0, 8) : [],
            };
          }
          break;
        case "ladder.rung":
          if (!s.last_ladder || newer(ts, s.last_ladder.ts)) s.last_ladder = { ts, received_at: rec, rung: str(p.rung, 80), trigger: str(p.trigger, 120), outcome: str(p.outcome, 40), reason: str(p.reason, 160) };
          break;
        case "chrome.profile":
          if (!s.last_chrome_profile || newer(ts, s.last_chrome_profile.ts)) {
            s.last_chrome_profile = { ts, received_at: rec, running: bool(p.running), last_used: str(p.last_used, 80), guest: bool(p.guest), presence_ok: bool(p.presence_ok) };
          }
          break;
        case "chrome.alert":
          if (!s.last_chrome_alert || newer(ts, s.last_chrome_alert.ts)) {
            s.last_chrome_alert = { ts, received_at: rec, reason: str(p.reason, 120), last_used: str(p.last_used, 80), guest: bool(p.guest), presence_ok: bool(p.presence_ok) };
          }
          break;
        case "recorder.status":
          if (!s.last_recorder_status || newer(ts, s.last_recorder_status.ts)) {
            s.last_recorder_status = { ts, received_at: rec, state: str(p.state, 40), session_open: str(p.session_open, 12), pending_piece_count: numOrNull(p.pending_piece_count) };
          }
          break;
        default:
          break;
      }
    }

    for (const r of detail) {
      const s = snap(r.machine);
      const ts = toIso(r.ts);
      const rec = toIso(r.received_at);
      if (!s || !ts || !rec) continue;
      s.enrolled = true;
      if (r.part === "power") {
        const p = obj(r.payload);
        s.power_events.push({ kind: r.kind, ts, received_at: rec, reason: str(p.reason, 160), kAESleep: str(p.kAESleep, 80) });
      } else if (r.part === "drift") {
        const p = obj(r.payload);
        const field = str(p.field, 80);
        if (!field) continue;
        const prev = s.last_drift_by_field[field];
        // Latest row per field: newest ts wins (the SQL ordering is by ts DESC but several spellings of one machine can interleave).
        if (prev && !newer(ts, prev.ts)) continue;
        s.last_drift_by_field[field] = { ts, received_at: rec, field, expected: show(p.expected), actual: show(p.actual), change: str(p.change, 20), resolved: p.resolved === true };
      } else if (r.part === "start_failure") {
        s.audio_start_failures_10m += numOrNull(r.n) ?? 0;
        if (!s.audio_start_failure_newest_ts || newer(ts, s.audio_start_failure_newest_ts)) s.audio_start_failure_newest_ts = ts;
      }
    }
    for (const s of out.values()) {
      s.power_events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || Date.parse(a.received_at) - Date.parse(b.received_at));
      s.last_power = s.power_events.length ? s.power_events[s.power_events.length - 1]! : null;
    }

    for (const r of recorder) {
      const s = snap(r.machine);
      const ts = toIso(r.ts);
      if (!s || !ts) continue;
      s.enrolled = true;
      const f = s.recorder_update_failures_24h;
      f.count += numOrNull(r.n) ?? 0;
      if (!f.newest_ts || newer(ts, f.newest_ts)) {
        f.newest_ts = ts;
        f.newest_line = r.line ? r.line.slice(0, 300) : null;
      }
    }

    // 4 — the newest row per machine of any kind in the last 7 days: enrolment and last-seen. Rides kiosk_health_events_machine_received_idx.
    const seen = (await sql`
      SELECT DISTINCT ON (k.machine) k.machine, k.received_at, k.kind
        FROM kiosk_health_events k
       WHERE k.machine = ANY(${keys}::text[])
         AND k.received_at BETWEEN ${hi}::timestamptz - interval '7 days' AND ${hi}::timestamptz
       ORDER BY k.machine, k.received_at DESC
    `) as unknown as SeenRow[];
    for (const r of seen) {
      const s = snap(r.machine);
      const rec = toIso(r.received_at);
      if (!s || !rec) continue;
      s.enrolled = true;
      if (newer(rec, s.last_seen_received_at)) s.last_seen_received_at = rec;
    }

    return { snapshots: out, ok: true };
  } catch (e) {
    console.warn(`[kiosk-health] read failed: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`);
    return { snapshots: new Map(), ok: false };
  }
}
