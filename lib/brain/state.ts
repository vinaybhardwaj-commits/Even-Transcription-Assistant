/**
 * lib/brain/state.ts — the visit graph: read/write against migration 0042.
 *
 * PORTED from brain/src/state.ts (Kickoff A2, decision B10) — SQL, ids, IST day
 * resolution and the graph shape are byte-for-byte the Kickoff A build; only the driver
 * import changed (lib/brain/db over @neondatabase/serverless WebSocket Pool).
 *
 * Skeleton semantics (PRD build-order step 1): record evidence (cue rows) and
 * echo the current picture. There is NO fuse and NO state transition here —
 * visits[] and clusters[] are read back exactly as stored (empty in A).
 *
 * Every SQL string in this file is a named constant so the report can list
 * them verbatim (A.6). Table/column names follow 0042_brain_tables.sql.
 */

import { randomBytes } from "node:crypto";
import { query, type PoolClient } from "./db";

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
/** Fuse slice 4. The 'vis_' prefix existed only as a comment in 0042 until today. */
export const newVisitId = (): string => `vis_${shortId()}`;

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

// --- Fuse slice 2 (scratch graph, migration 0046) ---------------------------
// SEPARATE constants. SQL_CUE_INSERT above is shared by every live caller and is
// not touched; the two below run ONLY on the explicit room_day_id path.

/** The day by its own id, including the 0046 scratch flag. Read INSIDE the lock. */
export const SQL_ROOM_DAY_BY_ID =
  "SELECT id, room_id, doctor_id, ist_date::text AS ist_date, started_at, ended_at, scratch FROM room_day WHERE id = $1";

/**
 * The scratch write. Adds the two 0046 columns plus 0047's source_ref, and takes an
 * UNQUALIFIED ON CONFLICT DO NOTHING, which covers BOTH partial unique indexes:
 *
 *   cue_replay_natural_key     (session_id, type, at) WHERE source = 'replay'
 *   cue_warehouse_natural_key  (source_ref, type, at) WHERE source = 'warehouse'
 *
 * The predicates are disjoint, so a replay cue is only ever in the first and a warehouse
 * cue only ever in the second, and neither can collide with the other. A live cue carries
 * a NULL source and is in neither. A conflict returns NO ROW: that is "already exists",
 * not a failure, which is what makes both the replay and the loader re-runnable.
 */
export const SQL_CUE_INSERT_SCRATCH =
  "INSERT INTO cue (id, room_day_id, type, payload, at, session_id, source, source_ref) " +
  "VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::text, $7::text, $8::text) " +
  "ON CONFLICT DO NOTHING RETURNING id, at, created_at";

// --- Fuse slice 4 (the arms, migration 0048) --------------------------------

/**
 * The default arm on read (X3). NOT flash, NOT the most recently updated row, NOT the
 * lexicographically smallest id — an explicit, boring default, so that adding a fourth arm
 * can never silently change what `scribe_get_state` shows a human.
 */
export const DEFAULT_ARM = "rules";

/**
 * Visits for a room_day, WITHIN ONE ARM.
 *
 * COALESCE(arm, DEFAULT) rather than `arm = $2`: a writer that sets no arm — anything
 * predating 0048, or a future caller that forgets — still reads as 'rules' instead of
 * vanishing from every listing. Vanishing is the worse failure: an empty graph looks like
 * "nothing happened" rather than "you asked the wrong question".
 *
 * THIS EXACT STRING IS DUPLICATED IN brain/src/state.ts. The two files are separate builds
 * (that one is a standalone Cloud Run service with its own tsconfig and NodeNext specifiers,
 * so it cannot import from lib/), and they had already drifted before today. They are now
 * byte-identical here, and tests/unit/fuse-arms.test.ts reads BOTH files and fails if they
 * ever differ again — the only form of unification available across two independent builds.
 */
export const SQL_VISITS_FOR_DAY =
  "SELECT id, individual_uid, consult_uid, state, pstart_at, confidence, end_reason, ambiguity, updated_at, arm, opened_by, opened_by_kind " +
  "FROM visit WHERE room_day_id = $1 AND COALESCE(arm, 'rules') = $2::text ORDER BY updated_at ASC, id ASC";

/**
 * The fuse write. ON CONFLICT DO NOTHING against visit_arm_opened_by_key — the PARTIAL unique
 * index on (arm, opened_by) WHERE both are NOT NULL — so re-running an arm writes nothing that
 * already exists. A conflict returns NO ROW: that is "already exists", not a failure, exactly
 * as the cue writers behave.
 *
 * A visit with a NULL opened_by is not in that index and so is NOT idempotent; the fuse never
 * emits one (every draft carries opening evidence), and the runner refuses to write one rather
 * than quietly duplicating it on the next run.
 */
export const SQL_VISIT_INSERT =
  "INSERT INTO visit (id, room_day_id, individual_uid, consult_uid, state, pstart_at, confidence, end_reason, ambiguity, arm, opened_by, opened_by_kind) " +
  "VALUES ($1, $2, $3::text, $4::text, $5, $6::timestamptz, $7::real, $8::text, $9::text, $10::text, $11::text, $12::text) " +
  "ON CONFLICT DO NOTHING RETURNING id";

/** Cues for a room_day BY ID, oldest first — the fuse reads a day in evidence order. */
export const SQL_CUES_FOR_ROOM_DAY =
  "SELECT id, type, at, created_at, payload, source, source_ref FROM cue " +
  "WHERE room_day_id = $1 ORDER BY at ASC, id ASC";

// --- Speech turns, slice A (migration 0050) ---------------------------------

/**
 * The three cue types the speech-turn pipeline writes. Named ONCE, here, because the same three
 * appear in 0050's index predicate and in the writer's conflict target, and a fourth place for
 * them to drift apart is exactly what the warehouse loader taught us not to build.
 *
 * `speaker_match` is written by slice B; in slice A its count is legitimately zero, and a zero
 * that is reported is a different thing from a count that does not exist.
 */
export const TURN_CUE_TYPES = ["stt_turn", "stt_silence", "speaker_match"] as const;

/**
 * The four types the TURN NATURAL KEY covers — 0052's index predicate, in its order.
 *
 * DELIBERATELY a different list from TURN_CUE_TYPES above, and the difference is the whole
 * design: `stt_window` is keyed like a turn but is NOT evidence. It says whether a window was
 * finished; it does not say anything was heard. Folding it into TURN_CUE_TYPES would break the
 * scoreboard identity that the three evidence types PARTITION the day's turn cues and sum to
 * their total — a window marker would be counted as if somebody had spoken.
 *
 * So: TURN_CUE_TYPES is what is COUNTED as evidence, TURN_KEYED_TYPES is what is KEYED. Both
 * appear in migrations, and tests read the .sql files to hold each to its own predicate.
 */
export const TURN_KEYED_TYPES = ["stt_turn", "stt_silence", "stt_window", "speaker_match"] as const;

/**
 * The completeness cue (K3 §3). One row per asked window, in the same transaction as that
 * window's turns, saying whether the window finished. `complete: false` carries `stopped_early`
 * and the segment count Whisper returned, and NO stt_turn row for that window exists — which is
 * how a reader tells "we asked and could not finish" from "we never asked".
 */
export const WINDOW_CUE_TYPE = "stt_window";

/**
 * The types the window writer OWNS and therefore replaces wholesale. `speaker_match` is NOT one:
 * slice B writes it from a different pass over the same window, and a turn re-run must not
 * silently delete a diarisation result it did not produce.
 */
export const WINDOW_OWNED_TYPES = ["stt_turn", "stt_silence", "stt_window"] as const;

/**
 * How many turn cues a room-day holds, by type. INFERRED SQL — there is no live database in the
 * build sandbox — and listed verbatim in the slice report for validation.
 *
 * An aggregate rather than a count over the cue list the report already reads, for two reasons:
 * a day of turns is thousands of rows whose payloads carry the transcript, and the counts then
 * survive a failure of that larger read instead of vanishing with it.
 */
/**
 * The turn writer's own insert (K2, correction 3). SEPARATE from SQL_CUE_INSERT_SCRATCH, which
 * is NOT touched: that statement is shared with the marks and with the warehouse loader, and its
 * UNQUALIFIED `ON CONFLICT DO NOTHING` is the right contract for both.
 *
 * The difference is one clause, and it is the whole reason this constant exists — the conflict
 * target is NAMED, and the index predicate is repeated verbatim as Postgres requires to infer a
 * PARTIAL index:
 *
 *     ON CONFLICT (source_ref, type)
 *       WHERE source = 'replay' AND type IN ('stt_turn', 'stt_silence', 'speaker_match')
 *       DO NOTHING
 *
 * WHY IT MATTERS. With an unqualified target, EVERY unique violation on the row is swallowed —
 * so `dropped` can never be non-zero and the three counts collapse into two. With the target
 * named, exactly one index absorbs a re-run and everything else throws:
 *
 *     a returned row      → WRITTEN
 *     no row, no error    → ALREADY EXISTED   (0050's index absorbed it)
 *     a thrown error      → DROPPED, and a drop is a BUG, not a duplicate
 *
 * That third line is the one that could not be evidenced before, and it is why two rounds of
 * design went into the key.
 *
 * The predicate is 0050's index predicate and 0051's exclusion list, character for character.
 * TURN_CUE_TYPES above is the same closed set in TypeScript; the string is spelled out rather
 * than interpolated because an inference predicate that drifts silently stops matching the index
 * and every turn write starts throwing.
 */
export const SQL_CUE_INSERT_TURN =
  "INSERT INTO cue (id, room_day_id, type, payload, at, session_id, source, source_ref) " +
  "VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::text, $7::text, $8::text) " +
  "ON CONFLICT (source_ref, type) " +
  "WHERE source = 'replay' AND type IN ('stt_turn', 'stt_silence', 'stt_window', 'speaker_match') " +
  "DO NOTHING RETURNING id, at, created_at";

/**
 * THE WINDOW DELETE (K3 §1). Half of the write unit: a window's rows are removed and re-inserted
 * as a set, in ONE transaction, so a re-run REPLACES Whisper's opinion instead of accumulating
 * alongside it.
 *
 * MATCHED ON THE ASKED WINDOW IN THE PAYLOAD, never on Whisper's segment times. That is the
 * entire point: the segment times are what moved between runs (162 segments one run, 165 the
 * next), so keying the delete on them would leave the 162 behind. `payload.window` is what the
 * OPERATOR asked for, it is identical on every cue of the window, and it is stable across runs.
 *
 * ->> then ::bigint rather than a jsonb numeric comparison: the payload holds these as JSON
 * numbers, and comparing them as text would make 1755576000000 and 1.755576e12 different windows.
 * A row whose payload has no window at all yields NULL from ->>, and NULL = $3 is never true, so
 * such a row is left alone rather than swept up — a cue written before K2 is not this window's.
 *
 * `speaker_match` is deliberately NOT in the type list (WINDOW_OWNED_TYPES): slice B writes it
 * from its own pass, and re-transcribing must not delete a diarisation result it did not produce.
 *
 * RETURNING id so the caller can report `deleted` as a real count rather than a rowCount that
 * some drivers narrow away.
 */
export const SQL_CUE_DELETE_WINDOW =
  "DELETE FROM cue " +
  "WHERE room_day_id = $1 " +
  "AND session_id = $2 " +
  "AND source = 'replay' " +
  "AND type IN ('stt_turn', 'stt_silence', 'stt_window') " +
  "AND (payload->'window'->>'start_ms')::bigint = $3 " +
  "AND (payload->'window'->>'end_ms')::bigint = $4 " +
  "RETURNING id";

/**
 * THE BATCH INSERT (K3 §2), built for exactly `n` rows.
 *
 * A FUNCTION rather than a constant because the VALUES list has to be as long as the batch. It
 * is the SAME statement as SQL_CUE_INSERT_TURN in every other respect — same eight columns, same
 * order, same casts, same NAMED conflict target repeating 0052's predicate — so the two cannot
 * drift on anything that matters. A test asserts buildTurnBatchInsert(1) is SQL_CUE_INSERT_TURN
 * with one tuple.
 *
 * WHY IT EXISTS. The old path posted one cue per HTTP request. Measured in production on the
 * Cardiology window: 71 rows took 44.3 s of `created_at` spread, 624 ms per row. At that rate a
 * 165-segment window costs 103 s of inserts alone against a 115 s tool cap — so no time budget
 * could make a six-minute window finish, and only batching can. One statement, one round trip.
 *
 * ON CONFLICT DO NOTHING is still correct for a multi-row insert: two rows sharing (source_ref,
 * type) inside ONE statement conflict with each other and the later is skipped. That is the
 * WITHIN-WRITE key doing its job — Whisper emitting the same span twice in one pass is a
 * duplicate, not a second turn. (DO NOTHING has no "cannot affect row a second time" hazard;
 * that error is specific to DO UPDATE.)
 *
 * `written` is what RETURNING gives back; `already_existed` is the shortfall. After a delete the
 * shortfall should be zero, and a non-zero one means Whisper said the same thing twice.
 */
export function buildTurnBatchInsert(n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`buildTurnBatchInsert: n must be a positive integer, got ${n}`);
  const tuples: string[] = [];
  for (let i = 0; i < n; i++) {
    const b = i * 8;
    tuples.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::jsonb, $${b + 5}::timestamptz, $${b + 6}::text, $${b + 7}::text, $${b + 8}::text)`);
  }
  return (
    "INSERT INTO cue (id, room_day_id, type, payload, at, session_id, source, source_ref) " +
    `VALUES ${tuples.join(", ")} ` +
    "ON CONFLICT (source_ref, type) " +
    "WHERE source = 'replay' AND type IN ('stt_turn', 'stt_silence', 'stt_window', 'speaker_match') " +
    "DO NOTHING RETURNING id, at, created_at"
  );
}

export const SQL_TURN_CUE_COUNTS =
  "SELECT type, COUNT(*)::int AS n FROM cue " +
  "WHERE room_day_id = $1 AND type IN ('stt_turn', 'stt_silence', 'speaker_match') " +
  "GROUP BY type";

export const SQL_CLUSTERS_FOR_DAY =
  "SELECT id, kind, visit_id, first_seen_at, last_seen_at, (centroid IS NOT NULL) AS has_centroid " +
  "FROM speaker_cluster WHERE room_day_id = $1 ORDER BY first_seen_at ASC, id ASC";

/**
 * Operator MCP S1 (GET /api/brain/rooms/:id/cues + scribe_list_cues): cues for a room_day,
 * newest first, optional `since` (at > $2) and `type` (= $3) filters, LIMIT $4. Read-only.
 */
export const SQL_CUES_FOR_DAY =
  "SELECT id, type, at, created_at, payload FROM cue " +
  "WHERE room_day_id = $1 AND ($2::timestamptz IS NULL OR at > $2::timestamptz) AND ($3::text IS NULL OR type = $3::text) " +
  "ORDER BY at DESC, id DESC LIMIT $4::int";

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
    /** slice 4 follow-up (0049): closed-set reasons, comma-joined. NEVER prose. */
    ambiguity: string | null;
    speaker_cluster_ids: string[];
    updated_at: string;
    /** slice 4: which arm wrote this row. A stored NULL reads back as DEFAULT_ARM. */
    arm: string;
    opened_by: string | null;
    opened_by_kind: string | null;
  }>;
  active_visit_id: string | null;
  /** the arm this picture was read at — always stated, never left for the reader to assume */
  arm: string;
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
    return { room_id: roomId, room_day_id: null, ist_date: date, visits: [], active_visit_id: null, clusters: [], confidence: null, as_of, arm };
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
    ambiguity: row.ambiguity,
    speaker_cluster_ids: clusterIdsByVisit.get(row.id) ?? [],
    updated_at: iso(row.updated_at) ?? as_of,
    arm: row.arm ?? DEFAULT_ARM,
    opened_by: row.opened_by,
    opened_by_kind: row.opened_by_kind,
  }));

  // Derivation, not inference: "in the chair" is whichever visit is currently
  // in_chair (most recently updated wins if the data ever disagrees). WITHIN THE
  // SELECTED ARM ONLY — the rows are already filtered to one arm, so the
  // updated_at/id tiebreak is a tiebreak again rather than a race between three
  // algorithms that all wrote the same day.
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

  return { room_id: roomId, room_day_id: roomDayId, ist_date: date, visits, active_visit_id: active?.id ?? null, clusters, confidence: null, as_of, arm };
}

// ---------------------------------------------------------------------------
// Cue list (Operator MCP S1) — read-only, brain pool. Never creates a day.
// ---------------------------------------------------------------------------

export const CUES_DEFAULT_LIMIT = 50;
export const CUES_MAX_LIMIT = 200;
const CUE_SUMMARY_CHARS = 80;

type CueRow = { id: string; type: string; at: Date; created_at: Date; payload: unknown };

export type CueListItem = {
  id: string;
  type: string;
  at: string;
  created_at: string;
  /** first 80 chars of the payload JSON (null when payload is null) */
  summary: string | null;
  /** only present when include_payload=true */
  payload?: unknown;
};

export type CueListResult = {
  room_id: string;
  room_day_id: string | null;
  ist_date: string;
  cues: CueListItem[];
  as_of: string;
};

/**
 * List cues for (room, IST date), newest first. `since` filters at > since; `type` exact.
 * Payload is summarised to 80 chars unless includePayload. Throws on brain error (callers
 * classify / degrade).
 */
export async function listCuesForDay(
  roomId: string,
  date: string,
  opts: { since?: Date | null; type?: string | null; limit?: number; includePayload?: boolean } = {},
): Promise<CueListResult> {
  const as_of = new Date().toISOString();
  const day = await findRoomDay(roomId, date);
  if (!day) return { room_id: roomId, room_day_id: null, ist_date: date, cues: [], as_of };
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? CUES_DEFAULT_LIMIT) || CUES_DEFAULT_LIMIT, 1), CUES_MAX_LIMIT);
  const r = await query<CueRow>(SQL_CUES_FOR_DAY, [
    day.id,
    opts.since ? opts.since.toISOString() : null,
    opts.type ?? null,
    limit,
  ]);
  const cues: CueListItem[] = r.rows.map((row) => {
    let summary: string | null = null;
    if (row.payload !== null && row.payload !== undefined) {
      try {
        summary = JSON.stringify(row.payload).slice(0, CUE_SUMMARY_CHARS);
      } catch {
        summary = null;
      }
    }
    const item: CueListItem = {
      id: row.id,
      type: row.type,
      at: iso(row.at) ?? as_of,
      created_at: iso(row.created_at) ?? as_of,
      summary,
    };
    if (opts.includePayload) item.payload = row.payload ?? null;
    return item;
  });
  return { room_id: roomId, room_day_id: day.id, ist_date: date, cues, as_of };
}

// ---------------------------------------------------------------------------
// Writes (must be called with the room_day lock held — see lock.ts)
// ---------------------------------------------------------------------------

export type CueInput = { type: string; at: Date; payload: unknown };

/** A room_day read by id, carrying the 0046 scratch flag the write guard tests. */
export type RoomDayByIdRow = RoomDayRow & { scratch: boolean };

/**
 * Fuse slice 2 — the day by id, read inside the locked transaction so the guard tests the
 * flag as it is at write time, not as it was when the caller chose the day. Null when the
 * id names nothing.
 */
export async function findRoomDayById(client: Queryable, roomDayId: string): Promise<RoomDayByIdRow | null> {
  const r = await client.query<RoomDayByIdRow>(SQL_ROOM_DAY_BY_ID, [roomDayId]);
  return r.rows[0] ?? null;
}

/** Insert one cue row. `payload` is stored as given (jsonb; null allowed). */
export async function insertCue(client: Queryable, roomDayId: string, cue: CueInput): Promise<{ id: string; at: string; created_at: string }> {
  const id = newCueId();
  const payloadJson = cue.payload === undefined ? null : JSON.stringify(cue.payload);
  const r = await client.query<{ id: string; at: Date; created_at: Date }>(SQL_CUE_INSERT, [id, roomDayId, cue.type, payloadJson, cue.at.toISOString()]);
  const row = r.rows[0];
  if (!row) throw new Error("cue insert returned no row");
  return { id: row.id, at: iso(row.at) ?? cue.at.toISOString(), created_at: iso(row.created_at) ?? new Date().toISOString() };
}

export type ScratchCueInput = CueInput & { session_id: string | null; source: string | null; source_ref: string | null };

/**
 * True for a cue that the turn natural key covers: source 'replay' AND one of the FOUR keyed
 * types (0050, widened by 0052 to admit stt_window).
 * EXACTLY the index predicate, and exactly SQL_CUE_INSERT_TURN's inference predicate — the
 * three have to agree or the named arbiter stops matching and every turn write throws.
 *
 * Both halves are required. A turn-typed cue with some OTHER source is not in 0050's index, and
 * naming that arbiter for it would turn a conflict on the warehouse key into an exception
 * instead of the DO NOTHING the loader relies on.
 */
export const isTurnCue = (source: string | null, type: string): boolean =>
  source === "replay" && (TURN_KEYED_TYPES as readonly string[]).includes(type);

/**
 * Fuse slice 2 — insert one cue on the SCRATCH path (0046 columns + 0047's source_ref, ON
 * CONFLICT DO NOTHING). A conflict on either natural key — the replay's or the warehouse's —
 * returns no row; that is reported as already_existed, never as a failure, so a half-finished
 * run is resumable by re-running it.
 *
 * SPEECH TURNS (K2, correction 3): a turn cue takes the OTHER statement — same columns, same
 * parameters, same order, and a NAMED conflict target. Nothing about the caller changes; the
 * route sends one body and this function picks the arbiter from the row it is about to write,
 * which is the only place that can know. The counts the caller reports are only honest with the
 * target named: with an unqualified one, every unique violation is swallowed and `dropped` can
 * never be non-zero.
 *
 * Both statements return NO ROW on the conflict they arbitrate, so `already_existed` means the
 * same thing on both paths. The difference is what happens to everything else: the shared
 * statement swallows it, the turn statement THROWS, and the caller counts that as a drop.
 */
export async function insertScratchCue(
  client: Queryable,
  roomDayId: string,
  cue: ScratchCueInput,
): Promise<{ id: string | null; at: string; created_at: string | null; already_existed: boolean }> {
  const id = newCueId();
  const payloadJson = cue.payload === undefined ? null : JSON.stringify(cue.payload);
  const stmt = isTurnCue(cue.source, cue.type) ? SQL_CUE_INSERT_TURN : SQL_CUE_INSERT_SCRATCH;
  const r = await client.query<{ id: string; at: Date; created_at: Date }>(stmt, [
    id,
    roomDayId,
    cue.type,
    payloadJson,
    cue.at.toISOString(),
    cue.session_id,
    cue.source,
    cue.source_ref,
  ]);
  const row = r.rows[0];
  if (!row) return { id: null, at: cue.at.toISOString(), created_at: null, already_existed: true };
  return { id: row.id, at: iso(row.at) ?? cue.at.toISOString(), created_at: iso(row.created_at), already_existed: false };
}

export type WindowRef = { sessionId: string; startMs: number; endMs: number };

/**
 * K3 §1, first half — delete every row this writer owns for one asked window.
 *
 * Runs INSIDE the caller's transaction and lock: the delete and the insert that follows it are
 * one atomic replace, so a reader never sees a window with the old set removed and the new set
 * not yet written.
 */
export async function deleteWindowCues(client: Queryable, roomDayId: string, w: WindowRef): Promise<number> {
  const r = await client.query<{ id: string }>(SQL_CUE_DELETE_WINDOW, [roomDayId, w.sessionId, w.startMs, w.endMs]);
  return r.rows.length;
}

/**
 * K3 §2, second half — insert the whole set in ONE statement.
 *
 * An empty batch is a legitimate call and does no work: it is how a DELETE-ONLY replace is
 * expressed (K3 §7's cleanup path), and issuing `VALUES ()` for it would be a syntax error.
 *
 * Ids are minted here, one per row, exactly as the single-row path mints one. A row that loses
 * the within-write conflict keeps its id unused, which costs nothing — ids are not a sequence.
 */
export async function insertScratchCuesBatch(
  client: Queryable,
  roomDayId: string,
  cues: readonly ScratchCueInput[],
): Promise<{ written: number; already_existed: number; attempted: number; ids: string[] }> {
  if (cues.length === 0) return { written: 0, already_existed: 0, attempted: 0, ids: [] };
  const params: unknown[] = [];
  for (const c of cues) {
    params.push(
      newCueId(),
      roomDayId,
      c.type,
      c.payload === undefined ? null : JSON.stringify(c.payload),
      c.at.toISOString(),
      c.session_id,
      c.source,
      c.source_ref,
    );
  }
  const r = await client.query<{ id: string }>(buildTurnBatchInsert(cues.length), params);
  const written = r.rows.length;
  return { written, already_existed: cues.length - written, attempted: cues.length, ids: r.rows.map((x) => x.id) };
}
