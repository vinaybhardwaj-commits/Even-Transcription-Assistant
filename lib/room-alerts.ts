/**
 * lib/room-alerts.ts — the READ DOOR for the Room Watchdog's alert outbox (migration 0119; design rev 3, eta-refuter #397/#404).
 *
 * A relay on the Mini pulls these rows and posts them to the bus. The app cannot push to the bus, so this is the only way an alert leaves.
 *
 * TWO SETS, NOT ONE LIST (F7). `new` is `id > after_id` in id order, capped at `limit`: the cap bounds ONLY new rows. `late` is
 * `id <= after_id AND created_at > now() - lookback`: rows a slower run committed AFTER a faster run's higher id was already read (ids are taken at
 * INSERT, not at COMMIT, F2). Folded into one capped list the already-delivered lookback rows would sort first and, in an alert storm, starve the
 * new ones. The relay dedupes `late` against what it has already posted.
 *
 * THE DATABASE'S CLOCK, EVERYWHERE (F5). The heartbeat comes back as an AGE computed by the database, never a timestamp for the relay to compare
 * with the Mini's clock, and the lookback window is `now()` on the database too. So no skew can false-alarm or hide a stopped cron.
 *
 * ABSENT IS NEVER HEALTHY (F9). No heartbeat row yet (a fresh deploy, an applied migration and no run) is `state: "none"`, its own answer, not a null the
 * relay could read as fine.
 */
import { sql } from "@/lib/db";

/** The watchdog cron runs every minute; a pulse older than this is a stopped cron. */
export const HEARTBEAT_STALE_AFTER_S = 300;
export const DEFAULT_LOOKBACK_MINUTES = 10;
export const MAX_LOOKBACK_MINUTES = 60;
export const DEFAULT_ALERT_LIMIT = 50;
export const MAX_ALERT_LIMIT = 100;
/** The late set is small by construction (a minute of overlap); this only bounds a pathological one, and says so. */
export const MAX_LATE_ROWS = 200;

export type RoomAlertRow = {
  id: number;
  created_at: string;
  kind: "offline" | "degraded" | "recovered" | "fleet_outage";
  room_ids: string[];
  room_name: string | null;
  status_from: string | null;
  status_to: string | null;
  subject: string;
  body: string;
};

export type WatchdogHeartbeat =
  | { state: "none" }
  | { state: "ok" | "stale"; age_s: number; last_ok: boolean; evaluated: number; last_error: string | null };

export type RoomAlertsAnswer = {
  ok: true;
  new: RoomAlertRow[];
  new_truncated: boolean;
  late: RoomAlertRow[];
  late_truncated: boolean;
  /** The newest id in the outbox, so a relay can tell an empty answer from a cursor that is ahead of the table. */
  head_id: number;
  heartbeat: WatchdogHeartbeat;
};

const asRow = (r: Record<string, unknown>): RoomAlertRow => ({
  id: Number(r.id),
  created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  kind: r.kind as RoomAlertRow["kind"],
  room_ids: Array.isArray(r.room_ids) ? (r.room_ids as string[]) : [],
  room_name: (r.room_name as string | null) ?? null,
  status_from: (r.status_from as string | null) ?? null,
  status_to: (r.status_to as string | null) ?? null,
  subject: String(r.subject),
  body: String(r.body),
});

/** PURE — the heartbeat state from the database's answer. No row is `none`; a failed last run or an old pulse is `stale`. */
export function heartbeatState(row: { age_s: number; last_ok: boolean; evaluated: number; last_error: string | null } | undefined): WatchdogHeartbeat {
  if (!row || !Number.isFinite(row.age_s)) return { state: "none" };
  const stale = !row.last_ok || row.age_s > HEARTBEAT_STALE_AFTER_S;
  return { state: stale ? "stale" : "ok", age_s: row.age_s, last_ok: row.last_ok, evaluated: row.evaluated, last_error: row.last_error };
}

export async function readRoomAlerts(opts: { afterId: number; lookbackMinutes: number; limit: number }): Promise<RoomAlertsAnswer> {
  const { afterId, lookbackMinutes, limit } = opts;
  const cols = "id, created_at, kind, room_ids, room_name, status_from, status_to, subject, body";
  void cols; // the column list is spelled out in each statement below: the sql tag takes no identifiers
  const fresh = (await sql`
    SELECT id, created_at, kind, room_ids, room_name, status_from, status_to, subject, body
      FROM room_alert_outbox
     WHERE id > ${afterId}
     ORDER BY id
     LIMIT ${limit + 1}
  `) as Array<Record<string, unknown>>;
  const late = (await sql`
    SELECT id, created_at, kind, room_ids, room_name, status_from, status_to, subject, body
      FROM room_alert_outbox
     WHERE id <= ${afterId}
       AND created_at > now() - make_interval(mins => ${lookbackMinutes})
     ORDER BY id
     LIMIT ${MAX_LATE_ROWS + 1}
  `) as Array<Record<string, unknown>>;
  const head = (await sql`SELECT COALESCE(MAX(id), 0)::bigint AS head_id FROM room_alert_outbox`) as Array<{ head_id: unknown }>;
  const hb = (await sql`
    SELECT EXTRACT(EPOCH FROM (now() - last_run_at))::int AS age_s, last_ok, evaluated, last_error
      FROM room_watchdog_heartbeat WHERE id = 1
  `) as Array<{ age_s: number; last_ok: boolean; evaluated: number; last_error: string | null }>;

  return {
    ok: true,
    new: fresh.slice(0, limit).map(asRow),
    new_truncated: fresh.length > limit,
    late: late.slice(0, MAX_LATE_ROWS).map(asRow),
    late_truncated: late.length > MAX_LATE_ROWS,
    head_id: Number(head[0]?.head_id ?? 0),
    heartbeat: heartbeatState(hb[0]),
  };
}
