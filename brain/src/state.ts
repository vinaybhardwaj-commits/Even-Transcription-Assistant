/**
 * brain/src/state.ts — the visit graph: read/write against migration 0042.
 *
 * Skeleton semantics (PRD build-order step 1): record evidence (cue rows) and
 * echo the current picture. There is NO fuse and NO state transition here —
 * visits[] and clusters[] are read back exactly as stored (empty in A).
 *
 * Every SQL string in this file is a named constant so the report can list
 * them verbatim (A.6). Table/column names follow 0042_brain_tables.sql.
 */

import { randomBytes } from "node:crypto";
import { query, type PoolClient } from "./db.js";

// ---------------------------------------------------------------------------
// IDs — same alphabet + 8-char length as lib/bench.ts ('room_' / 'bs_' / 'bc_').
// The brain has no nanoid dep (pg only), so this is node:crypto with rejection
// sampling to keep the distribution uniform.
// ---------------------------------------------------------------------------

const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // 31 chars, no 0/o/1/l/i
const ID_LEN = 8;

function shortId(): string {
  let out = "";
  while (out.length < ID_LEN) {
    for (const b of randomBytes(16)) {
      // 248 = 8 * 31 — largest multiple of the alphabet size below 256.
      if (b < 248) {
        out += ID_ALPHABET[b % ID_ALPHABET.length];
        if (out.length === ID_LEN) break;
      }
    }
  }
  return out;
}

export const newRoomDayId = (): string => `rd_${shortId()}`;
export const newCueId = (): string => `cue_${shortId()}`;

// ---------------------------------------------------------------------------
// Day boundary (PRD §15A): room_day is per calendar date in Asia/Kolkata.
// Intl handles the +05:30 offset; the date flips at 00:00 IST, not 00:00 UTC.
// ---------------------------------------------------------------------------

const IST_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 'YYYY-MM-DD' for the given instant, in IST. */
export function istDate(now: Date = new Date()): string {
  // en-CA gives ISO order; formatToParts avoids any locale-separator surprises.
  const parts = IST_DATE_FMT.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const IST_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isIstDateString(s: unknown): s is string {
  return typeof s === "string" && IST_DATE_RE.test(s);
}

// ---------------------------------------------------------------------------
// SQL (inferred — no live DB in the build sandbox; listed verbatim in report)
// ---------------------------------------------------------------------------

export const SQL_ROOM_EXISTS = "SELECT 1 FROM room WHERE id = $1 AND disabled_at IS NULL";

export const SQL_ROOM_DAY_SELECT =
  "SELECT id, room_id, doctor_id, ist_date::text AS ist_date, started_at, ended_at FROM room_day WHERE room_id = $1 AND ist_date = $2::date";

/**
 * Resolve-or-create. The DO UPDATE no-op makes RETURNING fire on the conflict
 * path too, so two racing first-cues for a room both get the same row.
 */
export const SQL_ROOM_DAY_UPSERT =
  "INSERT INTO room_day (id, room_id, ist_date) VALUES ($1, $2, $3::date) " +
  "ON CONFLICT (room_id, ist_date) DO UPDATE SET room_id = EXCLUDED.room_id " +
  "RETURNING id, room_id, doctor_id, ist_date::text AS ist_date, started_at, ended_at";

export const SQL_CUE_INSERT =
  "INSERT INTO cue (id, room_day_id, type, payload, at) VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz) RETURNING id, at, created_at";

// --- Fuse slice 4 (the arms, migration 0048) --------------------------------

/** The default arm on read (X3). Must match lib/brain/state.ts. */
export const DEFAULT_ARM = "rules";

/**
 * Visits for a room_day, WITHIN ONE ARM.
 *
 * THIS EXACT STRING IS DUPLICATED IN lib/brain/state.ts and MUST STAY IDENTICAL. This service
 * is a separate build (own tsconfig, NodeNext specifiers, own container) and cannot import
 * from lib/, so the string is the shared artefact rather than the module. The two copies had
 * already drifted before slice 4; tests/unit/fuse-arms.test.ts now reads both files and fails
 * if they diverge again. If you change one, change the other in the same commit.
 */
export const SQL_VISITS_FOR_DAY =
  "SELECT id, individual_uid, consult_uid, state, pstart_at, confidence, end_reason, ambiguity, updated_at, arm, opened_by, opened_by_kind " +
  "FROM visit WHERE room_day_id = $1 AND COALESCE(arm, 'rules') = $2::text ORDER BY updated_at ASC, id ASC";

export const SQL_CLUSTERS_FOR_DAY =
  "SELECT id, kind, visit_id, first_seen_at, last_seen_at, (centroid IS NOT NULL) AS has_centroid " +
  "FROM speaker_cluster WHERE room_day_id = $1 ORDER BY first_seen_at ASC, id ASC";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoomDayRow = {
  id: string;
  room_id: string;
  doctor_id: string | null;
  ist_date: string;
  started_at: Date;
  ended_at: Date | null;
};

type VisitRow = {
  id: string;
  individual_uid: string | null;
  consult_uid: string | null;
  state: string;
  pstart_at: Date | null;
  confidence: number | null;
  end_reason: string | null;
  updated_at: Date;
  arm: string | null;
  opened_by: string | null;
  opened_by_kind: string | null;
  ambiguity: string | null;
};

type ClusterRow = {
  id: string;
  kind: string;
  visit_id: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  has_centroid: boolean;
};

/** The picture (PRD §7 / §11). confidence is null in the skeleton — no fuse. */
export type Graph = {
  room_id: string;
  room_day_id: string | null;
  ist_date: string;
  visits: Array<{
    id: string;
    individual_uid: string | null;
    consult_uid: string | null;
    state: string;
    pstart_at: string | null;
    confidence: number | null;
    end_reason: string | null;
    speaker_cluster_ids: string[];
    updated_at: string;
  }>;
  active_visit_id: string | null;
  clusters: Array<{
    id: string;
    kind: string;
    visit_id: string | null;
    first_seen_at: string;
    last_seen_at: string;
    has_centroid: boolean;
  }>;
  confidence: null;
  as_of: string;
};

type Queryable = Pick<PoolClient, "query">;

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Does the room exist (and is not disabled)? Rooms come from Room Bench (0041). */
export async function roomExists(roomId: string): Promise<boolean> {
  const r = await query(SQL_ROOM_EXISTS, [roomId]);
  return (r.rowCount ?? 0) > 0;
}

/** Find the room_day for (room, IST date) without creating it. */
export async function findRoomDay(roomId: string, date: string): Promise<RoomDayRow | null> {
  const r = await query<RoomDayRow>(SQL_ROOM_DAY_SELECT, [roomId, date]);
  return r.rows[0] ?? null;
}

/** Resolve-or-create the room_day for (room, IST date). Idempotent under races. */
export async function resolveRoomDay(roomId: string, date: string): Promise<RoomDayRow> {
  const existing = await findRoomDay(roomId, date);
  if (existing) return existing;
  const r = await query<RoomDayRow>(SQL_ROOM_DAY_UPSERT, [newRoomDayId(), roomId, date]);
  const row = r.rows[0];
  if (!row) throw new Error("room_day upsert returned no row");
  return row;
}

/**
 * Read the graph for a room_day. `q` may be a locked txn client (POST /cues —
 * so the echo is consistent with the write) or the pool (GET state).
 */
export async function readGraph(q: Queryable, roomId: string, date: string, roomDayId: string | null, arm: string = DEFAULT_ARM): Promise<Graph> {
  const as_of = new Date().toISOString();
  if (!roomDayId) {
    return { room_id: roomId, room_day_id: null, ist_date: date, visits: [], active_visit_id: null, clusters: [], confidence: null, as_of };
  }
  const [v, c] = await Promise.all([
    q.query<VisitRow>(SQL_VISITS_FOR_DAY, [roomDayId, arm]),
    q.query<ClusterRow>(SQL_CLUSTERS_FOR_DAY, [roomDayId]),
  ]);

  const clusterIdsByVisit = new Map<string, string[]>();
  for (const row of c.rows) {
    if (!row.visit_id) continue;
    const list = clusterIdsByVisit.get(row.visit_id) ?? [];
    list.push(row.id);
    clusterIdsByVisit.set(row.visit_id, list);
  }

  const visits: Graph["visits"] = v.rows.map((row) => ({
    id: row.id,
    individual_uid: row.individual_uid,
    consult_uid: row.consult_uid,
    state: row.state,
    pstart_at: iso(row.pstart_at),
    confidence: row.confidence,
    end_reason: row.end_reason,
    speaker_cluster_ids: clusterIdsByVisit.get(row.id) ?? [],
    updated_at: iso(row.updated_at) ?? as_of,
  }));

  // Derivation, not inference: "in the chair" is whichever visit is currently
  // in_chair (most recently updated wins if the data ever disagrees). Empty
  // in the skeleton because nothing writes visits yet.
  const inChair = v.rows.filter((r) => r.state === "in_chair");
  const active = inChair.length ? inChair[inChair.length - 1]! : null;

  const clusters: Graph["clusters"] = c.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    visit_id: row.visit_id,
    first_seen_at: iso(row.first_seen_at) ?? as_of,
    last_seen_at: iso(row.last_seen_at) ?? as_of,
    has_centroid: row.has_centroid,
  }));

  return { room_id: roomId, room_day_id: roomDayId, ist_date: date, visits, active_visit_id: active?.id ?? null, clusters, confidence: null, as_of };
}

// ---------------------------------------------------------------------------
// Writes (must be called with the room_day lock held — see lock.ts)
// ---------------------------------------------------------------------------

export type CueInput = { type: string; at: Date; payload: unknown };

/** Insert one cue row. `payload` is stored as given (jsonb; null allowed). */
export async function insertCue(client: Queryable, roomDayId: string, cue: CueInput): Promise<{ id: string; at: string; created_at: string }> {
  const id = newCueId();
  const payloadJson = cue.payload === undefined ? null : JSON.stringify(cue.payload);
  const r = await client.query<{ id: string; at: Date; created_at: Date }>(SQL_CUE_INSERT, [id, roomDayId, cue.type, payloadJson, cue.at.toISOString()]);
  const row = r.rows[0];
  if (!row) throw new Error("cue insert returned no row");
  return { id: row.id, at: iso(row.at) ?? cue.at.toISOString(), created_at: iso(row.created_at) ?? new Date().toISOString() };
}
