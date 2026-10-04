/**
 * lib/encounter-windows/db.ts — the one DB adapter for encounter windows.
 *
 * TAGGED TEMPLATES, like every other reader in this codebase. `db` is a Neon HTTP query tag (lib/db's `sql`, or
 * any function with the same call and `.transaction` shape, which is how the unit tests inject a fake).
 * Neon HTTP gotchas honoured: no sql.unsafe(), no interactive transactions (the delete + insert go through
 * sql.transaction([...]) as ONE non-interactive transaction), timestamps come back as strings, bigint arrays as
 * string arrays, and every value is a bound parameter.
 *
 * refreshWindows(db, {from, to}) recomputes the range idempotently: delete rows with from <= t_open < to, insert
 * the fresh ones, in a single transaction. The insert is ON CONFLICT (consult_key) DO UPDATE as a belt: a consult
 * whose t_open drifted across the range edge between two runs would otherwise hit the unique key.
 */
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { computeWindowsDetailed } from "./compute";
import {
  normalizeHostname,
  type Attribution,
  type CloseReason,
  type ComputeSummary,
  type EncounterWindowRow,
  type PresenceEvent,
  type Quality,
  type RoomRef,
} from "./types";

export type WindowsDb = NeonQueryFunction<false, false>;

const LOOKBACK_H = 72; // occupancy lookback (matches the resolver default)
const TAIL_MS = 2 * 3_600_000; // events after `to` that can still close a consult opened before it

const iso = (x: unknown): string => new Date(x as string | number | Date).toISOString();
const isoOrNull = (x: unknown): string | null => (x == null ? null : iso(x));

/** machine (extension machine_id spelling) -> room, from the live room_install rows. */
export async function loadCrosswalk(db: WindowsDb): Promise<Map<string, RoomRef>> {
  const rows = (await db`
    SELECT i.hostname, i.room_id, r.slug
      FROM room_install i
      JOIN room r ON r.id = i.room_id
     WHERE i.retired_at IS NULL AND i.hostname IS NOT NULL
  `) as unknown as Array<{ hostname: string; room_id: string; slug: string | null }>;
  const m = new Map<string, RoomRef>();
  for (const r of rows) m.set(normalizeHostname(r.hostname), { room_id: r.room_id, slug: r.slug });
  return m;
}

/**
 * The events the resolver needs: ext + resolver rows, background heartbeats dropped (they never count as
 * activity), from `from - lookback` to `to + 2h`.
 */
export async function fetchEvents(db: WindowsDb, from: Date, to: Date): Promise<PresenceEvent[]> {
  const lo = new Date(from.getTime() - LOOKBACK_H * 3_600_000).toISOString();
  const hi = new Date(to.getTime() + TAIL_MS).toISOString();
  const rows = (await db`
    SELECT id, source, machine, event, ts,
           payload->>'doctor_uid'       AS uid,
           payload->>'display_name'     AS dn,
           payload->>'encounter_id'     AS enc,
           payload->>'prescription_ref' AS rx,
           payload->>'tab_focus'        AS focus,
           payload->>'reason'           AS reason
      FROM pulse_presence_events
     WHERE source IN ('ext', 'resolver')
       AND machine IS NOT NULL
       AND ts >= ${lo}::timestamptz AND ts <= ${hi}::timestamptz
       AND (event <> 'heartbeat' OR payload->>'tab_focus' = 'true')
     ORDER BY ts, id
  `) as unknown as Array<PresenceEvent>;
  return rows;
}

export type RefreshResult = {
  range: { from: string; to: string };
  events: number;
  deleted: number;
  inserted: number;
  summary: ComputeSummary;
};

/** Recompute windows with t_open in [from, to). Idempotent. */
export async function refreshWindows(
  db: WindowsDb,
  range: { from: string | number | Date; to: string | number | Date },
  opts: { asOf?: string | number | Date } = {},
): Promise<RefreshResult> {
  const from = new Date(range.from);
  const to = new Date(range.to);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw new Error("refreshWindows: bad range");

  const [crosswalk, events] = await Promise.all([loadCrosswalk(db), fetchEvents(db, from, to)]);
  const { rows, summary } = computeWindowsDetailed(events, { from, to, asOf: opts.asOf ?? Date.now(), crosswalk });

  const del = db`
    DELETE FROM eta_encounter_windows
     WHERE t_open >= ${from.toISOString()}::timestamptz AND t_open < ${to.toISOString()}::timestamptz
     RETURNING 1
  `;
  let results: unknown[];
  if (rows.length === 0) {
    results = (await db.transaction([del])) as unknown[];
  } else {
    const ins = db`
      INSERT INTO eta_encounter_windows
        (consult_key, consult_uid, prescription_ref, machine, room_id, room_slug, doctor_uid, display_name,
         attribution, t_open, t_close, close_reason, quality, reopen_count, source_event_ids, resolver_version, computed_at)
      SELECT r->>'consult_key', r->>'consult_uid', r->>'prescription_ref', r->>'machine', r->>'room_id', r->>'room_slug',
             r->>'doctor_uid', r->>'display_name', r->>'attribution',
             (r->>'t_open')::timestamptz, (r->>'t_close')::timestamptz, r->>'close_reason', r->>'quality',
             (r->>'reopen_count')::int,
             COALESCE((SELECT array_agg(x::bigint ORDER BY x::bigint) FROM jsonb_array_elements_text(r->'source_event_ids') AS x), '{}'::bigint[]),
             r->>'resolver_version', now()
        FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) AS r
      ON CONFLICT (consult_key) DO UPDATE SET
        consult_uid = EXCLUDED.consult_uid, prescription_ref = EXCLUDED.prescription_ref, machine = EXCLUDED.machine,
        room_id = EXCLUDED.room_id, room_slug = EXCLUDED.room_slug, doctor_uid = EXCLUDED.doctor_uid,
        display_name = EXCLUDED.display_name, attribution = EXCLUDED.attribution, t_open = EXCLUDED.t_open,
        t_close = EXCLUDED.t_close, close_reason = EXCLUDED.close_reason, quality = EXCLUDED.quality,
        reopen_count = EXCLUDED.reopen_count, source_event_ids = EXCLUDED.source_event_ids,
        resolver_version = EXCLUDED.resolver_version, computed_at = EXCLUDED.computed_at
      RETURNING 1
    `;
    results = (await db.transaction([del, ins])) as unknown[];
  }
  const count = (i: number) => (Array.isArray(results[i]) ? (results[i] as unknown[]).length : 0);
  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    events: events.length,
    deleted: count(0),
    inserted: rows.length === 0 ? 0 : count(1),
    summary,
  };
}

export type WindowFilter = {
  room_id?: string | null;
  doctor_uid?: string | null;
  from?: string | null;
  to?: string | null;
  quality?: string | null;
  limit?: number;
};

/** Read rows ordered by t_open. Only what the table holds: ids, times, doctor_uid/display_name, labels. */
export async function queryWindows(db: WindowsDb, f: WindowFilter): Promise<EncounterWindowRow[]> {
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? 1000), 1), 5000);
  const rows = (await db`
    SELECT consult_key, consult_uid, prescription_ref, machine, room_id, room_slug, doctor_uid, display_name,
           attribution, t_open, t_close, close_reason, quality, reopen_count, source_event_ids, resolver_version
      FROM eta_encounter_windows
     WHERE (${f.room_id ?? null}::text IS NULL OR room_id = ${f.room_id ?? null}::text)
       AND (${f.doctor_uid ?? null}::text IS NULL OR doctor_uid = ${f.doctor_uid ?? null}::text)
       AND (${f.from ?? null}::timestamptz IS NULL OR t_open >= ${f.from ?? null}::timestamptz)
       AND (${f.to ?? null}::timestamptz IS NULL OR t_open < ${f.to ?? null}::timestamptz)
       AND (${f.quality ?? null}::text IS NULL OR quality = ${f.quality ?? null}::text)
     ORDER BY t_open, id
     LIMIT ${limit}
  `) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    consult_key: String(r.consult_key),
    consult_uid: (r.consult_uid as string | null) ?? null,
    prescription_ref: (r.prescription_ref as string | null) ?? null,
    machine: String(r.machine),
    room_id: (r.room_id as string | null) ?? null,
    room_slug: (r.room_slug as string | null) ?? null,
    doctor_uid: (r.doctor_uid as string | null) ?? null,
    display_name: (r.display_name as string | null) ?? null,
    attribution: r.attribution as Attribution,
    t_open: iso(r.t_open),
    t_close: isoOrNull(r.t_close),
    close_reason: r.close_reason as CloseReason,
    quality: r.quality as Quality,
    reopen_count: Number(r.reopen_count ?? 0),
    source_event_ids: Array.isArray(r.source_event_ids) ? (r.source_event_ids as unknown[]).map(Number) : [],
    resolver_version: String(r.resolver_version),
  }));
}
