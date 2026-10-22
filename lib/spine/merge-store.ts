/**
 * lib/spine/merge-store.ts — SPINE-P2 writer. runSpineMerge(now): for each room-day whose spine_signal rows changed, load its signals and prior encounters/links,
 * call the pure mergeSignals, and write the result in ONE statement (data-modifying CTEs: atomic, as the Neon HTTP driver has no interactive transaction).
 * Tables written: spine_encounter (upsert, never deleted: a merge loser is status `merged`), spine_link (a moved key goes inactive and a new active row is inserted),
 * spine_signal.encounter_id (the assignment), and one spine_tick row (kind `merge`) per live pass. Gated on spine_config `merge` (missing / malformed = off; kill_switch respected).
 *
 * WHICH ROOM-DAYS. A room-day is (room_id, IST date of t_open). It is merged when (A) a signal of it was received after the tick cursor (a keyset on
 * (max received_at, room_id, ist_date), kept in the last merge tick), (B) it has a signal not yet assigned to an encounter that was received since RECENT_MS before the CURSOR
 * (received_at is the transaction START, so a slow ingest commit can land under the cursor; anchored to the cursor, not to now, so a skipped or failed pass cannot lose it; the merge assigns
 * every signal it places, so a swept day drops out of B and a quiet system re-merges nothing; the rerun is idempotent and writes nothing), or (C) it still has an open signal inside the 72 h horizon (an open signal is capped
 * after CAP_MS with no new row). At most MAX_DAYS per pass; the cursor stops at the last A day processed before the first failure, so a failed day is retried.
 * A day that has failed MAX_FAILS passes in a row no longer holds the cursor (it would starve every newer day behind the MAX_DAYS limit): the cursor passes it, and its key and count
 * are kept in the merge tick (`failing`, `skipped_days`); it is retried whenever a later signal, the recent window or the open horizon selects it, and cleared by one success.
 *
 * ACOUSTIC IS OPTIONAL. Nothing here reads or requires an acoustic signal: the writer passes every stored signal to mergeSignals, and mergeSignals confirms a strong-anchored
 * group (pulse|pqm) with or without weak evidence (lib/spine/merge.ts M5, :584). A room-day with no acoustic signal is "acoustic unknown", never negative evidence.
 *
 * HELD (S2 R6). `held_frozen` is persisted as a COUNT in the spine_tick row: migration 0173 has no column for it and spine_encounter_flags_chk is frozen (a held group has no
 * encounter row to flag). The held groups are re-derivable by the pure merge from the stored signals, so no source_key list is stored.
 */
import { sql } from "@/lib/db";
import { parseMergeMode, type Mode } from "./config";
import { HORIZON_MS, istDate, mergeSignals } from "./merge";
import type { EncounterStatus, KeyKind, MergeResult, PriorEncounter, PriorLink, Proxy, SpinePrior, SpineSignal } from "./types";

type Q = (text: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;
const q = (): Q => sql as unknown as Q;

export const MERGE_VERSION = "p2-2";
export const MAX_DAYS = 200;
export const RECENT_MS = 10 * 60_000;
/** A room-day that failed this many passes in a row stops holding the cursor (3: one transient error or two bad deploys must not skip a day, a poison day must not hold the queue for long). */
export const MAX_FAILS = 3;
/** Cap on the failing-day list kept in the tick (oldest dropped); the list holds opaque room ids and IST dates only. */
export const MAX_FAILING = 100;

export async function readMergeMode(): Promise<Mode> {
  try {
    const rows = await q()("SELECT key, value FROM spine_config WHERE key IN ('kill_switch', 'merge')", []);
    return parseMergeMode(rows as Array<{ key: string; value: unknown }>);
  } catch {
    return "off";
  }
}

const ms = (v: unknown): number => Date.parse(String(v));
const obj = (v: unknown): Record<string, unknown> => {
  const x = typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v;
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
};

/** The key kinds mergeSignals reads from the TOP LEVEL of attrs (lib/spine/merge.ts keysOf). Stored attrs (0173 CHECK) keep them under attrs.ids, so they are lifted here; pulse_enc_id stays in ids (merge reads it there). */
const LIFTED = ["consult_uid", "consult_key", "pqm_uid", "caa_uid", "buddy_opaque", "window_id"] as const;
export function liftAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const ids = obj(attrs.ids);
  const out: Record<string, unknown> = { ...attrs };
  for (const k of LIFTED) if (typeof ids[k] === "string" && ids[k] !== "" && out[k] === undefined) out[k] = ids[k];
  return out;
}

export function toSignal(r: Record<string, unknown>): SpineSignal {
  return {
    proxy: String(r.proxy) as Proxy, source_key: String(r.source_key), source_rev: Number(r.source_rev),
    room_id: r.room_id == null ? null : String(r.room_id), t_open: ms(r.t_open), t_close: r.t_close == null ? null : ms(r.t_close),
    encounter_id: r.encounter_id == null ? null : String(r.encounter_id), attrs: liftAttrs(obj(r.attrs)),
  };
}
export function toPriorEncounter(r: Record<string, unknown>): PriorEncounter {
  return {
    encounter_id: String(r.encounter_id), ist_date: String(r.ist_date).slice(0, 10), room_id: String(r.room_id), t_open: ms(r.t_open), t_close: r.t_close == null ? ms(r.t_open) : ms(r.t_close),
    status: String(r.status) as EncounterStatus, merged_into: r.merged_into == null ? null : String(r.merged_into), anchor_proxy: String(r.anchor_proxy ?? "pulse") as Proxy,
    boundary_rev: Number(r.boundary_rev), reason: r.reason == null ? null : String(r.reason), created_at: ms(r.created_at),
  };
}

const DAY_SQL = `SELECT room_id, ((t_open AT TIME ZONE 'Asia/Kolkata')::date)::text AS ist_date, to_char(max(received_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS mx
  FROM spine_signal
 WHERE room_id IS NOT NULL AND (received_at >= least($1::timestamptz, $2::timestamptz) OR (t_close IS NULL AND t_open >= $3::timestamptz))
 GROUP BY 1, 2
HAVING (max(received_at), room_id, ((t_open AT TIME ZONE 'Asia/Kolkata')::date)::text) > ($1::timestamptz, $4::text, $5::text)
    OR bool_or(received_at >= $2::timestamptz AND encounter_id IS NULL)
    OR bool_or(t_close IS NULL AND t_open >= $3::timestamptz)
 ORDER BY max(received_at), room_id, 2
 LIMIT $6::int`;

export type Day = { room_id: string; ist_date: string; mx: string };
export type Cursor = { mx: string; room_id: string; ist_date: string };

/** The cursor kept in the newest merge tick, or null (first pass: everything stored). */
async function readCursor(): Promise<Cursor | null> {
  const rows = await q()("SELECT counts FROM spine_tick WHERE kind = 'merge' ORDER BY id DESC LIMIT 1", []);
  const c = obj(rows[0]?.counts);
  return typeof c.cursor_mx === "string" && typeof c.cursor_room === "string" && typeof c.cursor_date === "string"
    ? { mx: c.cursor_mx, room_id: c.cursor_room, ist_date: c.cursor_date } : null;
}

async function changedDays(now: number, cur: Cursor | null): Promise<Day[]> {
  const rows = await q()(DAY_SQL, [
    cur?.mx ?? "1970-01-01T00:00:00Z", cur ? new Date(Date.parse(cur.mx) - RECENT_MS).toISOString() : "1970-01-01T00:00:00Z", new Date(now - HORIZON_MS).toISOString(),
    cur?.room_id ?? "", cur?.ist_date ?? "0001-01-01", MAX_DAYS,
  ]);
  return rows.map((r) => ({ room_id: String(r.room_id), ist_date: String(r.ist_date), mx: String(r.mx) }));
}

async function loadDay(room_id: string, ist_date: string): Promise<{ signals: SpineSignal[]; prior: SpinePrior }> {
  const sigs = await q()(
    `SELECT proxy, source_key, source_rev, room_id, t_open, t_close, encounter_id, attrs FROM spine_signal
      WHERE room_id = $1::text AND t_open >= (($2::date)::timestamp AT TIME ZONE 'Asia/Kolkata') AND t_open < ((($2::date) + 1)::timestamp AT TIME ZONE 'Asia/Kolkata') ORDER BY proxy, source_key, source_rev`, [room_id, ist_date]);
  const encs = await q()(
    "SELECT encounter_id, ist_date::text AS ist_date, room_id, t_open, t_close, status, merged_into, anchor_proxy, boundary_rev, reason, created_at FROM spine_encounter WHERE room_id = $1::text AND ist_date = $2::date", [room_id, ist_date]);
  const links = await q()(
    "SELECT l.encounter_id, l.key_kind, l.value FROM spine_link l JOIN spine_encounter e ON e.encounter_id = l.encounter_id WHERE l.active AND e.room_id = $1::text AND e.ist_date = $2::date", [room_id, ist_date]);
  return {
    signals: sigs.map(toSignal),
    prior: { encounters: encs.map(toPriorEncounter), links: links.map((r): PriorLink => ({ encounter_id: String(r.encounter_id), key_kind: String(r.key_kind) as KeyKind, value: String(r.value) })) },
  };
}

/**
 * One statement = one transaction. The link move is ordered by data flow: `moved` deactivates the old active row and RETURNS the key, and the insert reads `moved`,
 * so the partial unique index spine_link_active_uq never sees two active rows for one (key_kind, value). A key with no active row yet is inserted directly;
 * a key already active under the same encounter is left alone. A move only takes a link from an encounter of THE SAME room-day ($4, $5): a key held by an encounter of another
 * day (a consult across IST midnight, a frozen encounter, I4) is left with its holder, so a re-merge of either day writes 0 rows. The first day to claim a cross-day key keeps it. spine_encounter is written only when a column differs (a rerun writes 0 rows).
 */
export const WRITE_SQL = `
WITH enc AS (
  INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, merged_into, anchor_proxy, boundary_rev, merge_version, reason, flags)
  SELECT x.encounter_id, x.ist_date, x.room_id, x.t_open, x.t_close, x.status, x.merged_into, x.anchor_proxy, x.boundary_rev, x.merge_version, x.reason, x.flags
    FROM jsonb_to_recordset($1::jsonb) AS x(encounter_id text, ist_date date, room_id text, t_open timestamptz, t_close timestamptz, status text, merged_into text, anchor_proxy text, boundary_rev int, merge_version text, reason text, flags text[])
  ON CONFLICT (encounter_id) DO UPDATE SET ist_date = EXCLUDED.ist_date, room_id = EXCLUDED.room_id, t_open = EXCLUDED.t_open, t_close = EXCLUDED.t_close, status = EXCLUDED.status,
         merged_into = EXCLUDED.merged_into, anchor_proxy = EXCLUDED.anchor_proxy, boundary_rev = EXCLUDED.boundary_rev, merge_version = EXCLUDED.merge_version, reason = EXCLUDED.reason, flags = EXCLUDED.flags, updated_at = now()
   WHERE (spine_encounter.ist_date, spine_encounter.room_id, spine_encounter.t_open, spine_encounter.t_close, spine_encounter.status, spine_encounter.merged_into, spine_encounter.anchor_proxy, spine_encounter.boundary_rev, spine_encounter.merge_version, spine_encounter.reason, spine_encounter.flags)
         IS DISTINCT FROM (EXCLUDED.ist_date, EXCLUDED.room_id, EXCLUDED.t_open, EXCLUDED.t_close, EXCLUDED.status, EXCLUDED.merged_into, EXCLUDED.anchor_proxy, EXCLUDED.boundary_rev, EXCLUDED.merge_version, EXCLUDED.reason, EXCLUDED.flags)
  RETURNING (xmax = 0) AS inserted, boundary_rev
), want AS (
  SELECT x.encounter_id, x.key_kind, x.value, x.basis FROM jsonb_to_recordset($2::jsonb) AS x(encounter_id text, key_kind text, value text, basis text)
), moved AS (
  UPDATE spine_link l SET active = false FROM want w
   WHERE l.active AND l.key_kind = w.key_kind AND l.value = w.value AND l.encounter_id <> w.encounter_id
     AND EXISTS (SELECT 1 FROM spine_encounter o WHERE o.encounter_id = l.encounter_id AND o.room_id = $4::text AND o.ist_date = $5::date)
  RETURNING w.encounter_id, w.key_kind, w.value, w.basis
), lnk AS (
  INSERT INTO spine_link (encounter_id, key_kind, value, basis)
  SELECT encounter_id, key_kind, value, basis FROM moved
  UNION ALL
  SELECT w.encounter_id, w.key_kind, w.value, w.basis FROM want w
   WHERE NOT EXISTS (SELECT 1 FROM spine_link l WHERE l.active AND l.key_kind = w.key_kind AND l.value = w.value)
  RETURNING 1
), asg AS (
  UPDATE spine_signal s SET encounter_id = a.encounter_id
    FROM jsonb_to_recordset($3::jsonb) AS a(proxy text, source_key text, source_rev int, encounter_id text)
   WHERE s.proxy = a.proxy AND s.source_key = a.source_key AND s.source_rev = a.source_rev AND s.encounter_id IS DISTINCT FROM a.encounter_id
  RETURNING 1
)
SELECT (SELECT count(*) FROM enc WHERE inserted)::int AS enc_inserted, (SELECT count(*) FROM enc WHERE NOT inserted)::int AS enc_updated,
       (SELECT count(*) FROM lnk)::int AS links_written, (SELECT count(*) FROM moved)::int AS links_moved, (SELECT count(*) FROM asg)::int AS assigned`;

export type WriteCounts = { enc_inserted: number; enc_updated: number; links_written: number; links_moved: number; assigned: number };

export async function writeMerge(r: MergeResult, room_id: string, ist_date: string): Promise<WriteCounts> {
  const encounters = r.encounters.map((e) => ({
    encounter_id: e.encounter_id, ist_date: e.ist_date, room_id: e.room_id, t_open: new Date(e.t_open).toISOString(), t_close: new Date(e.t_close).toISOString(), status: e.status,
    merged_into: e.merged_into, anchor_proxy: e.anchor_proxy, boundary_rev: e.boundary_rev, merge_version: e.merge_version, reason: e.reason, flags: e.flags,
  }));
  const res = await q()(WRITE_SQL, [JSON.stringify(encounters), JSON.stringify(r.links), JSON.stringify(r.assignments), room_id, ist_date]);
  const n = (k: string) => Number(res[0]?.[k] ?? 0);
  return { enc_inserted: n("enc_inserted"), enc_updated: n("enc_updated"), links_written: n("links_written"), links_moved: n("links_moved"), assigned: n("assigned") };
}

export type MergeCounts =
  | { skipped: "off" }
  | {
    mode: "shadow" | "live"; days: number; failed_days: number; skipped_days: number; encounters: number; enc_inserted: number; enc_updated: number; links_written: number; links_moved: number; assigned: number;
    held_frozen: number; unplaced: number; open_deferred: number; unattached: number; ambiguous: number;
  };

type Failing = Array<{ k: string; n: number }>;
const dayKey = (d: { room_id: string; ist_date: string }) => `${d.room_id}|${d.ist_date}`;
/** The consecutive-failure list kept in the newest merge tick (malformed = empty). */
async function readFailing(): Promise<Failing> {
  const rows = await q()("SELECT counts FROM spine_tick WHERE kind = 'merge' ORDER BY id DESC LIMIT 1", []);
  const f = obj(rows[0]?.counts).failing;
  return Array.isArray(f) ? f.filter((x): x is { k: string; n: number } => !!x && typeof x.k === "string" && Number.isFinite(x.n)).map((x) => ({ k: x.k, n: x.n })) : [];
}

export async function runSpineMerge(now: number): Promise<MergeCounts> {
  const mode = await readMergeMode();
  if (mode !== "shadow" && mode !== "live") return { skipped: "off" };
  const cur = await readCursor();
  const days = await changedDays(now, cur);
  const failing = new Map((await readFailing()).map((f) => [f.k, f.n]));
  const c = { mode, days: days.length, failed_days: 0, skipped_days: 0, encounters: 0, enc_inserted: 0, enc_updated: 0, links_written: 0, links_moved: 0, assigned: 0, held_frozen: 0, unplaced: 0, open_deferred: 0, unattached: 0, ambiguous: 0 };
  // A-days (beyond the cursor) form a prefix of `days`; the cursor moves to the last one processed before the first failure.
  const after = (d: Day) => !cur || d.mx > cur.mx || (d.mx === cur.mx && (d.room_id > cur.room_id || (d.room_id === cur.room_id && d.ist_date > cur.ist_date)));
  let next: Cursor | null = cur;
  let blocked = false;
  for (const d of days) {
    try {
      const { signals, prior } = await loadDay(d.room_id, d.ist_date);
      const r = mergeSignals(signals, MERGE_VERSION, prior, now);
      const w = await writeMerge(r, d.room_id, d.ist_date);
      c.encounters += r.encounters.length; c.enc_inserted += w.enc_inserted; c.enc_updated += w.enc_updated; c.links_written += w.links_written; c.links_moved += w.links_moved; c.assigned += w.assigned;
      c.held_frozen += r.held_frozen; c.unplaced += r.unplaced; c.open_deferred += r.open_deferred; c.unattached += r.unattached.length;
      c.ambiguous += r.encounters.filter((e) => e.flags.includes("ambiguous")).length;
      failing.delete(dayKey(d));
      if (!blocked && after(d)) next = { mx: d.mx, room_id: d.room_id, ist_date: d.ist_date };
    } catch (e) {
      c.failed_days += 1;
      const n = (failing.get(dayKey(d)) ?? 0) + 1;
      failing.delete(dayKey(d));
      failing.set(dayKey(d), n);   // re-insert: the Map stays ordered oldest-failure first
      if (n >= MAX_FAILS) {
        c.skipped_days += 1;
        if (!blocked && after(d)) next = { mx: d.mx, room_id: d.room_id, ist_date: d.ist_date };
      } else blocked = true;
      console.error("spine merge: room-day failed", (e as { code?: string }).code ?? "unknown");
    }
  }
  const failingList: Failing = [...failing].map(([k, n]) => ({ k, n })).slice(-MAX_FAILING);
  const tick = { ...c, failing: failingList, skipped_keys: failingList.filter((f) => f.n >= MAX_FAILS).map((f) => f.k), cursor_mx: next?.mx ?? null, cursor_room: next?.room_id ?? null, cursor_date: next?.ist_date ?? null };
  await q()("INSERT INTO spine_tick (kind, counts) VALUES ($1, $2::jsonb)", ["merge", JSON.stringify(tick)]);
  return c;
}

export { istDate };
