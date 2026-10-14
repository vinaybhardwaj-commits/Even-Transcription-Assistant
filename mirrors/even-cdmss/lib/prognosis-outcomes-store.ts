/**
 * lib/prognosis-outcomes-store.ts — reads and writes for prognosis_outcomes (PX Phase 2).
 *
 * ⚠️ EVERY SQL STRING IN THIS FILE IS INFERRED — the sandbox has no live database. Each string is
 * listed verbatim in the build report and the orchestrator validates it against live Neon before
 * anyone uses the feature. Any query error degrades to empty/unavailable, never a 500 and never
 * wrong data presented as right (PRD "SQL honesty" + §6 failure modes).
 *
 * P-7 AND THE TRANSACTION. lib/db is the Neon HTTP driver behind a Proxy that traps only calls, so
 * there is no multi-statement transaction API on this path. The supersede therefore runs as ONE
 * data-modifying-CTE statement — the UPDATE that flips `superseded` and the INSERT that carries
 * `supersedes_id` execute atomically inside a single statement, which is a single transaction. If
 * the old row is missing, already superseded, or belongs to a different document, the CTE matches
 * nothing, the INSERT inserts nothing, and the caller gets a refusal instead of a dangling
 * correction. No UPDATE of content. No DELETE.
 *
 * The `unavailable` flag mirrors lib/opd-audit/investigations-lookup.ts: an unreadable table must
 * render as "temporarily unavailable", never as "no outcomes recorded" — null means unknown.
 */

import { sql } from './db';
import type { OutcomeClassification, OutcomeSource } from './prognosis-outcomes-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** P-1: the two source tables outcomes may point at. */
export const OUTCOME_SOURCE_TABLES = ['ipd_discharge_audits', 'appropriateness_runs'] as const;
export type OutcomeSourceTable = (typeof OUTCOME_SOURCE_TABLES)[number];
export function isOutcomeSourceTable(x: unknown): x is OutcomeSourceTable {
  return typeof x === 'string' && (OUTCOME_SOURCE_TABLES as readonly string[]).includes(x);
}

export interface PrognosisOutcomeRow {
  id: number;
  source_table: string;
  source_id: string;
  source_engine: string | null;
  source: string;
  observed_outcome: string;
  observed_at: string | null;          // YYYY-MM-DD
  horizon_days: number | null;
  matched_complication: number | null; // advisory only — never used to resolve
  matched_complication_hash: string | null;
  classification: string;
  reviewed_by_name: string | null;
  notes: string | null;
  supersedes_id: number | null;
  superseded: boolean;
  created_at: string | null;           // ISO
}

export interface OutcomesLookup {
  /** Every row for the source, superseded included (the history toggle needs them). */
  rows: PrognosisOutcomeRow[];
  /** True when the table could not be read (e.g. migration 0033 not yet run). The panel says
   *  "temporarily unavailable" — an empty list would wrongly read as "no outcomes recorded". */
  unavailable: boolean;
}

function toRow(r: Record<string, unknown>): PrognosisOutcomeRow {
  return {
    id: Number(r.id),
    source_table: String(r.source_table ?? ''),
    source_id: String(r.source_id ?? ''),
    source_engine: r.source_engine == null ? null : String(r.source_engine),
    source: String(r.source ?? ''),
    observed_outcome: String(r.observed_outcome ?? ''),
    observed_at: r.observed_at == null ? null : String(r.observed_at),
    horizon_days: r.horizon_days == null ? null : Number(r.horizon_days),
    matched_complication: r.matched_complication == null ? null : Number(r.matched_complication),
    matched_complication_hash: r.matched_complication_hash == null ? null : String(r.matched_complication_hash),
    classification: String(r.classification ?? ''),
    reviewed_by_name: r.reviewed_by_name == null ? null : String(r.reviewed_by_name),
    notes: r.notes == null ? null : String(r.notes),
    supersedes_id: r.supersedes_id == null ? null : Number(r.supersedes_id),
    superseded: r.superseded === true,
    created_at: r.created_at == null ? null : String(r.created_at),
  };
}

/** All outcome rows for one source document, newest first. Degrades to unavailable, never throws. */
export async function outcomesForSource(sourceTable: OutcomeSourceTable, sourceId: string): Promise<OutcomesLookup> {
  if (!isOutcomeSourceTable(sourceTable) || !sourceId) return { rows: [], unavailable: false };
  try {
    const rows = await run(
      `SELECT id, source_table, source_id, source_engine, source, observed_outcome,
              to_char(observed_at, 'YYYY-MM-DD') AS observed_at, horizon_days,
              matched_complication, matched_complication_hash, classification,
              reviewed_by_name, notes, supersedes_id, superseded,
              to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS created_at
         FROM prognosis_outcomes
        WHERE source_table = $1 AND source_id = $2
        ORDER BY created_at DESC, id DESC`,
      [sourceTable, sourceId],
    );
    return { rows: rows.map(toRow), unavailable: false };
  } catch {
    return { rows: [], unavailable: true };
  }
}

/** What a write needs. `classification` arrives DERIVED (lib/prognosis-outcomes-core.ts), never
 *  typed — the API route derives it server-side from the form state. */
export interface PrognosisOutcomeInput {
  sourceTable: OutcomeSourceTable;
  sourceId: string;
  sourceEngine: string | null;
  source: OutcomeSource;
  observedOutcome: string;
  observedAt: string | null;           // YYYY-MM-DD or null
  /** IGNORED since Addendum A (A-2): horizon_days is DERIVED in SQL on write — observed_at minus
   *  the canonical document's discharged_at in whole days, NULL when either is absent, never
   *  audited_at. The field stays so the API route (outside Addendum A's editable set) keeps
   *  compiling; the store never reads it. */
  horizonDays?: number | null;
  matchedComplication: number | null;  // advisory index at link time
  matchedComplicationHash: string | null;
  classification: OutcomeClassification;
  reviewedByName: string | null;
  notes: string | null;
}

export type WriteResult = { ok: true; id: number } | { ok: false; error: string };

/** The convention the rest of the app writes into app_source (see lib/db's stamper — this table is
 *  deliberately not on its auto-stamp list, so the store stamps explicitly). */
function appSource(): string {
  return process.env.APP_SOURCE || 'standalone';
}

const INSERT_COLUMNS = `(source_table, source_id, source_engine, app_source, source, observed_outcome, observed_at,
   horizon_days, matched_complication, matched_complication_hash, classification,
   reviewed_by_name, notes`;

/**
 * A-2 (Addendum A): horizon_days is DERIVED, not typed — observed_at minus the CANONICAL
 * document's discharged_at, in whole days. The canonical row is A-1's: greatest audited_at
 * carrying a non-empty prognosis.complications array. NULL when observed_at is absent, when the
 * source is not an IPD document, or when the document has no discharged_at (67 of 423 do not —
 * NULL is a normal outcome, not an error). NEVER audited_at: that is the audit date, not the
 * discharge date, and substituting it would silently answer a different question.
 */
const HORIZON_DERIVATION = `CASE WHEN $1 = 'ipd_discharge_audits' AND $7::date IS NOT NULL THEN (
    SELECT ($7::date - d.discharged_at::date)
      FROM ipd_discharge_audits d
     WHERE d.document_id = $2
       AND jsonb_typeof(d.report->'prognosis'->'complications') = 'array'
       AND jsonb_array_length(d.report->'prognosis'->'complications') > 0
     ORDER BY d.audited_at DESC
     LIMIT 1
  ) ELSE NULL END`;

function insertParams(i: PrognosisOutcomeInput): unknown[] {
  return [
    i.sourceTable, i.sourceId, i.sourceEngine ?? null, appSource(), i.source,
    i.observedOutcome, i.observedAt ?? null,
    i.matchedComplication ?? null, i.matchedComplicationHash ?? null, i.classification,
    i.reviewedByName ?? null, i.notes ?? null,
  ];
}

/** Record a new outcome. Append-only: this is the only non-supersede write path. */
export async function insertOutcome(i: PrognosisOutcomeInput): Promise<WriteResult> {
  try {
    const rows = await run(
      `INSERT INTO prognosis_outcomes
  ${INSERT_COLUMNS})
VALUES ($1,$2,$3,$4,$5,$6,$7,
  ${HORIZON_DERIVATION},
  $8,$9,$10,$11,$12)
RETURNING id`,
      insertParams(i),
    );
    const id = Number(rows?.[0]?.id);
    return Number.isFinite(id) ? { ok: true, id } : { ok: false, error: 'insert returned no id' };
  } catch (e) {
    return { ok: false, error: `could not save the outcome (is migration 0033 run?): ${String((e as Error).message).slice(0, 300)}` };
  }
}

/**
 * P-7: correct an entry. ONE atomic statement — the CTE flips `superseded` on the old row (only if
 * it is currently live and belongs to the SAME source document) and the INSERT writes the
 * correction with `supersedes_id`. Nothing updated in place beyond the flag, nothing deleted.
 * A vanished/already-superseded/foreign old row inserts nothing and returns a refusal.
 */
export async function supersedeOutcome(i: PrognosisOutcomeInput, supersedesId: number): Promise<WriteResult> {
  if (!Number.isFinite(supersedesId) || supersedesId <= 0) return { ok: false, error: 'bad supersedesId' };
  try {
    const rows = await run(
      `WITH marked AS (
  UPDATE prognosis_outcomes
     SET superseded = TRUE
   WHERE id = $13 AND superseded = FALSE
     AND source_table = $1 AND source_id = $2
   RETURNING id
)
INSERT INTO prognosis_outcomes
  ${INSERT_COLUMNS}, supersedes_id)
SELECT $1,$2,$3,$4,$5,$6,$7,
  ${HORIZON_DERIVATION},
  $8,$9,$10,$11,$12, marked.id
  FROM marked
RETURNING id`,
      [...insertParams(i), supersedesId],
    );
    const id = Number(rows?.[0]?.id);
    if (!Number.isFinite(id)) {
      return { ok: false, error: 'nothing superseded — the entry was already corrected by someone else, or does not belong to this document. Reload and retry.' };
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: `could not save the correction: ${String((e as Error).message).slice(0, 300)}` };
  }
}
