/**
 * lib/rooms-live/read.ts — every database read of the Rooms Live screen (SPEC-v1 §2). READS ONLY, Neon HTTP driver, bound parameters.
 * Each statement is bounded by the 8-room allow-list (room_id = ANY / machine = ANY) AND, for event tables, a time window AND a LIMIT. A static test
 * (tests/unit/rooms-live-sql.test.ts) holds this file to that. Column names are the ones the Steward sense and the bench code already use; INFERRED where noted.
 */
import { scopedOccupancy, type ScopedOccupancy } from "@/lib/steward/occupancy-read";
import type { WindowsDb } from "@/lib/encounter-windows/db";

export type Db = WindowsDb;
export const STATEMENT_TIMEOUT_MS = 5000;

const iso = (x: unknown): string => new Date(x as string | number | Date).toISOString();
export const istDateOf = (ms: number): string => new Date(ms + 19_800_000).toISOString().slice(0, 10);

export type ListenerRow = { room_id: string; last_poll_at: string | null; levels_at: string | null; mic_peak: number | null; mic_zero_ratio: number | null; recording_session_id: string | null; paused: boolean | null };
export type InstallRow = { room_id: string; hostname: string | null; state_flags: unknown; state_changed_at: string | null; input_device_name: string | null; input_devices: unknown };
export type SessionRow = { room_id: string; id: string; status: string; started_at: string; last_chunk_at: string | null };
export type LevelDbRow = { room_id: string; sampled_at: string; peak: number; zero_ratio: number | null };
export type HeartbeatRow = { machine: string; received_at: string };
export type ExtRow = { machine: string; ts: string; has_encounter: boolean };
export type WarehouseConsultRow = { machine: string; doctor_name: string | null; t_open: string; t_close: string | null };
export type StewardRow = { room_id: string; action: string; mode: string; ts: string };
/** v1.7: a decision row as the Steward lines need it (no params / why / inputs text: only the rule, action, mode, result and the session_died state word) */
export type StewardLogRow = { room_id: string; ts: string; rule: string; action: string; mode: string; result: string | null; pstate: string | null };

const num = (x: unknown): number | null => {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const tsOrNull = (x: unknown): string | null => (x === null || x === undefined ? null : iso(x));

export async function readListeners(db: Db, ids: readonly string[]): Promise<ListenerRow[]> {
  const rows = (await db`
    SELECT room_id, last_poll_at, levels_at, mic_peak, mic_zero_ratio, recording_session_id, paused
      FROM bench_listener
     WHERE room_id = ANY(${ids}::text[])
     LIMIT 20
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ room_id: String(r.room_id), last_poll_at: tsOrNull(r.last_poll_at), levels_at: tsOrNull(r.levels_at), mic_peak: num(r.mic_peak), mic_zero_ratio: num(r.mic_zero_ratio), recording_session_id: (r.recording_session_id as string | null) ?? null, paused: typeof r.paused === "boolean" ? r.paused : null }));
}

export async function readInstalls(db: Db, ids: readonly string[]): Promise<InstallRow[]> {
  const rows = (await db`
    SELECT room_id, hostname, state_flags, state_changed_at, input_device_name, input_devices
      FROM room_install
     WHERE room_id = ANY(${ids}::text[]) AND retired_at IS NULL AND enrolled_at IS NOT NULL
     LIMIT 30
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ room_id: String(r.room_id), hostname: (r.hostname as string | null) ?? null, state_flags: r.state_flags ?? null, state_changed_at: tsOrNull(r.state_changed_at), input_device_name: (r.input_device_name as string | null) ?? null, input_devices: r.input_devices ?? null }));
}

/** open sessions (recording or paused) of the last 20 h, each with its newest chunk of the last 30 min */
export async function readSessions(db: Db, ids: readonly string[], asOf: string): Promise<SessionRow[]> {
  const rows = (await db`
    SELECT s.room_id, s.id, s.status, s.started_at,
           (SELECT max(c.created_at) FROM bench_chunk c
             WHERE c.session_id = s.id AND c.created_at > ${asOf}::timestamptz - interval '30 minutes' AND c.created_at <= ${asOf}::timestamptz) AS last_chunk_at
      FROM bench_session s
     WHERE s.room_id = ANY(${ids}::text[]) AND s.status IN ('recording', 'paused')
       AND s.started_at > ${asOf}::timestamptz - interval '20 hours' AND s.started_at <= ${asOf}::timestamptz
     ORDER BY s.started_at DESC
     LIMIT 40
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ room_id: String(r.room_id), id: String(r.id), status: String(r.status), started_at: iso(r.started_at), last_chunk_at: tsOrNull(r.last_chunk_at) }));
}

/** recording level rows of the last 45 min (the baseline and the 20 s speech check); ~26 rows a minute per room, 8 rooms x 45 min ~ 9,400 */
export async function readLevels(db: Db, ids: readonly string[], asOf: string, istToday: string, istYesterday: string): Promise<LevelDbRow[]> {
  const rows = (await db`
    SELECT room_id, sampled_at, peak, zero_ratio
      FROM bench_level_sample
     WHERE room_id = ANY(${ids}::text[]) AND ist_date IN (${istToday}::date, ${istYesterday}::date)
       AND sampled_at > ${asOf}::timestamptz - interval '45 minutes' AND sampled_at <= ${asOf}::timestamptz
       AND session_open = true
     ORDER BY sampled_at DESC
     LIMIT 12000
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ room_id: String(r.room_id), sampled_at: iso(r.sampled_at), peak: Number(r.peak), zero_ratio: num(r.zero_ratio) }));
}

/** the Steward's newest actionable decision per room within 15 min */
export async function readSteward(db: Db, ids: readonly string[], asOf: string): Promise<StewardRow[]> {
  const rows = (await db`
    SELECT DISTINCT ON (d.room_id) d.room_id, d.action, d.mode, d.ts
      FROM steward_decisions d
     WHERE d.room_id = ANY(${ids}::text[]) AND d.ts > ${asOf}::timestamptz - interval '15 minutes' AND d.ts <= ${asOf}::timestamptz
       AND d.action NOT IN ('none', 'log_only')
     ORDER BY d.room_id, d.ts DESC, d.id DESC
     LIMIT 200
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ room_id: String(r.room_id), action: String(r.action), mode: String(r.mode), ts: iso(r.ts) }));
}

/** v1.7 S1: the four steward_config rows the status strip needs */
export async function readStewardConfig(db: Db, keys: readonly string[]): Promise<Array<{ key: string; value: unknown }>> {
  const rows = (await db`
    SELECT key, value FROM steward_config WHERE key = ANY(${keys}::text[]) LIMIT 10
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ key: String(r.key), value: r.value }));
}

const logRow = (r: Record<string, unknown>): StewardLogRow => ({
  room_id: String(r.room_id),
  ts: iso(r.ts),
  rule: String(r.rule),
  action: String(r.action),
  mode: String(r.mode),
  result: typeof r.result === "string" ? r.result : null,
  pstate: typeof r.pstate === "string" ? r.pstate : null,
});

/** v1.7 S4: each room's newest 20 non-ok decisions of the last 24 h (the Details view) */
export async function readStewardLog(db: Db, ids: readonly string[], asOf: string): Promise<StewardLogRow[]> {
  const rows = (await db`
    SELECT x.room_id, x.ts, x.rule, x.action, x.mode, x.result, x.pstate
      FROM (
        SELECT d.room_id, d.ts, d.id, d.rule, d.action, d.mode, d.result, d.params->>'state' AS pstate,
               row_number() OVER (PARTITION BY d.room_id ORDER BY d.ts DESC, d.id DESC) AS rn
          FROM steward_decisions d
         WHERE d.room_id = ANY(${ids}::text[]) AND d.ts > ${asOf}::timestamptz - interval '24 hours' AND d.ts <= ${asOf}::timestamptz
           AND d.rule <> 'ok'
      ) x
     WHERE x.rn <= 20
     ORDER BY x.ts DESC, x.id DESC
     LIMIT 400
  `) as Array<Record<string, unknown>>;
  return rows.map(logRow);
}

/** v1.7 S2 / S3: the rows that did (or would have done) something since IST midnight (at most 24 h), plus the device_missing_hold rows of the last hour */
export async function readStewardActions(db: Db, ids: readonly string[], asOf: string, sinceIso: string): Promise<StewardLogRow[]> {
  const rows = (await db`
    SELECT d.room_id, d.ts, d.rule, d.action, d.mode, d.result, d.params->>'state' AS pstate
      FROM steward_decisions d
     WHERE d.room_id = ANY(${ids}::text[]) AND d.ts > ${asOf}::timestamptz - interval '24 hours' AND d.ts <= ${asOf}::timestamptz
       AND ((d.action NOT IN ('none', 'log_only') AND (d.ts >= ${sinceIso}::timestamptz OR d.ts > ${asOf}::timestamptz - interval '60 minutes'))
         OR (d.rule = 'device_missing_hold' AND d.ts > ${asOf}::timestamptz - interval '60 minutes'))
     ORDER BY d.ts DESC, d.id DESC
     LIMIT 500
  `) as Array<Record<string, unknown>>;
  return rows.map(logRow);
}

/** the newest kiosk-health heartbeat per machine within 10 min */
export async function readHeartbeats(db: Db, keys: readonly string[], asOf: string): Promise<HeartbeatRow[]> {
  const rows = (await db`
    SELECT DISTINCT ON (k.machine) k.machine, k.received_at
      FROM kiosk_health_events k
     WHERE k.machine = ANY(${keys}::text[]) AND k.kind = 'heartbeat'
       AND k.received_at > ${asOf}::timestamptz - interval '10 minutes' AND k.received_at <= ${asOf}::timestamptz
     ORDER BY k.machine, k.received_at DESC
     LIMIT 200
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ machine: String(r.machine), received_at: iso(r.received_at) }));
}

/** the newest extension event per machine within 10 min: its age and whether an encounter is attached (the doctor's name comes from scopedOccupancy, F28). NO uid, email or cookie is selected. */
export async function readExt(db: Db, keys: readonly string[], asOf: string): Promise<ExtRow[]> {
  const rows = (await db`
    SELECT DISTINCT ON (p.machine) p.machine, p.ts, p.payload->>'encounter_id' AS enc
      FROM pulse_presence_events p
     WHERE p.source = 'ext' AND p.machine = ANY(${keys}::text[])
       AND p.ts > ${asOf}::timestamptz - interval '10 minutes' AND p.ts <= ${asOf}::timestamptz
     ORDER BY p.machine, p.ts DESC, p.id DESC
     LIMIT 200
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ machine: String(r.machine), ts: iso(r.ts), has_encounter: typeof r.enc === "string" && r.enc.trim().length > 0 }));
}

/** the newest warehouse-attributed consult per machine opened today (IST): the doctor Pulse itself recorded. Name and times only; no uid is selected. */
export async function readWarehouseConsults(db: Db, keys: readonly string[], asOf: string | number | Date): Promise<WarehouseConsultRow[]> {
  const A = new Date(asOf).getTime();
  const dayStart = new Date(Math.floor((A + 19_800_000) / 86_400_000) * 86_400_000 - 19_800_000).toISOString();
  const hi = new Date(A).toISOString();
  const rows = (await db`
    SELECT DISTINCT ON (w.machine) w.machine, w.consulting_doctor_name, w.t_open, w.t_close
      FROM eta_encounter_windows w
     WHERE w.attribution_source = 'warehouse' AND w.machine = ANY(${keys}::text[])
       AND w.t_open >= ${dayStart}::timestamptz AND w.t_open <= ${hi}::timestamptz
     ORDER BY w.machine, w.t_open DESC
     LIMIT 40
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ machine: String(r.machine), doctor_name: typeof r.consulting_doctor_name === "string" && r.consulting_doctor_name.trim() ? r.consulting_doctor_name.trim() : null, t_open: iso(r.t_open), t_close: tsOrNull(r.t_close) }));
}

export async function readOccupancy(db: Db, keys: readonly string[], asOf: string): Promise<ScopedOccupancy[]> {
  return scopedOccupancy(db, asOf, keys);
}

// ---------------------------------------------------------------------------
// the day strip (room detail): CONSULT's room_audio_state
// ---------------------------------------------------------------------------

export type DaySegment = { state: string; start: string; end: string };

/** One room, today (IST). The classifier writes in batches (lag ~1 h) and projects the last interval to the end of the day: clip to the newest written_at. */
export async function readDay(db: Db, roomId: string, istDay: string, asOfMs: number): Promise<{ as_of: string | null; segments: DaySegment[] }> {
  const rows = (await db`
    SELECT state, ts_start, ts_end, written_at
      FROM room_audio_state
     WHERE room_id = ${roomId}::text AND ist_day = ${istDay}::date
     ORDER BY ts_start
     LIMIT 400
  `) as Array<Record<string, unknown>>;
  if (rows.length === 0) return { as_of: null, segments: [] };
  const high = Math.min(asOfMs, Math.max(...rows.map((r) => new Date(r.written_at as string).getTime())));
  const segments: DaySegment[] = [];
  for (const r of rows) {
    const s = new Date(r.ts_start as string).getTime();
    const e = Math.min(new Date(r.ts_end as string).getTime(), high);
    if (e > s) segments.push({ state: String(r.state), start: new Date(s).toISOString(), end: new Date(e).toISOString() });
  }
  return { as_of: new Date(high).toISOString(), segments };
}
