/**
 * lib/stay-library/store.ts — the `clinical_states` library store
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P2 / O9; table created by
 * /api/admin/migrate-clinical-states, reference DDL in migrations/0047_clinical_states.sql).
 *
 * FAIL-SOFT WRITES (O9: "log and continue, same spirit as lib/readmission/ask-store.ts"). A library
 * row that fails to persist must not take down the audit that was reading the document — so every
 * function here returns an honest outcome and never throws. Before migration 0047 has run every call
 * soft-fails, `readStayLibrary` returns an empty library, and P3 (which does not exist yet) will read
 * that as "nothing built for this stay", which is exactly what is true.
 *
 * ONE DELIBERATE EXCEPTION TO FAIL-SOFT, and it is upstream of this file: `assertNoAdministered`
 * throws. A storage fault is a lost row; an `administered` claim is a false clinical fact, and the
 * right response to being about to write one is to stop, not to log and continue.
 *
 * WHAT THIS FILE CANNOT TOUCH. It names exactly one table, `clinical_states`. No audit table, no
 * feedback table, no MemberState table, no `episode_states` — P2 writes a library and nothing else
 * (the programme's MemberState write is P4, flag-gated, and is not reachable from here). A test
 * reads this source with comments stripped and asserts it.
 *
 * IDENTITY. `member_uid` is the Firestore member id that `ipd_discharge_audits.member_id` carries.
 * It is NOT an `individual_uid` and must never be treated as one — the hop is P4's job, at fold time
 * (O12), and no Even account number goes on Neon. This column exists so P4 has somewhere to start
 * the hop FROM, not so anything here can resolve a person.
 *
 * H1 (CDMSS-STAY-LIBRARY-HARDENING-PRD-v1.0-29-AUG-2026, H-D2) ADDS A SECOND TABLE, and exactly
 * one: `clinical_state_versions`, append-only. It is written ONLY as a CTE inside the statement
 * that overwrites a `clinical_states` row, never on its own, and nothing here ever UPDATEs or
 * DELETEs it. The reason that table exists is that this store's upsert overwrites in place: with
 * MEMBERSTATE_IPD_FOLD on, a library overwrite silently changes a member's snapshot, and before H1
 * there was nothing to diff the new snapshot against.
 *
 * ⚠️ INFERRED SQL throughout: this sandbox has no live Neon.
 */
import { sql } from '../db';
import { CLINICAL_STATE_VERSION, type ClinicalState } from '../clinical-state/schema';
import { DOC_KINDS, type DocKind, type StayDocStatus } from './core';

/** One stay never reads more than this many documents back. Above the substrate's own caps
 *  (20 OT + 5 PAC + 40 progress + 1 discharge = 66 at the ceiling). */
const LIBRARY_LIMIT = 200;

const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const isDocKind = (v: unknown): v is DocKind => typeof v === 'string' && (DOC_KINDS as readonly string[]).includes(v);

/**
 * H1 — the ONLY seam this module has, and it exists so the snapshot discipline is testable without
 * a database. Production always gets the real Neon client; a test passes a fake and can therefore
 * assert what SQL was executed, in what order, and what happens when the snapshot leg FAULTS.
 * A discipline that cannot be falsified in a test is a comment, not a discipline.
 */
export type SqlRunner = (query: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;
const liveSql: SqlRunner = (query, params) => (sql as unknown as SqlRunner)(query, params);

/**
 * H3 (H-D9) — the re-look's limit bounds, in ONE place so the route, the store and the route's own
 * self-documentation cannot disagree about them. `limit` is a finite parse ≥ 1 or the default:
 * absent, null, empty, zero, negative and junk are ONE case, not six.
 */
export const RELOOK_DEFAULT_LIMIT = 10;
export const RELOOK_MAX_LIMIT = 50;

/**
 * H-D9 rule 3, as ONE function, so the route, the walk and the route's self-documentation cannot
 * disagree about what a limit means. Absent, null, empty, zero, negative, a float, junk and a
 * boolean are all the SAME case — the default — because six near-identical branches is how one of
 * them ends up meaning zero. A finite parse of at least 1 is floored and capped at the maximum.
 */
export function parseRelookLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || n < 1) return RELOOK_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), RELOOK_MAX_LIMIT);
}

/** H-D2 — the closed set of reasons a prior reading is kept. Two, and a test enumerates them. */
export const SNAPSHOT_REASONS = ['upsert_overwrite', 'superseded'] as const;
export type SnapshotReason = (typeof SNAPSHOT_REASONS)[number];

/**
 * H1 (H-D2) — the CTE that keeps the row about to be replaced, for splicing in FRONT of the
 * statement that replaces it. Shared so H3's supersede write cannot drift from the upsert's.
 *
 * ONE STATEMENT = ONE TRANSACTION (Neon's HTTP driver has no interactive BEGIN/COMMIT), copied from
 * the R8.1 finding-versions discipline in lib/readmission/store.ts. The consequences are the whole
 * point:
 *   · a crash can never leave an overwrite with no snapshot behind it — both legs travel together;
 *   · a FAILED snapshot ABORTS the statement, so the overwrite does not happen and the caller gets
 *     the module's ordinary fail-soft 'skipped'. The snapshot is not best-effort. It is a gate.
 *   · `cur` reads inside the statement's own MVCC snapshot, so `state_json` is exactly the row
 *     being replaced rather than a re-read that raced it.
 *
 * `where` names the row in the CALLER's own parameter numbering, so the caller keeps its
 * placeholders and nothing has to be renumbered.
 */
function snapshotCte(where: string, reason: SnapshotReason): string {
  return `WITH cur AS (
             SELECT id, doc_kind, source_uid, schema_version, status, state_json
               FROM clinical_states
              WHERE ${where}
           ), snap AS (
             INSERT INTO clinical_state_versions
               (clinical_state_id, doc_kind, source_uid, schema_version, status, state_json, reason)
             SELECT c.id, c.doc_kind, c.source_uid, c.schema_version, c.status, c.state_json, '${reason}'
               FROM cur c
             RETURNING id
           )
           `;
}

export interface StoredClinicalState {
  id: string;
  docKind: DocKind;
  sourceUid: string;
  memberUid: string | null;
  encounterRef: string | null;
  schemaVersion: string;
  status: StayDocStatus;
  state: ClinicalState;
  createdAt: string | null;
}

export interface UpsertClinicalStateInput {
  docKind: DocKind;
  sourceUid: string;
  memberUid?: string | null;
  encounterRef?: string | null;
  status: StayDocStatus;
  state: ClinicalState;
  schemaVersion?: string;
}

export type UpsertOutcome = 'inserted' | 'updated' | 'skipped';

/**
 * Upsert ONE document's state. Idempotent on O9's unique key (doc_kind, source_uid,
 * schema_version): re-building the same document at the same schema version overwrites its own row
 * rather than growing the table, which is what makes a re-run of a stay safe — including a re-run
 * that now finds an OT note where the last one recorded an absence, because the absence row is keyed
 * on the stay (`absentSourceUid`) and is replaced in place.
 *
 * NEVER THROWS — 'skipped' on any fault (O9).
 *
 * H1 (H-D2). The DO UPDATE arm can no longer run without the prior row landing in
 * `clinical_state_versions` FIRST, in the same statement. The shape is lifted from R8.1's
 * `saveAuditResult`: read whether a row is already there, then choose the SQL. Two consequences
 * are deliberate and neither is an accident of the copy —
 *   · a FRESH INSERT never names the versions table at all, so a deploy that lands before the
 *     migration keeps building libraries for documents nobody has stored yet, rather than failing
 *     every write until an operator runs a route;
 *   · an OVERWRITE always names it, so before the migration an overwrite soft-fails. That is
 *     H-D2 working, not breaking: an overwrite that cannot be snapshotted must not happen.
 * Residual race, stated rather than hidden and identical to R8.1's: if another writer INSERTs
 * between the pre-read and the statement, the DO UPDATE arm fires with no snapshot. It is a
 * same-key concurrent rebuild of the same stay, the pre-read is one hop wide, and closing it would
 * need the versions table named on every path — which is the operational cost above.
 */
export async function upsertClinicalState(
  input: UpsertClinicalStateInput,
  run: SqlRunner = liveSql,
): Promise<UpsertOutcome> {
  if (!input || !isDocKind(input.docKind) || !input.sourceUid || !input.state) return 'skipped';
  const schemaVersion = input.schemaVersion || CLINICAL_STATE_VERSION;
  const key = `doc_kind = $1 AND source_uid = $2 AND schema_version = $5`;
  const upsertSql =
    `INSERT INTO clinical_states
         (doc_kind, source_uid, member_uid, encounter_ref, schema_version, status, state_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (doc_kind, source_uid, schema_version) DO UPDATE
         SET member_uid   = EXCLUDED.member_uid,
             encounter_ref = EXCLUDED.encounter_ref,
             status       = EXCLUDED.status,
             state_json   = EXCLUDED.state_json,
             created_at   = NOW()
       RETURNING (xmax = 0) AS inserted`;
  const params = [
    input.docKind, input.sourceUid, input.memberUid ?? null, input.encounterRef ?? null,
    schemaVersion, input.status === 'not_auditable' ? 'not_auditable' : 'ok',
    JSON.stringify(input.state),
  ];
  try {
    // Is there a prior reading to keep? A read fault answers "unknown", and unknown must mean
    // "assume yes": taking the snapshot path on a stay that turns out to be fresh costs an empty
    // CTE, while skipping it on a stay that turns out to have a row would overwrite unsnapshotted.
    let hasPrior = true;
    try {
      // Its own placeholder numbering, not the upsert's: an unreferenced $3 in a prepared
      // statement is a hard "could not determine data type of parameter" error, not a spare slot.
      const prior = await run(
        `SELECT id FROM clinical_states WHERE doc_kind = $1 AND source_uid = $2 AND schema_version = $3 LIMIT 1`,
        [input.docKind, input.sourceUid, schemaVersion]);
      hasPrior = prior.length > 0;
    } catch { /* unknown ⇒ snapshot path, per the comment above */ }

    const rows = (await run(
      hasPrior ? snapshotCte(key, 'upsert_overwrite') + upsertSql : upsertSql,
      params,
    )) as Array<{ inserted: boolean }>;
    return rows[0]?.inserted ? 'inserted' : 'updated';
  } catch {
    return 'skipped';
  }
}

/**
 * Every document this library holds for ONE stay, oldest first. Fail-safe: any DB error — including
 * the migration not having run — returns an empty library and an honest error line, never a throw.
 *
 * An empty library and a stay with no documents are DIFFERENT answers and the caller can tell them
 * apart: a built stay always has a row per class, including the `not_auditable` ones.
 */
export async function readStayLibrary(
  encounterRef: string,
  schemaVersion: string = CLINICAL_STATE_VERSION,
): Promise<{ documents: StoredClinicalState[]; error: string | null }> {
  if (!encounterRef) return { documents: [], error: 'encounter ref required' };
  try {
    const rows = (await sql(
      `SELECT id, doc_kind, source_uid, member_uid, encounter_ref, schema_version, status, state_json,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM clinical_states
        WHERE encounter_ref = $1 AND schema_version = $2
        ORDER BY created_at ASC
        LIMIT ${LIBRARY_LIMIT}`,
      [encounterRef, schemaVersion],
    )) as Array<Record<string, unknown>>;
    return { documents: rows.map(toStored).filter((r): r is StoredClinicalState => r != null), error: null };
  } catch (e) {
    return { documents: [], error: `stay library unavailable: ${String((e as Error).message).slice(0, 300)}` };
  }
}

/** One document by its own key. Null on absent OR on fault — the caller rebuilds either way. */
export async function readClinicalState(
  docKind: DocKind,
  sourceUid: string,
  schemaVersion: string = CLINICAL_STATE_VERSION,
): Promise<StoredClinicalState | null> {
  if (!isDocKind(docKind) || !sourceUid) return null;
  try {
    const rows = (await sql(
      `SELECT id, doc_kind, source_uid, member_uid, encounter_ref, schema_version, status, state_json,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM clinical_states
        WHERE doc_kind = $1 AND source_uid = $2 AND schema_version = $3
        LIMIT 1`,
      [docKind, sourceUid, schemaVersion],
    )) as Array<Record<string, unknown>>;
    return toStored(rows[0]);
  } catch {
    return null;
  }
}

// ── H3 (H-D7 / H-D8) — absence re-look ────────────────────────────────────────────────────
//
// "not_auditable is forever" was the third hole. 32 of R10's 45 blind cases were rows that arrived
// in db13 AFTER the audit ran, and IP-1472's absent OT row would never be looked at again — so a
// late-arriving operative note never reaches the stay audit or the spine. These functions give an
// absence row three things it did not have: a date it was last looked for, a count of how often, and
// a pointer to the real row that eventually replaced it.
//
// AN ABSENCE ROW IS NEVER DELETED (H-D8). "We looked on 29 August and it was not there" stays true
// after the note arrives; deleting the row would erase the evidence that we looked, which is the
// exact confusion between "nobody built this stay" and "this stay has no OT note" that the row was
// created to prevent. Supersession is an UPDATE, and therefore snapshotted under H-D2.

/** One absence row, as the re-look walk reads it. */
export interface AbsenceRow {
  id: string;
  docKind: DocKind;
  sourceUid: string;
  memberUid: string | null;
  encounterRef: string | null;
  schemaVersion: string;
  checkCount: number;
  lastCheckedAt: string | null;
}

/**
 * The absence rows to re-look, OLDEST-CHECKED FIRST — `last_checked_at NULLS FIRST, created_at ASC`,
 * so a row nobody has ever re-looked outranks one checked last week, which outranks one checked
 * today. A row already superseded is not walked again: its substrate arrived and the real row is on
 * the table.
 *
 * Fail-safe: any fault — including the H3 columns not existing yet because the migration has not
 * run — returns an EMPTY list. The re-look then finds no work and reports honest zeros, rather than
 * 500ing at an operator who ran a route in the wrong order.
 */
export async function listAbsenceRows(
  limit: number,
  schemaVersion: string = CLINICAL_STATE_VERSION,
  run: SqlRunner = liveSql,
): Promise<AbsenceRow[]> {
  const n = parseRelookLimit(limit);
  try {
    const rows = await run(
      `SELECT id, doc_kind, source_uid, member_uid, encounter_ref, schema_version,
              COALESCE(check_count, 0)::int AS check_count,
              to_char(last_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_checked_at
         FROM clinical_states
        WHERE schema_version = $1
          AND status = 'not_auditable'
          AND source_uid LIKE 'absent:%'
          AND superseded_by IS NULL
        ORDER BY last_checked_at ASC NULLS FIRST, created_at ASC
        LIMIT ${n}`,
      [schemaVersion],
    );
    return rows
      .map((r): AbsenceRow | null => (isDocKind(r.doc_kind) ? {
        id: String(r.id ?? ''), docKind: r.doc_kind, sourceUid: String(r.source_uid ?? ''),
        memberUid: s(r.member_uid), encounterRef: s(r.encounter_ref),
        schemaVersion: String(r.schema_version ?? ''),
        checkCount: Number(r.check_count ?? 0), lastCheckedAt: s(r.last_checked_at),
      } : null))
      .filter((r): r is AbsenceRow => r != null && r.id !== '');
  } catch {
    return [];
  }
}

/**
 * "We looked again on this date, and it is still not there." Bumps `last_checked_at` and
 * `check_count` and NOTHING else — the row's status, reason and state are what they were.
 *
 * NOT SNAPSHOTTED, deliberately. H-D2 names the upsert's DO UPDATE arm and H3's SUPERSEDE writes;
 * this is neither. A snapshot per re-look would fill the trail with thousands of identical copies of
 * the same absence, and the fact this write records — that we looked and found nothing — is already
 * fully described by the two counters it sets. The trail exists to diff STATE, and no state changed.
 *
 * Returns false on any fault, which the caller counts as `failed`: an unrecorded look is a look that
 * will happen again, which is the safe direction.
 */
export async function markAbsenceChecked(id: string, run: SqlRunner = liveSql): Promise<boolean> {
  if (!id) return false;
  try {
    const rows = await run(
      `UPDATE clinical_states
          SET last_checked_at = NOW(), check_count = COALESCE(check_count, 0) + 1
        WHERE id = $1::uuid AND superseded_by IS NULL
        RETURNING id`,
      [id],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * The substrate finally arrived. Point the absence row at the real row that replaced it, and stamp
 * the look that found it — in the SAME statement as the H-D2 snapshot, so the reading being retired
 * is on the trail before it is retired.
 *
 * THE ROW IS UPDATED, NEVER DELETED (H-D8). `superseded_by` is how a reader tells "we looked on the
 * 29th and it was absent, and the note turned up later" from "we never looked" — both of which are
 * true statements about different stays, and only one of them is this one.
 *
 * `WHERE superseded_by IS NULL` makes a second call a no-op rather than a second snapshot: a re-look
 * that races itself retires the row once.
 */
export async function supersedeAbsenceRow(
  id: string,
  newRowId: string,
  run: SqlRunner = liveSql,
): Promise<boolean> {
  if (!id || !newRowId) return false;
  try {
    const rows = await run(
      snapshotCte('id = $1::uuid AND superseded_by IS NULL', 'superseded')
      + `UPDATE clinical_states
            SET superseded_by = $2::uuid, last_checked_at = NOW(),
                check_count = COALESCE(check_count, 0) + 1
          WHERE id = $1::uuid AND superseded_by IS NULL
          RETURNING id`,
      [id, newRowId],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** How many absence rows are still waiting for their substrate. WORK LEFT, not a cursor position
 *  (H-D9). Zero on any fault — an uncountable remainder is reported as nothing to promise. */
export async function countRemainingAbsences(
  schemaVersion: string = CLINICAL_STATE_VERSION,
  run: SqlRunner = liveSql,
): Promise<number> {
  try {
    const rows = await run(
      `SELECT count(*)::int AS n
         FROM clinical_states
        WHERE schema_version = $1
          AND status = 'not_auditable'
          AND source_uid LIKE 'absent:%'
          AND superseded_by IS NULL`,
      [schemaVersion],
    );
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

/** Read one row's id by its own key — how the re-look learns the id of the row it just inserted,
 *  so the absence row can point at it. Null on absent OR on fault; the caller counts that failed. */
export async function clinicalStateIdFor(
  docKind: DocKind,
  sourceUid: string,
  schemaVersion: string = CLINICAL_STATE_VERSION,
  run: SqlRunner = liveSql,
): Promise<string | null> {
  if (!isDocKind(docKind) || !sourceUid) return null;
  try {
    const rows = await run(
      `SELECT id FROM clinical_states WHERE doc_kind = $1 AND source_uid = $2 AND schema_version = $3 LIMIT 1`,
      [docKind, sourceUid, schemaVersion],
    );
    const id = s(rows[0]?.id);
    return id;
  } catch {
    return null;
  }
}

/** Coverage counts for the whole library, for the migrate route's report and an admin readout.
 *  Empty on any fault — a counting failure never blocks anything. */
export async function libraryCounts(
  schemaVersion: string = CLINICAL_STATE_VERSION,
): Promise<{ total: number; byKind: Record<string, { ok: number; not_auditable: number }> }> {
  try {
    const rows = (await sql(
      `SELECT doc_kind, status, count(*)::int AS n
         FROM clinical_states WHERE schema_version = $1
        GROUP BY doc_kind, status`,
      [schemaVersion],
    )) as Array<{ doc_kind: string; status: string; n: number }>;
    const byKind: Record<string, { ok: number; not_auditable: number }> = {};
    let total = 0;
    for (const r of rows) {
      const k = String(r.doc_kind);
      byKind[k] ??= { ok: 0, not_auditable: 0 };
      const n = Number(r.n ?? 0);
      if (String(r.status) === 'not_auditable') byKind[k].not_auditable += n; else byKind[k].ok += n;
      total += n;
    }
    return { total, byKind };
  } catch {
    return { total: 0, byKind: {} };
  }
}

function toStored(row: Record<string, unknown> | undefined): StoredClinicalState | null {
  if (!row || !isDocKind(row.doc_kind)) return null;
  const raw = row.state_json;
  let state: ClinicalState | null = null;
  try {
    state = (typeof raw === 'string' ? JSON.parse(raw) : raw) as ClinicalState;
  } catch {
    return null;   // an unreadable state is not a state; the caller rebuilds
  }
  if (!state || typeof state !== 'object') return null;
  return {
    id: String(row.id ?? ''),
    docKind: row.doc_kind,
    sourceUid: String(row.source_uid ?? ''),
    memberUid: s(row.member_uid),
    encounterRef: s(row.encounter_ref),
    schemaVersion: String(row.schema_version ?? ''),
    status: String(row.status) === 'not_auditable' ? 'not_auditable' : 'ok',
    state,
    createdAt: s(row.created_at),
  };
}
