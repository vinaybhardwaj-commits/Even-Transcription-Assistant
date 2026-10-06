/**
 * lib/encounter-windows/db.ts — the one DB adapter for encounter windows.
 *
 * TAGGED TEMPLATES, like every other reader in this codebase. `db` is a Neon HTTP query tag (lib/db's `sql`, or
 * any function with the same call and `.transaction` shape, which is how the unit tests inject a fake).
 * Neon HTTP gotchas honoured: no sql.unsafe(), no interactive transactions (the delete + insert go through
 * sql.transaction([...]) as ONE non-interactive transaction), timestamps come back as strings, bigint arrays as
 * string arrays, and every value is a bound parameter.
 *
 * refreshWindows(db, {from, to}) recomputes the range idempotently: delete the rows with from <= t_open < to that the
 * fresh compute no longer produces, upsert the fresh ones, in a single transaction. Rows that survive keep their
 * warehouse_* columns (0124) — see PRESERVING THE WAREHOUSE COLUMNS below. consult_key is `${encounter_id}@${machine}`, a pure function of the
 * consult, so the insert is ON CONFLICT (consult_key) DO UPDATE: a consult whose t_open drifted across the range
 * edge between two runs updates its own row and can never touch another consult's.
 * refreshWindowsByDay splits a long range at IST midnights and runs one refreshWindows (one transaction) per day;
 * every day reads events up to the end of the whole range + 2 h (an explicit close has no time limit in the resolver,
 * so a pre-midnight consult must see a late close). A long backfill therefore reads more per day than a short one.
 *
 * EVENT LOAD. Per range the adapter reads events from (the IST midnight before `from`) - 24 h to `eventsTo` + 2 h
 * (`eventsTo` defaults to `to`), not a
 * flat 72 h: the nightly cutoff means a stream's presence can never depend on activity older than the previous IST
 * midnight, and 24 h before that covers a login/logout control event.
 *
 * FOCUS FILTER. Background heartbeats (tab_focus false) are dropped at the database, EXCEPT where tab_focus flips
 * from the previous non-logout ext event of the same (machine, doctor_uid) stream. The occupancy tiebreak reads each
 * stream's LATEST tab_focus flag; a stream that was focused and then backgrounded must read unfocused, which needs
 * the flip event. Repeats of the same flag carry nothing the resolver reads, so the latest kept event always has
 * the same flag as the latest real event. keepFocusFlips() in ./filter.ts is the same rule in TypeScript.
 *
 * LOGIN RULE ROWS (6 Oct 2026). The resolver's login rule (occupancy.ts) reads the poller's idle_s around each ext login. After the ext query above, if it
 * returned any ext `login`, ONE more query reads the poller rows: a window [login - 5 min, login + 50 min] (capped at the read end) per login, on the login's Mac
 * under the canonical key and the pre-5-Oct short key, every login, overlapping windows merged; more than 400 windows split the read by IST day (F12). The windows are bound parameters (three arrays, unnest) and a
 * LATERAL subquery (with an ORDER BY, which stops the planner flattening it back into a hash join over a table scan) runs one (machine, ts) index range scan per window,
 * so the transfer is ~23 rows per login (a poll every ~2.4 min) — about 1k rows for 46 logins, not every poller row of the read range of every Mac with a login; source
 * 'poller' with an idle_s; machine, ts and idle_s only. The rows are then matched to the logins again in TypeScript (pollerRowsNearLogins). No login -> no second
 * query, so a read with no logins issues exactly the one query it always did. identity_stale rows are not heartbeats: the filter always keeps them.
 *
 * Extension 0.1.1 fields (page, inst, cookie_uid) ride on whatever rows are kept. A background profile's heartbeats are dropped, so the
 * `instances` count taken from this load can undercount a quiet background profile whose only kept rows are its active/idle/encounter events;
 * the tools/pulse-watch resolver reads every row and counts exactly. The count is informational either way.
 */
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { computeWindowsDetailed } from "./compute";
import { pollerRowsNearLogins, POLL_KEEP_AFTER_LOGIN_MS, POLL_KEEP_BEFORE_LOGIN_MS } from "./filter";
import { canonicalPollerKey, legacyPollerKey } from "./machine-keys";
import {
  normalizeHostname,
  type Attribution,
  type CloseReason,
  type ComputeSummary,
  type AttributionSource,
  type EncounterWindowRead,
  type PresenceEvent,
  type Quality,
  type RoomRef,
} from "./types";

export type WindowsDb = NeonQueryFunction<false, false>;

const DAY_MS = 86_400_000;
const IST_MS = 19_800_000;
const TAIL_MS = 2 * 3_600_000; // events after `to` that can still close a consult opened before it
const PRE_MIDNIGHT_MS = DAY_MS; // control events (login/logout) before the IST midnight preceding `from`

/** The IST midnight at or before t, as epoch ms. */
export const istMidnightAtOrBefore = (t: number): number => Math.floor((t + IST_MS) / DAY_MS) * DAY_MS - IST_MS;

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
 * The events the resolver needs: ext + resolver rows from (IST midnight before `from`) - 24 h to `to` + 2 h, with
 * background heartbeats dropped except focus flips (see the FOCUS FILTER note in the file header).
 */
export async function fetchEvents(db: WindowsDb, from: Date, to: Date): Promise<PresenceEvent[]> {
  const lo = new Date(istMidnightAtOrBefore(from.getTime()) - PRE_MIDNIGHT_MS).toISOString();
  const hi = new Date(to.getTime() + TAIL_MS).toISOString();
  const rows = (await db`
    WITH base AS (
      SELECT id, source, machine, event, ts,
             payload->>'doctor_uid'       AS uid,
             payload->>'display_name'     AS dn,
             payload->>'encounter_id'     AS enc,
             payload->>'prescription_ref' AS rx,
             payload->>'tab_focus'        AS focus,
             payload->>'reason'           AS reason,
             payload->>'page_name'        AS page,
             payload->>'instance_id'      AS inst,
             payload->>'cookie_uid'       AS cookie_uid
        FROM pulse_presence_events
       WHERE source IN ('ext', 'resolver')
         AND machine IS NOT NULL
         AND ts >= ${lo}::timestamptz AND ts <= ${hi}::timestamptz
    ),
    flips AS (
      SELECT id FROM (
        SELECT id, (focus = 'true') AS f,
               LAG(focus = 'true') OVER (PARTITION BY machine, uid ORDER BY ts, id) AS prev_f
          FROM base
         WHERE source = 'ext' AND event <> 'logout'
      ) s
      WHERE prev_f IS DISTINCT FROM f
    )
    SELECT id, source, machine, event, ts, uid, dn, enc, rx, focus, reason, page, inst, cookie_uid
      FROM base
     WHERE event <> 'heartbeat' OR focus = 'true' OR id IN (SELECT id FROM flips)
     ORDER BY ts, id
  `) as unknown as Array<PresenceEvent>;
  return withLoginPollerRows(db, rows, to.getTime() + TAIL_MS);
}

/** At most this many windows go in ONE poller query; a read with more is split by IST day (then by this cap within a day), so no login loses its poller evidence. */
export const MAX_LOGIN_WINDOWS = 400;

type PollerWindow = { machine: string; lo: number; hi: number };

/** The poller windows of the logins in `ext`: one per login on its Mac (canonical key + the pre-5-Oct short key), overlapping windows of one key merged. */
export function loginPollerWindows(ext: PresenceEvent[], hiMs: number): PollerWindow[] {
  const byMachine = new Map<string, Array<[number, number]>>();
  for (const e of ext) {
    if (e.source !== "ext" || e.event !== "login" || !e.machine) continue;
    const t = new Date(e.ts as string | number | Date).getTime();
    if (!Number.isFinite(t)) continue;
    const w = byMachine.get(e.machine) ?? [];
    w.push([t - POLL_KEEP_BEFORE_LOGIN_MS, Math.min(t + POLL_KEEP_AFTER_LOGIN_MS, hiMs)]);
    byMachine.set(e.machine, w);
  }
  const out: PollerWindow[] = [];
  for (const [m, ws] of byMachine) {
    ws.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const w of ws) {
      const last = merged[merged.length - 1];
      if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
      else merged.push([w[0], w[1]]);
    }
    const legacy = legacyPollerKey(m);
    for (const key of legacy ? [m, legacy] : [m]) for (const [lo, hi] of merged) out.push({ machine: key, lo, hi });
  }
  return out;
}

/** F12: one query's worth of windows per chunk — all of them when they fit the cap, else one chunk per IST day of the window's start (split again at the cap). */
export function chunkPollerWindows(windows: PollerWindow[], max = MAX_LOGIN_WINDOWS): PollerWindow[][] {
  if (windows.length === 0) return [];
  if (windows.length <= max) return [windows];
  const days = new Map<number, PollerWindow[]>();
  for (const w of windows) {
    const d = istMidnightAtOrBefore(w.lo);
    const list = days.get(d);
    if (list) list.push(w);
    else days.set(d, [w]);
  }
  const out: PollerWindow[][] = [];
  for (const d of [...days.keys()].sort((x, y) => x - y)) {
    const ws = days.get(d)!;
    for (let i = 0; i < ws.length; i += max) out.push(ws.slice(i, i + max));
  }
  return out;
}

/** Append the poller rows the login rule needs (see LOGIN RULE ROWS above). Pure pass-through when `ext` holds no login. */
export async function withLoginPollerRows(db: WindowsDb, ext: PresenceEvent[], hiMs: number): Promise<PresenceEvent[]> {
  const windows = loginPollerWindows(ext, hiMs);
  if (windows.length === 0) return ext;
  type Raw = { machine: string; ts: string | number | Date; idle_s: string | number | null };
  const chunks = await Promise.all(
    chunkPollerWindows(windows).map(async (ws): Promise<Raw[]> => {
      const machines = ws.map((w) => w.machine);
      const los = ws.map((w) => new Date(w.lo).toISOString());
      const his = ws.map((w) => new Date(w.hi).toISOString());
      return (await db`
    WITH w AS (SELECT * FROM unnest(${machines}::text[], ${los}::timestamptz[], ${his}::timestamptz[]) AS t(machine, lo, hi))
    SELECT p.machine, p.ts, p.idle_s
      FROM w
      JOIN LATERAL (
        SELECT e.machine, e.ts, e.payload->>'idle_s' AS idle_s
          FROM pulse_presence_events e
         WHERE e.machine = w.machine AND e.ts BETWEEN w.lo AND w.hi
           AND e.source = 'poller'
           AND e.payload ? 'idle_s'
         ORDER BY e.ts
      ) p ON true
  `) as unknown as Raw[];
    }),
  );
  const raw = chunks.flat();
  // only machine, ts and idle_s are read; ids are synthetic (negative: a poller row sorts before an ext row at the same instant and is never a window's source id)
  const poll: PresenceEvent[] = raw.map((r, i) => ({ id: -(i + 1), source: "poller", machine: canonicalPollerKey(r.machine), event: "ok", ts: r.ts, idle_s: r.idle_s }));
  const near = pollerRowsNearLogins(ext, poll);
  if (near.length === 0) return ext;
  const t = (e: PresenceEvent) => new Date(e.ts as string | number | Date).getTime();
  return [...ext, ...near].sort((a, b) => t(a) - t(b) || Number(a.id) - Number(b.id));
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
  opts: { asOf?: string | number | Date; eventsTo?: string | number | Date } = {},
): Promise<RefreshResult> {
  const from = new Date(range.from);
  const to = new Date(range.to);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw new Error("refreshWindows: bad range");
  // Events are read up to `eventsTo` (default: the range end) + 2 h. A day chunk of a longer run passes the end of the
  // WHOLE run, so a consult opened just before midnight still sees an explicit close or reopen that lands after it.
  const readTo = opts.eventsTo === undefined ? to : new Date(Math.max(new Date(opts.eventsTo).getTime(), to.getTime()));

  const [crosswalk, events] = await Promise.all([loadCrosswalk(db), fetchEvents(db, from, readTo)]);
  const { rows, summary } = computeWindowsDetailed(events, { from, to, asOf: opts.asOf ?? Date.now(), crosswalk });

  // PRESERVING THE WAREHOUSE COLUMNS (0124). The delete used to take every row in the range, so a refresh threw away
  // each row's warehouse_* / consulting_* columns and the insert rebuilt them blank. It now removes only the rows the
  // fresh compute no longer produces (a consult that vanished) and leaves the rest for the upsert below, whose
  // DO UPDATE never names the warehouse_* columns, so they stay as written by lib/encounter-windows/warehouse-attribution.ts.
  const keys = rows.map((r) => r.consult_key);
  const del = db`
    DELETE FROM eta_encounter_windows
     WHERE t_open >= ${from.toISOString()}::timestamptz AND t_open < ${to.toISOString()}::timestamptz
       AND consult_key <> ALL(${keys}::text[])
     RETURNING 1
  `;
  let results: unknown[];
  if (rows.length === 0) {
    results = (await db.transaction([del])) as unknown[];
  } else {
    // consulting_* / attribution_source / doctor_mismatch: the INSERT side seeds them from the extension (precedence
    // rule 2/3 of migration 0124); the DO UPDATE side re-derives them against the STORED warehouse doctor, so a row
    // already answered by the warehouse keeps reading 'warehouse' and its mismatch follows the fresh extension doctor.
    const ins = db`
      INSERT INTO eta_encounter_windows
        (consult_key, consult_uid, prescription_ref, machine, room_id, room_slug, doctor_uid, display_name,
         attribution, t_open, t_close, close_reason, quality, reopen_count, source_event_ids, resolver_version, computed_at,
         consulting_doctor_uid, consulting_doctor_name, attribution_source, doctor_mismatch)
      SELECT r->>'consult_key', r->>'consult_uid', r->>'prescription_ref', r->>'machine', r->>'room_id', r->>'room_slug',
             r->>'doctor_uid', r->>'display_name', r->>'attribution',
             (r->>'t_open')::timestamptz, (r->>'t_close')::timestamptz, r->>'close_reason', r->>'quality',
             (r->>'reopen_count')::int,
             COALESCE((SELECT array_agg(x::bigint ORDER BY x::bigint) FROM jsonb_array_elements_text(r->'source_event_ids') AS x), '{}'::bigint[]),
             r->>'resolver_version', now(),
             r->>'doctor_uid', r->>'display_name',
             CASE WHEN r->>'doctor_uid' IS NOT NULL THEN 'extension' ELSE 'none' END,
             false
        FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) AS r
      ON CONFLICT (consult_key) DO UPDATE SET
        consult_uid = EXCLUDED.consult_uid, prescription_ref = EXCLUDED.prescription_ref, machine = EXCLUDED.machine,
        room_id = EXCLUDED.room_id, room_slug = EXCLUDED.room_slug, doctor_uid = EXCLUDED.doctor_uid,
        display_name = EXCLUDED.display_name, attribution = EXCLUDED.attribution, t_open = EXCLUDED.t_open,
        t_close = EXCLUDED.t_close, close_reason = EXCLUDED.close_reason, quality = EXCLUDED.quality,
        reopen_count = EXCLUDED.reopen_count, source_event_ids = EXCLUDED.source_event_ids,
        resolver_version = EXCLUDED.resolver_version, computed_at = EXCLUDED.computed_at,
        consulting_doctor_uid = CASE WHEN eta_encounter_windows.warehouse_doctor_uid IS NOT NULL
                                     THEN eta_encounter_windows.warehouse_doctor_uid ELSE EXCLUDED.consulting_doctor_uid END,
        consulting_doctor_name = CASE WHEN eta_encounter_windows.warehouse_doctor_uid IS NOT NULL
                                      THEN eta_encounter_windows.consulting_doctor_name ELSE EXCLUDED.consulting_doctor_name END,
        attribution_source = CASE WHEN eta_encounter_windows.warehouse_doctor_uid IS NOT NULL
                                  THEN 'warehouse' ELSE EXCLUDED.attribution_source END,
        doctor_mismatch = (eta_encounter_windows.warehouse_doctor_uid IS NOT NULL AND EXCLUDED.doctor_uid IS NOT NULL
                           AND eta_encounter_windows.warehouse_doctor_uid <> EXCLUDED.doctor_uid)
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

export type RefreshByDayResult = {
  range: { from: string; to: string };
  chunks: number;
  /** false when the time budget ran out; resume with next_from. */
  complete: boolean;
  next_from: string | null;
  events: number;
  deleted: number;
  inserted: number;
  summary: ComputeSummary;
};

const emptySummary = (): ComputeSummary => ({
  consults: 0,
  unpaired_refs: 0,
  by_quality: { clean: 0, ambiguous: 0, multi_doctor: 0, unclosed: 0, unattributed: 0 },
  by_attribution: { rows: 0, occupant: 0, none: 0 },
  by_close_reason: {},
});

function addSummary(a: ComputeSummary, b: ComputeSummary): void {
  a.consults += b.consults;
  a.unpaired_refs += b.unpaired_refs;
  for (const k of Object.keys(b.by_quality) as Quality[]) a.by_quality[k] += b.by_quality[k];
  for (const k of Object.keys(b.by_attribution) as Attribution[]) a.by_attribution[k] += b.by_attribution[k];
  for (const [k, v] of Object.entries(b.by_close_reason)) a.by_close_reason[k] = (a.by_close_reason[k] ?? 0) + v;
}

/** [from, to) cut at every IST midnight, oldest first. */
export function splitByIstDay(from: number, to: number): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  let a = from;
  while (a < to) {
    const next = Math.min(istMidnightAtOrBefore(a) + DAY_MS, to);
    out.push({ from: a, to: next });
    a = next;
  }
  return out;
}

/**
 * refreshWindows per IST day, oldest first: each day is its own fetch and its own transaction, so a long backfill
 * never holds one huge transaction and a failure part-way leaves earlier days committed. With deadlineMs set, stops
 * before starting a day that would begin after the deadline and returns complete=false and next_from.
 */
export async function refreshWindowsByDay(
  db: WindowsDb,
  range: { from: string | number | Date; to: string | number | Date },
  opts: { asOf?: string | number | Date; deadlineMs?: number } = {},
): Promise<RefreshByDayResult> {
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error("refreshWindowsByDay: bad range");
  const summary = emptySummary();
  let events = 0;
  let deleted = 0;
  let inserted = 0;
  let chunks = 0;
  let nextFrom: string | null = null;
  for (const c of splitByIstDay(from, to)) {
    if (opts.deadlineMs !== undefined && chunks > 0 && Date.now() > opts.deadlineMs) {
      nextFrom = new Date(c.from).toISOString();
      break;
    }
    // every day reads events to the end of the WHOLE range (+ 2 h): see refreshWindows
    const r = await refreshWindows(db, { from: c.from, to: c.to }, { eventsTo: to, ...(opts.asOf === undefined ? {} : { asOf: opts.asOf }) });
    chunks++;
    events += r.events;
    deleted += r.deleted;
    inserted += r.inserted;
    addSummary(summary, r.summary);
  }
  return {
    range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    chunks,
    complete: nextFrom === null,
    next_from: nextFrom,
    events,
    deleted,
    inserted,
    summary,
  };
}

export type WindowFilter = {
  room_id?: string | null;
  doctor_uid?: string | null;
  from?: string | null;
  to?: string | null;
  quality?: string | null;
  /** true: only rows where the warehouse and the extension name different doctors; false: only rows where they do not; null/absent: both. */
  mismatch?: boolean | null;
  limit?: number;
};

/**
 * Read rows ordered by t_open. Only what the table holds: ids, times, doctor uids/names (extension and warehouse), labels.
 * `doctor_uid` matches the doctor to REPORT (consulting_doctor_uid) OR the extension's doctor_uid, so a doctor's list holds the
 * consults Pulse says were theirs and the ones the extension saw them logged in for; `mismatch` true/false filters doctor_mismatch.
 */
export async function queryWindows(db: WindowsDb, f: WindowFilter): Promise<EncounterWindowRead[]> {
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? 1000), 1), 5000);
  const rows = (await db`
    SELECT consult_key, consult_uid, prescription_ref, machine, room_id, room_slug, doctor_uid, display_name,
           attribution, t_open, t_close, close_reason, quality, reopen_count, source_event_ids, resolver_version,
           warehouse_doctor_uid, warehouse_doctor_name, warehouse_checked_at, warehouse_prescription_uid,
           consulting_doctor_uid, consulting_doctor_name, attribution_source, doctor_mismatch
      FROM eta_encounter_windows
     WHERE (${f.room_id ?? null}::text IS NULL OR room_id = ${f.room_id ?? null}::text)
       AND (${f.doctor_uid ?? null}::text IS NULL OR consulting_doctor_uid = ${f.doctor_uid ?? null}::text OR doctor_uid = ${f.doctor_uid ?? null}::text)
       AND (${f.from ?? null}::timestamptz IS NULL OR t_open >= ${f.from ?? null}::timestamptz)
       AND (${f.to ?? null}::timestamptz IS NULL OR t_open < ${f.to ?? null}::timestamptz)
       AND (${f.quality ?? null}::text IS NULL OR quality = ${f.quality ?? null}::text)
       AND (${f.mismatch ?? null}::boolean IS NULL OR doctor_mismatch = ${f.mismatch ?? null}::boolean)
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
    warehouse_doctor_uid: (r.warehouse_doctor_uid as string | null) ?? null,
    warehouse_doctor_name: (r.warehouse_doctor_name as string | null) ?? null,
    warehouse_checked_at: isoOrNull(r.warehouse_checked_at),
    warehouse_prescription_uid: (r.warehouse_prescription_uid as string | null) ?? null,
    consulting_doctor_uid: (r.consulting_doctor_uid as string | null) ?? null,
    consulting_doctor_name: (r.consulting_doctor_name as string | null) ?? null,
    attribution_source: (r.attribution_source as AttributionSource | null) ?? null,
    doctor_mismatch: r.doctor_mismatch === true,
  }));
}
