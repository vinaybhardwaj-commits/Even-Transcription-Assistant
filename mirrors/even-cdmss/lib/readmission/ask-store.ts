/**
 * lib/readmission/ask-store.ts — the R9 persistence layer for the case conversation
 * (CDMSS-READMISSIONS-R9-DUAL-CONTRACT PRD, D12 / D14 / O1 / O3; table `readmission_ask_turns` and
 * the `clinical_review_*` columns on `readmission_findings`, both created by
 * /api/admin/migrate-readmission-ask; reference DDL in migrations/0045).
 *
 * FAIL-SAFE THROUGHOUT — the whole file, both reads and writes, and that is a deliberate departure
 * from the R8.1 versions-store, whose insert THROWS. The reasoning is different here: a snapshot that
 * vanishes destroys evidence of an overwrite, whereas a chat turn that fails to persist must not cost
 * the care manager the ANSWER he is waiting for. So:
 *   · every function returns an honest empty / false, never a throw, never a 500;
 *   · the answer path is never blocked by a storage fault — the route reports `persisted:false` and
 *     the surface says the thread is not being kept, rather than pretending it is.
 * A consequence worth naming: before the migration has run, every call here soft-fails, the Ask box
 * behaves exactly as R4.3's ephemeral one did, and nothing else on the board notices.
 *
 * D14 — the write surface is FENCED IN CODE, not only by review: `saveClinicalReview` writes exactly
 * nine `clinical_review_*` columns in one statement and names them literally. `avoidable`, `planned`,
 * `same_condition`, `preventable_injury` and `negligence` do not appear in this file at all, and a
 * test asserts that by reading the source.
 *
 * ⚠️ INFERRED SQL throughout: this sandbox has no live Neon.
 */
import { sql } from '../db';
import { READMIT_ENGINE_VERSION } from './store';
import {
  CLINICAL_REVIEW_DECISIONS, CLINICAL_REVIEW_CLOCK_CLASSES, CLINICAL_REVIEW_LT24H_KINDS,
  CLINICAL_REVIEW_EXCLUSION_CLAIMS, CLINICAL_REVIEW_QUOTE_MAX_CHARS,
  RECORD_ARTEFACT_MAX_CHARS, RECORD_KINDS, isRecordId,
  type AskThreadTurn, type AskTurnRole, type ClinicalReview, type RecordKind,
  type RetrievedArtefact, type StoredClinicalReview,
} from '../readmission-ask-core';

/** One page-load never reads more than this many turns back. Well above O1's 20-turn model window:
 *  the SURFACE shows the whole argument, the MODEL sees the tail of it. */
const THREAD_LIMIT = 200;
/** A stored turn's text is capped here so one pasted document cannot become the thread. */
const CONTENT_MAX_CHARS = 8_000;

const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/**
 * The whole stored thread for one case at one engine version, oldest first. Fail-safe: any DB error —
 * including the migration not having run — returns an empty thread with an honest error line.
 */
export async function readThread(
  dedupKey: string,
  engineVersion: string = READMIT_ENGINE_VERSION,
): Promise<{ turns: AskThreadTurn[]; error: string | null }> {
  if (!dedupKey) return { turns: [], error: 'dedup_key required' };
  try {
    const rows = (await sql(
      `SELECT turn_index, role, content, actor, withheld,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM readmission_ask_turns
        WHERE dedup_key = $1 AND engine_version = $2
        ORDER BY turn_index ASC
        LIMIT ${THREAD_LIMIT}`,
      [dedupKey, engineVersion],
    )) as Array<Record<string, unknown>>;
    return {
      turns: rows.map((r) => ({
        turnIndex: Number(r.turn_index ?? 0),
        role: (String(r.role) === 'agent' ? 'agent' : 'user') as AskTurnRole,
        content: String(r.content ?? ''),
        actor: s(r.actor),
        withheld: r.withheld === true,
        at: s(r.created_at),
      })),
      error: null,
    };
  } catch (e) {
    return { turns: [], error: `thread unavailable: ${String((e as Error).message).slice(0, 300)}` };
  }
}

/**
 * Append ONE turn and return the row's id and index, or null on any fault.
 *
 * The index is allocated inside the same statement as the insert
 * (`SELECT coalesce(max(turn_index)+1, 0)` over the same key), so two turns racing cannot both claim
 * the same index without the unique index below rejecting one of them — and a rejected append is a
 * soft failure, exactly like every other fault here.
 */
export async function appendTurn(a: {
  dedupKey: string;
  engineVersion?: string;
  role: AskTurnRole;
  content: string;
  actor?: string | null;
  withheld?: boolean;
  overlay?: unknown;
}): Promise<{ id: string; turnIndex: number } | null> {
  if (!a.dedupKey || !a.content) return null;
  const engine = a.engineVersion ?? READMIT_ENGINE_VERSION;
  try {
    const rows = (await sql(
      `INSERT INTO readmission_ask_turns (dedup_key, engine_version, turn_index, role, content, actor, withheld, overlay_json)
       SELECT $1, $2, coalesce(max(turn_index) + 1, 0), $3, $4, $5, $6, $7::jsonb
         FROM readmission_ask_turns WHERE dedup_key = $1 AND engine_version = $2
       RETURNING id, turn_index`,
      [
        a.dedupKey, engine, a.role === 'agent' ? 'agent' : 'user',
        String(a.content).slice(0, CONTENT_MAX_CHARS),
        a.actor ?? null, a.withheld === true,
        a.overlay == null ? null : JSON.stringify(a.overlay),
      ],
    )) as Array<{ id: string; turn_index: number }>;
    const r = rows[0];
    return r?.id ? { id: String(r.id), turnIndex: Number(r.turn_index ?? 0) } : null;
  } catch {
    return null;
  }
}

/**
 * D14 / O3 — write the latest stated assertion into the nine `clinical_review_*` columns. LATEST WINS
 * the columns; the full history stays in the turns table, so nothing is lost by overwriting.
 *
 * The statement names nine columns and touches nothing else. It is scoped by (dedup_key,
 * engine_version), which is the table's unique key, so it can affect at most one row. The R8.1
 * overwrite-snapshot path is NOT invoked and must not be: that ledger exists to keep an AUDITED
 * reading a re-audit was about to destroy, and this write destroys no audited reading — it writes
 * columns the audit never touches.
 */
export async function saveClinicalReview(a: {
  dedupKey: string;
  engineVersion?: string;
  review: ClinicalReview;
  actor: string | null;
  turnId: string | null;
  model: string;
}): Promise<boolean> {
  if (!a.dedupKey) return false;
  const r = a.review;
  if (!(CLINICAL_REVIEW_DECISIONS as readonly string[]).includes(r.decision)) return false;
  const enumOrNull = <T extends string>(v: T | null, set: readonly string[]): string | null =>
    v != null && set.includes(v) ? v : null;
  try {
    const rows = (await sql(
      `UPDATE readmission_findings
          SET clinical_review_decision        = $3,
              clinical_review_clock_class     = $4,
              clinical_review_lt24h_kind      = $5,
              clinical_review_exclusion_claim = $6,
              clinical_review_quote           = $7,
              clinical_review_actor           = $8,
              clinical_review_at              = NOW(),
              clinical_review_turn_id         = $9,
              clinical_review_model           = $10
        WHERE dedup_key = $1 AND engine_version = $2
        RETURNING dedup_key`,
      [
        a.dedupKey, a.engineVersion ?? READMIT_ENGINE_VERSION,
        r.decision,
        enumOrNull(r.clockClass, CLINICAL_REVIEW_CLOCK_CLASSES as readonly string[]),
        enumOrNull(r.lt24hKind, CLINICAL_REVIEW_LT24H_KINDS as readonly string[]),
        enumOrNull(r.exclusionClaim, CLINICAL_REVIEW_EXCLUSION_CLAIMS as readonly string[]),
        String(r.quote).slice(0, CLINICAL_REVIEW_QUOTE_MAX_CHARS),
        a.actor, a.turnId, a.model,
      ],
    )) as Array<{ dedup_key: string }>;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * The stored overlay for ONE case. Its own SELECT rather than a column added to
 * `fetchFindingForSurface`: before the migration runs those columns do not exist, and widening the
 * surface read would turn a missing column into an empty BOARD (that read fails safe to zero rows).
 * A separate fail-safe read costs one query and cannot take the board down with it.
 */
export async function readClinicalReview(
  dedupKey: string,
  engineVersion: string = READMIT_ENGINE_VERSION,
): Promise<StoredClinicalReview | null> {
  if (!dedupKey) return null;
  try {
    const rows = (await sql(
      `SELECT clinical_review_decision, clinical_review_clock_class, clinical_review_lt24h_kind,
              clinical_review_exclusion_claim, clinical_review_quote, clinical_review_actor,
              to_char(clinical_review_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS clinical_review_at,
              clinical_review_turn_id, clinical_review_model
         FROM readmission_findings
        WHERE dedup_key = $1 AND engine_version = $2
        LIMIT 1`,
      [dedupKey, engineVersion],
    )) as Array<Record<string, unknown>>;
    return toStoredReview(rows[0]);
  } catch {
    return null;
  }
}

/**
 * Every case at this engine version that carries a decision, as a dedup_key → decision map. The board
 * joins it onto the loaded cards so the list can filter on it (D14). Fail-safe: an empty map means
 * "no overlays visible", which renders as an unfiltered board — never an error, never a blank list.
 */
export async function readClinicalReviewDecisions(
  engineVersion: string = READMIT_ENGINE_VERSION,
): Promise<Record<string, string>> {
  try {
    const rows = (await sql(
      `SELECT dedup_key, clinical_review_decision
         FROM readmission_findings
        WHERE engine_version = $1 AND clinical_review_decision IS NOT NULL`,
      [engineVersion],
    )) as Array<{ dedup_key: string; clinical_review_decision: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) if (r?.dedup_key) out[String(r.dedup_key)] = String(r.clinical_review_decision);
    return out;
  } catch {
    return {};
  }
}

/** Shape one row into the overlay, or null when there is no decision on it. */
function toStoredReview(row: Record<string, unknown> | undefined): StoredClinicalReview | null {
  if (!row) return null;
  const decision = s(row.clinical_review_decision);
  if (!decision || !(CLINICAL_REVIEW_DECISIONS as readonly string[]).includes(decision)) return null;
  const pick = (v: unknown, set: readonly string[]): string | null => {
    const x = s(v);
    return x != null && set.includes(x) ? x : null;
  };
  return {
    decision: decision as StoredClinicalReview['decision'],
    clockClass: pick(row.clinical_review_clock_class, CLINICAL_REVIEW_CLOCK_CLASSES as readonly string[]) as StoredClinicalReview['clockClass'],
    lt24hKind: pick(row.clinical_review_lt24h_kind, CLINICAL_REVIEW_LT24H_KINDS as readonly string[]) as StoredClinicalReview['lt24hKind'],
    exclusionClaim: pick(row.clinical_review_exclusion_claim, CLINICAL_REVIEW_EXCLUSION_CLAIMS as readonly string[]) as StoredClinicalReview['exclusionClaim'],
    quote: s(row.clinical_review_quote) ?? '',
    actor: s(row.clinical_review_actor),
    at: s(row.clinical_review_at),
    turnId: s(row.clinical_review_turn_id),
    model: s(row.clinical_review_model),
  };
}

// ── R10-D7 — the retrieved-artefact store (table `readmission_retrieved_artefacts`) ────────────
//
// (CDMSS-READMISSIONS-R10-RECORD-REACH PRD §4.2/§4.3; created by
// POST /api/admin/migrate-readmission-records; reference DDL in
// migrations/0048_readmission_retrieved_artefacts.sql.)
//
// WHY PERSIST AT ALL. Without this the `X…` namespace would be a promise the system could not keep:
// a citation resolved against whatever the retrieval happened to return this second, and a reload —
// or one new OPD note landing in db13 — would silently re-point it at a different artefact. Storing
// the artefact AT FIRST FETCH makes re-fetch drift impossible mid-thread and makes a reloaded thread
// resolve exactly what the care manager read the first time (acceptance #3).
//
// FIRST FETCH WINS, ABSOLUTELY. The insert is ON CONFLICT DO NOTHING on BOTH keys — the id and the
// artefact — so a stored artefact is never rewritten. A later fetch reads the stored copy back; it
// does not overwrite it with a fresher one. "The thread's evidence is stable" is not a convention
// here, it is the only thing the statement can do.
//
// PHI: `content` arrives ALREADY de-identified (lib/readmission/records.ts runs every retrieved
// string through assemble.ts's `deidText` before it reaches this file or a prompt), and this file
// stores it as given. Same posture as `readmission_ask_turns`.
//
// FAIL-SAFE like the rest of this file: every function returns an honest empty / false. Before the
// migration has run the reach simply has no memory, the tool still answers from a live fetch, and
// `askVerdict` resolves nothing in the X namespace — so an uncited whole-record claim is WITHHELD.
// Degrading closed is the right direction for a citation gate.
//
// ⚠️ INFERRED SQL.

const isKind = (k: unknown): k is RecordKind => (RECORD_KINDS as readonly string[]).includes(String(k));

/**
 * Persist ONE retrieved artefact at first fetch. Returns 'inserted' | 'existed' | 'skipped'.
 * Never throws; a storage fault costs the citation's persistence, never the answer.
 */
export async function saveRetrievedArtefact(a: {
  dedupKey: string;
  engineVersion?: string;
  artefact: RetrievedArtefact;
  actor?: string | null;
  turnId?: string | null;
}): Promise<'inserted' | 'existed' | 'skipped'> {
  const r = a.artefact;
  if (!a.dedupKey || !r?.id || !isRecordId(r.id) || !isKind(r.kind) || !r.sourceKey) return 'skipped';
  try {
    const rows = (await sql(
      `INSERT INTO readmission_retrieved_artefacts
         (dedup_key, engine_version, artefact_id, source_key, kind, artefact_date, label, content, actor, turn_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING
       RETURNING artefact_id`,
      [
        a.dedupKey, a.engineVersion ?? READMIT_ENGINE_VERSION, r.id, r.sourceKey, r.kind,
        r.date ?? null, String(r.label ?? '').slice(0, 500),
        String(r.text ?? '').slice(0, RECORD_ARTEFACT_MAX_CHARS),
        a.actor ?? null, a.turnId ?? null,
      ],
    )) as Array<{ artefact_id: string }>;
    return rows.length ? 'inserted' : 'existed';
  } catch {
    return 'skipped';
  }
}

/**
 * Every artefact retrieved into THIS thread, oldest first. Two jobs, both load-bearing:
 *   · `askVerdict` resolves the `X…` namespace against these ids (R10-D6), so a citation survives a
 *     reload without the artefact being re-fetched;
 *   · `mintRecordIndex` reuses their (sourceKey → id) bindings, so an id never re-points (R10-D7).
 * Fail-safe: `[]` with an honest error line.
 */
export async function readRetrievedArtefacts(
  dedupKey: string,
  engineVersion: string = READMIT_ENGINE_VERSION,
): Promise<{ artefacts: RetrievedArtefact[]; error: string | null }> {
  if (!dedupKey) return { artefacts: [], error: 'dedup_key required' };
  try {
    const rows = (await sql(
      `SELECT artefact_id, source_key, kind, artefact_date, label, content
         FROM readmission_retrieved_artefacts
        WHERE dedup_key = $1 AND engine_version = $2
        ORDER BY created_at ASC
        LIMIT ${ARTEFACT_LIMIT}`,
      [dedupKey, engineVersion],
    )) as Array<Record<string, unknown>>;
    const artefacts: RetrievedArtefact[] = [];
    for (const r of rows) {
      const id = s(r.artefact_id);
      const kind = r.kind;
      if (!id || !isRecordId(id) || !isKind(kind)) continue;
      artefacts.push({
        id,
        kind,
        date: s(r.artefact_date),
        label: s(r.label) ?? '',
        sourceKey: s(r.source_key) ?? '',
        text: s(r.content) ?? '',
      });
    }
    return { artefacts, error: null };
  } catch (e) {
    return { artefacts: [], error: `retrieved records unavailable: ${String((e as Error).message).slice(0, 300)}` };
  }
}

/** One thread never holds more than this many retrieved artefacts on a read. */
const ARTEFACT_LIMIT = 200;
