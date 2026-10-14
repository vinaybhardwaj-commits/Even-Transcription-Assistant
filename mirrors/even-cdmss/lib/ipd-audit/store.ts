/**
 * lib/ipd-audit/store.ts — persist + read IPD discharge-summary audits (Neon
 * `ipd_discharge_audits`, migrations/0013). Mirrors lib/opd-audit-store.ts.
 *
 * Pure DB layer — no LLM calls, no db13 reads. One de-identified row per audited discharge
 * summary, keyed by the db13 miscellaneous_documents doc id. Idempotent UPSERT on
 * (document_id, engine_version): a re-run refreshes the row in place, and the Mini/Qwen
 * backfill coexists with prod rows via its '-mini' engine-version suffix (the proven OPD
 * isolation trick). Link-back keys (document_id/ip_uid/member_id) are re-identification
 * paths into db13 for the admin surface — they are NEVER sent to the LLM.
 */

import { sql } from '../db';
import { canonicalByDocument, specialityCounts, filterBySpeciality } from '../audit-canonical';

/**
 * PROVIDER-SWITCH Unit B (§5, 2 Aug 2026) — deploy-before-migrate tolerance for `provider`.
 *
 * WHY THE COLUMN EXISTS. `model` alone cannot answer "who graded this": the SAME model id arrives
 * by more than one route — `google/gemini-2.5-pro` is Gemini via the OpenRouter bridge,
 * `gemini-2.5-pro` is Gemini via Vertex. When Vertex was disabled on 26 July, and again when the
 * bridge's 110 s ceiling silently degraded every median-or-slower audit to the local model from
 * 30 July, the rows could not say which path had been taken. THAT AMBIGUITY IS A LARGE PART OF WHY
 * A THREE-DAY OUTAGE WENT UNNOTICED.
 *
 * Mirrors opdColumnExists: cache a present result for 300 s, re-probe an absent one after 60 s so
 * the first write after migration 0032 picks it up, and treat a probe ERROR as absent — drop the
 * extra column, never the audit.
 */
const _ipdColProbe = new Map<string, { at: number; present: boolean }>();
async function ipdColumnExists(column: string): Promise<boolean> {
  const now = Date.now();
  const hit = _ipdColProbe.get(column);
  if (hit && now - hit.at < 300_000 && hit.present) return true;
  if (hit && now - hit.at < 60_000) return hit.present;
  try {
    const rows = (await sql(
      `SELECT 1 AS ok FROM information_schema.columns WHERE table_name = 'ipd_discharge_audits' AND column_name = $1`,
      [column],
    )) as Array<{ ok: number }>;
    const present = rows.length > 0;
    _ipdColProbe.set(column, { at: now, present });
    return present;
  } catch {
    _ipdColProbe.set(column, { at: now, present: false });
    return false;
  }
}

// 0.2 (IPD citation fix, PRD CDMSS-IPD-CITATION-FIX-18-JUL-2026): per-finding evidence
// enrichment + re-cite against the enriched pool. Distinguishes fixed rows from the 0.1
// baseline the PR0 benchmark measured (citation-support 0.05). Engine behaviour change.
export const IPD_ENGINE_VERSION = 'ipd-discharge-audit/0.2';
/** Mini/Qwen backfill rows — same engine, model-swapped; invisible to prod reads. */
export const IPD_MINI_ENGINE_VERSION = `${IPD_ENGINE_VERSION}-mini`;

export interface IpdAuditRow {
  // link-back keys
  documentId: string;
  ipUid?: string | null;
  memberId?: string | null;
  speciality?: string | null;
  dischargeType?: string | null;
  losDays?: number | null;
  dischargedAt?: string | null;      // ISO timestamp
  // headline
  careValueIndex: number;
  band: string;
  // 6 domain scores (0..100)
  scoreAppropriateness?: number | null;
  scoreEfficiency?: number | null;
  scoreSafety?: number | null;
  scoreCost?: number | null;
  scoreDocumentation?: number | null;
  scorePatientCentred?: number | null;
  // detail
  completenessPct?: number | null;
  nFindings?: number;
  nLowValue?: number;
  nContextDependent?: number;
  findings?: unknown;
  suggestions?: unknown;
  report?: unknown;                  // FULL de-identified AuditReport (0014) — powers the report page render
  billedTotal?: number | null;       // M3 billing join; null until then
  // provenance
  engineVersion?: string;            // defaults IPD_ENGINE_VERSION
  model?: string | null;
  /** Unit B — the PROVIDER that served the call. From what actually answered, never a constant. */
  provider?: string | null;
  traceId?: string | null;
}

/** Upsert one audit. Returns 'inserted' | 'updated' (re-run at the same engine version) | 'skipped' (no document id). */
export async function saveIpdAudit(row: IpdAuditRow): Promise<'inserted' | 'updated' | 'skipped'> {
  if (!row.documentId) return 'skipped';
  const engine = row.engineVersion || IPD_ENGINE_VERSION;
  const withProvider = await ipdColumnExists('provider');
  const rows = (await sql(
    `INSERT INTO ipd_discharge_audits
      (document_id, ip_uid, member_id, speciality, discharge_type, los_days, discharged_at,
       care_value_index, band,
       score_appropriateness, score_efficiency, score_safety, score_cost, score_documentation, score_patient_centred,
       completeness_pct, n_findings, n_low_value, n_context_dependent,
       findings, suggestions, report, billed_total, engine_version, model, trace_id${withProvider ? ', provider' : ''})
     VALUES ($1,$2,$3,$4,$5,$6,$7, $8,$9, $10,$11,$12,$13,$14,$15,
       $16,$17,$18,$19, $20::jsonb,$21::jsonb,$22::jsonb,$23,$24,$25,$26${withProvider ? ', $27' : ''})
     ON CONFLICT (document_id, engine_version) DO UPDATE SET
       ip_uid = EXCLUDED.ip_uid, member_id = EXCLUDED.member_id, speciality = EXCLUDED.speciality,
       discharge_type = EXCLUDED.discharge_type, los_days = EXCLUDED.los_days, discharged_at = EXCLUDED.discharged_at,
       care_value_index = EXCLUDED.care_value_index, band = EXCLUDED.band,
       score_appropriateness = EXCLUDED.score_appropriateness, score_efficiency = EXCLUDED.score_efficiency,
       score_safety = EXCLUDED.score_safety, score_cost = EXCLUDED.score_cost,
       score_documentation = EXCLUDED.score_documentation, score_patient_centred = EXCLUDED.score_patient_centred,
       completeness_pct = EXCLUDED.completeness_pct, n_findings = EXCLUDED.n_findings,
       n_low_value = EXCLUDED.n_low_value, n_context_dependent = EXCLUDED.n_context_dependent,
       findings = EXCLUDED.findings, suggestions = EXCLUDED.suggestions, report = EXCLUDED.report,
       billed_total = EXCLUDED.billed_total, model = EXCLUDED.model,${withProvider ? ' provider = EXCLUDED.provider,' : ''} trace_id = EXCLUDED.trace_id,
       audited_at = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [
      row.documentId, row.ipUid ?? null, row.memberId ?? null, row.speciality ?? null,
      row.dischargeType ?? null, row.losDays ?? null, row.dischargedAt ?? null,
      Math.round(row.careValueIndex), row.band,
      row.scoreAppropriateness ?? null, row.scoreEfficiency ?? null, row.scoreSafety ?? null,
      row.scoreCost ?? null, row.scoreDocumentation ?? null, row.scorePatientCentred ?? null,
      row.completenessPct ?? null, row.nFindings ?? 0, row.nLowValue ?? 0, row.nContextDependent ?? 0,
      JSON.stringify(row.findings ?? []), JSON.stringify(row.suggestions ?? []),
      row.report != null ? JSON.stringify(row.report) : null,
      row.billedTotal ?? null, engine, row.model ?? null, row.traceId ?? null,
      // Unit B — null is a legitimate stored value ("not attributed"), never the string 'null'.
      ...(withProvider ? [row.provider ?? null] : []),
    ],
  )) as Array<{ inserted: boolean }>;
  return rows.length ? (rows[0].inserted ? 'inserted' : 'updated') : 'skipped';
}

// ── Unit V-a2 (4 Aug 2026): the IPD failure ledger — a SEPARATE table, purely observational ─────
//
// ⚠️ NEVER a row in `ipd_discharge_audits`. Two reasons, both checked in source:
//   1. auditedDocIdsAnyVersion (below) is a bare SELECT DISTINCT document_id with NO exclusion
//      filter — a marked row would make the sweep skip that document FOREVER (the trap OPD needed
//      addendum F v2 task 2 to escape).
//   2. buildIpdAuditRow throws when the report has no valueScore (assemble.ts) — a failed audit
//      has no report, so there is no row to build.
// IPD resumability already works precisely BECAUSE a failure writes nothing; the gap this ledger
// closes is VISIBILITY, not resumability. The table is created by /api/admin/migrate-lab-views
// (additive + idempotent); its name passes BLOCKED_RELATIONS so audit_query can read it.

/** The `error` cap for a ledger row. Follows the PROVIDER_ERROR_CAP posture (never truncate a
 *  diagnostic to 200 chars) at half its size — a provider message, NEVER clinical text (no PHI). */
export const IPD_FAILURE_ERROR_CAP = 2000;

export interface IpdAuditFailureInput {
  documentId: string;
  engineVersion?: string | null;
  stage?: string | null;
  provider?: string | null;
  error?: string | null;
  traceId?: string | null;
}

/** Write one failure row. BEST-EFFORT, following persistEpisodeState's posture: a ledger write
 *  must never fail an audit that otherwise succeeded, and never throw — including before the
 *  migration has created the table (the catch swallows the missing-relation error). */
export async function recordIpdAuditFailure(f: IpdAuditFailureInput): Promise<void> {
  try {
    if (!f.documentId) return;
    await sql(
      `INSERT INTO ipd_audit_failures (document_id, engine_version, stage, provider, error, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        f.documentId, f.engineVersion ?? null, f.stage ?? null, f.provider ?? null,
        f.error != null ? String(f.error).slice(0, IPD_FAILURE_ERROR_CAP) : null,
        f.traceId ?? null,
      ],
    );
  } catch { /* best-effort — observability must never break the audit path */ }
}

/** Read one audit by row id. Deliberately NO engine-version filter, so mini rows are
 *  viewable by id exactly like OPD's. Null if not found. */
export async function getIpdAudit(id: string): Promise<Record<string, unknown> | null> {
  if (!id) return null;
  const rows = (await sql(
    `SELECT * FROM ipd_discharge_audits WHERE id = $1 LIMIT 1`, [id],
  )) as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

// ── recompute-on-read (Scoring policy Phase A, decision §1.1) ────────────────────────────────────
//
// Historical scores are RECOMPUTED, never rewritten. `completeness_pct` becomes derived: the stored
// per-field statuses in `report.completeness.items` are re-scored under the ACTIVE weights version,
// and the Care-Value Index + band are rebuilt from the stored domain scores with the new
// documentation value substituted. Nothing is mutated; this is a pure read-side transform.
//
// FAIL-SAFE (PRD §8.1): if the policy layer cannot be read — table missing, migration not yet run,
// DB error — getActivePolicy returns the equal-weights fallback, which reproduces legacy scoring
// EXACTLY (PRD §2.5). A weighting failure therefore degrades to today's system, invisibly. This
// function additionally wraps the whole transform so a malformed `report` returns the row UNCHANGED
// rather than throwing into a page render.

/** The row plus its derived fields. The original stored values are preserved under `stored_*` so a
 *  surface can show both (PRD §6.5 shows the weighted and unweighted numbers side by side). */
export interface RecomputedIpdRow extends Record<string, unknown> {
  completeness_pct: number | null;
  care_value_index: number | null;
  band: string | null;
  stored_completeness_pct: number | null;
  stored_care_value_index: number | null;
  stored_band: string | null;
  weights_version: string | null;
  /** applicable-field count and the unweighted NABH gap list, for the detail panel. */
  nabh_applicable: number | null;
  nabh_missing: string[] | null;
}

/**
 * Apply the active weights to a batch of already-fetched rows. ONE policy read for the whole batch
 * (module-cached, 60s TTL) and then pure arithmetic — no extra DB round-trip per row (PRD §4).
 *
 * Rows whose `report` carries no completeness items are returned untouched apart from the
 * `stored_*` mirrors, because there is nothing to re-weight.
 */
export async function applyScoringPolicy<T extends Record<string, unknown>>(rows: T[]): Promise<(T & RecomputedIpdRow)[]> {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];
  try {
    const { getActivePolicy, extractItems } = await import('../scoring-policy/store');
    const { weightedCompleteness, DISCHARGE_SUMMARY_COND_KEYS } = await import('../scoring-policy/completeness');
    const { recomputeIpdIndex } = await import('../scoring-policy/recompute');
    const policy = await getActivePolicy('discharge_summary');

    return list.map((r) => {
      const storedCompleteness = r.completeness_pct == null ? null : Number(r.completeness_pct);
      const storedIndex = r.care_value_index == null ? null : Number(r.care_value_index);
      const storedBand = r.band == null ? null : String(r.band);
      const base = {
        ...r,
        stored_completeness_pct: storedCompleteness,
        stored_care_value_index: storedIndex,
        stored_band: storedBand,
        weights_version: policy.fallback ? null : policy.versionString,
        nabh_applicable: null as number | null,
        nabh_missing: null as string[] | null,
      };
      const items = extractItems(r.report);
      if (!items.length) return base as T & RecomputedIpdRow;

      const c = weightedCompleteness(items, policy.vector, { condKeys: DISCHARGE_SUMMARY_COND_KEYS });
      const idx = recomputeIpdIndex(
        {
          appropriateness: numOrNull(r.score_appropriateness),
          efficiency: numOrNull(r.score_efficiency),
          safety: numOrNull(r.score_safety),
          cost: numOrNull(r.score_cost),
          documentation: c.pct,
          patient_centred: numOrNull(r.score_patient_centred),
        },
        c.pct,
      );
      return {
        ...base,
        completeness_pct: c.pct,
        score_documentation: c.pct,
        care_value_index: idx.index,
        band: idx.band,
        nabh_applicable: c.applicable,
        nabh_missing: c.missingMandatory,
      } as T & RecomputedIpdRow;
    });
  } catch {
    // Never let a scoring-policy fault cost a page render. Return the rows as stored.
    return list.map((r) => ({
      ...r,
      stored_completeness_pct: r.completeness_pct == null ? null : Number(r.completeness_pct),
      stored_care_value_index: r.care_value_index == null ? null : Number(r.care_value_index),
      stored_band: r.band == null ? null : String(r.band),
      weights_version: null,
      nabh_applicable: null,
      nabh_missing: null,
    })) as (T & RecomputedIpdRow)[];
  }
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Single-row convenience for the report detail page. Never throws. */
export async function getIpdAuditWeighted(id: string): Promise<(Record<string, unknown> & RecomputedIpdRow) | null> {
  const row = await getIpdAudit(id);
  if (!row) return null;
  const [out] = await applyScoringPolicy([row]);
  return out ?? null;
}

// ── Phase B — list filters (PRD §6.1, §6.2, §6.4) ────────────────────────────────────────────────
//
// The recompute wrapper above is UNTOUCHED by this phase; these add the parameters the IPD list and
// calendar filter on. Everything is parameterised ($n) — no value is interpolated into SQL.

export type ReviewedFilter = 'all' | 'reviewed' | 'not_reviewed';
export type RangePreset = 'this_month' | 'last_month' | 'last_3_months' | 'custom';

export interface IpdListFilters {
  /** Raw `speciality` value, or the literal 'Unassigned' for the 4 null rows (§6.1). */
  speciality?: string | null;
  range?: RangePreset;
  /** Only read when range === 'custom'; YYYY-MM-DD. */
  from?: string | null;
  to?: string | null;
  reviewed?: ReviewedFilter;
  limit?: number;
}

/** §6.1 — the literal option that selects rows whose speciality IS NULL. */
export const UNASSIGNED_SPECIALITY = 'Unassigned';

const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * PURE — resolve a preset to an IST date window. Exported so the range arithmetic is unit-tested
 * without a database. `now` is injectable for exactly that reason.
 *
 * Dates are IST calendar days, matching every other date filter on this surface
 * (`discharged_at AT TIME ZONE 'Asia/Kolkata'`).
 */
export function resolveRange(
  preset: RangePreset | undefined,
  from?: string | null,
  to?: string | null,
  now: Date = new Date(),
): { from: string; to: string } | null {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);   // shift to IST wall-clock
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth(), d = ist.getUTCDate();
  const fmt = (yy: number, mm: number, dd: number) =>
    `${yy}-${String(mm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const lastDay = (yy: number, mm: number) => new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();

  switch (preset) {
    case 'this_month':
      return { from: fmt(y, m, 1), to: fmt(y, m, d) };
    case 'last_month': {
      const pm = m === 0 ? 11 : m - 1;
      const py = m === 0 ? y - 1 : y;
      return { from: fmt(py, pm, 1), to: fmt(py, pm, lastDay(py, pm)) };
    }
    case 'custom':
      // A half-open custom range is honoured on the side that IS given rather than silently
      // widening to everything — the user asked for a bound and should get it.
      if (!isDay(from) && !isDay(to)) return null;
      return { from: isDay(from) ? from : '1970-01-01', to: isDay(to) ? to : fmt(y, m, d) };
    case 'last_3_months':
    default: {
      // Default (§6.2). Three calendar months back, inclusive of today.
      const start = new Date(Date.UTC(y, m - 2, 1));
      return { from: fmt(start.getUTCFullYear(), start.getUTCMonth(), 1), to: fmt(y, m, d) };
    }
  }
}

/** The slim projection every canonical read starts from. Cheap enough to fetch for a whole range. */
const CANONICAL_SLIM = `id, document_id, engine_version, model, speciality,
        to_char(audited_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS audited_at`;
const CANONICAL_SCAN_CAP = 5000;

/**
 * ═══ THE ONE CANONICAL FETCH (PRD §1.2, B-1/B-2) ═══
 *
 * Every count, list and aggregate on this surface starts here: the audits in a date range, reduced
 * to ONE ROW PER DOCUMENT by lib/ipd-audit/canonical.ts. The speciality chips and the list are then
 * both derived from THIS array, so they cannot disagree — which is precisely the defect B-1
 * recorded ("Orthopedics · 27" beside "22 in range").
 *
 * ⚠️ NOTE WHAT CHANGED. This deliberately does NOT filter `engine_version = <current>`. That
 * equality filter made the de-duplication a no-op (UNIQUE(document_id, engine_version) means one
 * row per document per version) AND hid every document that was only ever audited at 0.1. Ranking
 * per document is what the settled rule asks for, and it surfaces those older-only documents for
 * the first time. Mini/Qwen backfill rows stay excluded, as they always have been.
 *
 * INFERRED SQL — columns from migrations/0013.
 *   SELECT id, document_id, engine_version, speciality, audited_at
 *     FROM ipd_discharge_audits
 *    WHERE (coalesce(discharged_at, audited_at) AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1 AND $2
 *    ORDER BY coalesce(discharged_at, audited_at) DESC LIMIT 5000
 */
export async function canonicalAuditsInRange(filters: IpdListFilters = {}): Promise<Record<string, unknown>[]> {
  const range = resolveRange(filters.range, filters.from, filters.to);
  const params: unknown[] = [];
  let where = '';
  if (range) {
    params.push(range.from, range.to);
    where = `WHERE (coalesce(discharged_at, audited_at) AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date`;
  }
  try {
    const rows = (await sql(
      `SELECT ${CANONICAL_SLIM}
         FROM ipd_discharge_audits
         ${where}
        ORDER BY coalesce(discharged_at, audited_at) DESC
        LIMIT ${CANONICAL_SCAN_CAP}`,
      params,
    )) as Array<Record<string, unknown>>;
    return canonicalByDocument(rows);
  } catch {
    return [];
  }
}

/**
 * The speciality chips (§6.1) — raw values, count descending, `Unassigned` for the nulls, NO
 * normalisation in v1.
 *
 * Derived from the canonical rows for the SAME range the list uses. Two things were wrong before:
 * the counts ignored the date range entirely (they were all-time, which is the larger half of the
 * 27-vs-22 gap), and they counted audit rows rather than documents.
 */
export async function specialityOptions(filters: IpdListFilters = {}): Promise<{ speciality: string; n: number }[]> {
  const rows = await canonicalAuditsInRange(filters);
  return specialityCounts(rows, UNASSIGNED_SPECIALITY);
}

/**
 * The filtered audit list. Returns rows ALREADY put through the Phase A recompute wrapper, so a
 * caller can never accidentally render an unweighted score.
 *
 * INFERRED SQL — all columns from migrations/0013 + 0014 (`report`), plus a LEFT JOIN onto
 * ipd_audit_feedback for the reviewed marker (0028).
 *
 * The reviewed join is written as a correlated EXISTS rather than a JOIN so a duplicate review row
 * can never multiply the result set — the partial unique index makes duplicates impossible, but the
 * query should not depend on an index for its row count.
 *
 * ⚠️ `kind` does not exist until 0028 runs. The whole query is wrapped: on ANY failure this falls
 * back to the unfiltered-by-reviewed query, and if that fails too, to []. The list never 500s.
 */
/**
 * The filtered audit list. Returns rows ALREADY put through the Phase A recompute wrapper, so a
 * caller can never accidentally render an unweighted score.
 *
 * ═══ ONE ROW PER DOCUMENT (PRD §1.2) ═══
 * The canonical id set is chosen by `canonicalAuditsInRange` — the SAME call that produces the
 * speciality chip counts — and the full rows are then fetched BY THOSE IDS. The chip and the list
 * therefore count the same things by construction; there is no second query to drift.
 *
 * INFERRED SQL — columns from migrations/0013 + 0014 (`report`), plus a correlated EXISTS onto
 * ipd_audit_feedback for the reviewed marker (0028). EXISTS rather than a JOIN so a duplicate
 * review row can never multiply the result set.
 *
 * ⚠️ `kind` does not exist until 0028 runs. The query is wrapped: on ANY failure it falls back to
 * the same list WITHOUT the reviewed marker, and if that fails too, to []. The list never 500s.
 */
export async function listIpdAudits(
  filters: IpdListFilters = {},
): Promise<(Record<string, unknown> & RecomputedIpdRow)[]> {
  return (await ipdWorklist(filters)).rows;
}

/**
 * Fetch the full rows for an explicit, already-canonical id set, with the reviewed marker.
 *
 * INFERRED SQL — columns from migrations/0013 + 0014 (`report`), plus a correlated EXISTS onto
 * ipd_audit_feedback (0028). EXISTS rather than a JOIN so a duplicate review row can never
 * multiply the result set.
 *
 * ⚠️ `kind` does not exist until 0028 runs. On ANY failure this falls back to the same query
 * WITHOUT the reviewed marker, and if that fails too, to []. The list never 500s.
 */
async function fetchAuditsByIds(
  ids: string[],
  reviewedFilter?: ReviewedFilter,
): Promise<(Record<string, unknown> & RecomputedIpdRow)[]> {
  const clean = (ids || []).filter((i) => /^[0-9a-f-]{36}$/i.test(i));
  if (!clean.length) return [];
  const reviewed: ReviewedFilter = reviewedFilter === 'reviewed' || reviewedFilter === 'not_reviewed' ? reviewedFilter : 'all';

  const SELECT = `SELECT a.id, a.ip_uid, a.speciality, a.care_value_index, a.band, a.completeness_pct,
            a.score_appropriateness, a.score_efficiency, a.score_safety, a.score_cost,
            a.score_documentation, a.score_patient_centred, a.report,
            a.n_low_value, a.n_context_dependent, a.engine_version, a.model, a.document_id,
            to_char(a.discharged_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS discharged_day,
            to_char(a.audited_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI') AS audited`;
  const FROM = `FROM ipd_discharge_audits a WHERE a.id = ANY($1::uuid[])`;
  const ORDER = `ORDER BY coalesce(a.discharged_at, a.audited_at) DESC`;
  const reviewedExists = `EXISTS (SELECT 1 FROM ipd_audit_feedback f WHERE f.audit_id = a.id AND f.kind = 'review')`;
  const reviewedPredicate = reviewed === 'reviewed' ? ` AND ${reviewedExists}`
    : reviewed === 'not_reviewed' ? ` AND NOT ${reviewedExists}` : '';

  const withReviewed = `${SELECT},
            ${reviewedExists} AS reviewed,
            (SELECT f2.reviewed_by_name FROM ipd_audit_feedback f2 WHERE f2.audit_id = a.id AND f2.kind = 'review' LIMIT 1) AS reviewed_by_name
     ${FROM}${reviewedPredicate} ${ORDER}`;
  const withoutReviewed = `${SELECT}, FALSE AS reviewed, NULL::text AS reviewed_by_name ${FROM} ${ORDER}`;

  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = (await sql(withReviewed, [clean])) as Array<Record<string, unknown>>;
  } catch {
    try { rows = (await sql(withoutReviewed, [clean])) as Array<Record<string, unknown>>; } catch { rows = []; }
  }
  // Defence in depth: the id set is already canonical, so this is a no-op — but it means no future
  // edit to the fetch can reintroduce a duplicate document silently.
  return applyScoringPolicy(canonicalByDocument(rows));
}

/**
 * ONE fetch, three answers — the worklist rows, the true total in range, and the speciality chips.
 *
 * This is the shape B-1 asks for: the chip count and the doctor view's "N in range" are literally
 * the same number, read off the same array. They cannot drift, because there is nothing to drift
 * from. `total` is the canonical count for the CURRENT speciality filter; `rows` may be shorter
 * when the display cap bites, and the caller says so rather than showing a smaller number.
 */
export async function ipdWorklist(filters: IpdListFilters = {}): Promise<{
  rows: (Record<string, unknown> & RecomputedIpdRow)[];
  total: number;
  specialities: { speciality: string; n: number }[];
  capped: boolean;
}> {
  const limit = Math.max(1, Math.min(500, Math.floor(Number(filters.limit) || 200)));
  const canonical = await canonicalAuditsInRange(filters);
  const specialities = specialityCounts(canonical, UNASSIGNED_SPECIALITY);
  const scoped = filterBySpeciality(canonical, filters.speciality, UNASSIGNED_SPECIALITY);
  const rows = await fetchAuditsByIds(scoped.slice(0, limit).map((r) => String(r.id)), filters.reviewed);
  return { rows, total: scoped.length, specialities, capped: scoped.length > rows.length };
}

/**
 * Overview aggregates for a window (§1.2: "every aggregate"). Rows are fetched, reduced to one per
 * document, and aggregated IN TS with the same pure helper the list uses — deliberately not a SQL
 * GROUP BY, because a second implementation of the rule is exactly what B-1 was.
 *
 * INFERRED SQL — columns from migrations/0013.
 */
export async function ipdOverviewStats(from: string, to: string): Promise<{
  total: number; meanCvi: number; meanCompleteness: number; lowValue: number; contextDependent: number;
  domains: Record<string, number | null>; bands: { band: string; n: number }[];
}> {
  const empty = { total: 0, meanCvi: 0, meanCompleteness: 0, lowValue: 0, contextDependent: 0, domains: {}, bands: [] };
  try {
    const raw = (await sql(
      `SELECT id, document_id, engine_version, model, band, care_value_index, completeness_pct,
              n_low_value, n_context_dependent,
              score_appropriateness, score_efficiency, score_safety, score_cost,
              score_documentation, score_patient_centred,
              to_char(audited_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS audited_at
         FROM ipd_discharge_audits
        WHERE (coalesce(discharged_at, audited_at) AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
        LIMIT ${CANONICAL_SCAN_CAP}`,
      [from, to],
    )) as Array<Record<string, unknown>>;
    const rows = canonicalByDocument(raw);
    if (!rows.length) return empty;
    const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const mean = (key: string) => {
      const vals = rows.map((r) => num(r[key])).filter((n): n is number => n != null);
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    };
    const bandMap = new Map<string, number>();
    for (const r of rows) { const b = String(r.band ?? ''); if (b) bandMap.set(b, (bandMap.get(b) ?? 0) + 1); }
    return {
      total: rows.length,
      meanCvi: mean('care_value_index') ?? 0,
      meanCompleteness: mean('completeness_pct') ?? 0,
      lowValue: rows.reduce((s, r) => s + (num(r.n_low_value) ?? 0), 0),
      contextDependent: rows.reduce((s, r) => s + (num(r.n_context_dependent) ?? 0), 0),
      domains: {
        score_appropriateness: mean('score_appropriateness'), score_efficiency: mean('score_efficiency'),
        score_safety: mean('score_safety'), score_cost: mean('score_cost'),
        score_documentation: mean('score_documentation'), score_patient_centred: mean('score_patient_centred'),
      },
      bands: [...bandMap.entries()].map(([band, n]) => ({ band, n })).sort((a, b) => a.band.localeCompare(b.band)),
    };
  } catch {
    return empty;
  }
}

/**
 * Calendar: audited counts per IST day for a month, and the per-document winner used by the day
 * rail. Both deduped by the same rule, so the heat cell and the rail agree.
 */
export async function ipdAuditedByDay(month: string, speciality?: string | null): Promise<{
  byDay: Record<string, number>;
  byDocument: Record<string, { id: string; band: string; cvi: number }>;
}> {
  if (!/^\d{4}-\d{2}$/.test(month)) return { byDay: {}, byDocument: {} };
  try {
    const raw = (await sql(
      `SELECT id, document_id, engine_version, model, band, care_value_index, speciality,
              to_char((coalesce(discharged_at, audited_at) AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS d,
              to_char(audited_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS audited_at
         FROM ipd_discharge_audits
        WHERE to_char((coalesce(discharged_at, audited_at) AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM') = $1
        LIMIT ${CANONICAL_SCAN_CAP}`,
      [month],
    )) as Array<Record<string, unknown>>;
    const canonical = canonicalByDocument(raw);
    const scoped = filterBySpeciality(canonical, speciality, UNASSIGNED_SPECIALITY);
    const byDay: Record<string, number> = {};
    for (const r of scoped) { const d = String(r.d ?? ''); if (d) byDay[d] = (byDay[d] ?? 0) + 1; }
    // The day rail marks a DOCUMENT as audited regardless of the speciality filter — filtering it
    // would misrepresent an audited summary as un-audited (the §1.2 B-4 note on this surface).
    const byDocument: Record<string, { id: string; band: string; cvi: number }> = {};
    for (const r of canonical) {
      const doc = String(r.document_id ?? '');
      if (doc) byDocument[doc] = { id: String(r.id), band: String(r.band ?? ''), cvi: Number(r.care_value_index ?? 0) };
    }
    return { byDay, byDocument };
  } catch {
    return { byDay: {}, byDocument: {} };
  }
}

/**
 * Reviews for a set of audit ids — the list chip and the report panel read this.
 * Never throws; returns {} before 0028 runs.
 */
export async function reviewsForAudits(auditIds: string[]): Promise<Record<string, { note: string; reviewedByName: string | null; at: string | null }>> {
  const ids = Array.from(new Set((auditIds || []).filter((i) => /^[0-9a-f-]{36}$/i.test(i))));
  if (!ids.length) return {};
  try {
    const rows = (await sql(
      `SELECT audit_id, note, reviewed_by_name,
              to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS created_at
         FROM ipd_audit_feedback
        WHERE kind = 'review' AND audit_id = ANY($1::uuid[])`,
      [ids],
    )) as Array<Record<string, unknown>>;
    const out: Record<string, { note: string; reviewedByName: string | null; at: string | null }> = {};
    for (const r of rows) {
      out[String(r.audit_id)] = {
        note: String(r.note ?? ''),
        reviewedByName: r.reviewed_by_name == null ? null : String(r.reviewed_by_name),
        at: r.created_at == null ? null : String(r.created_at),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** document_ids already audited (at this engine version) for an IST calendar day (by discharge
 *  date) — the daily worker's exclude set. */
export async function auditedDocIdsForDay(day: string, engineVersion: string = IPD_ENGINE_VERSION): Promise<string[]> {
  const rows = (await sql(
    `SELECT document_id FROM ipd_discharge_audits
     WHERE engine_version = $1 AND (discharged_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date`,
    [engineVersion, day],
  )) as Array<{ document_id: string }>;
  return rows.map((r) => r.document_id).filter(Boolean);
}

/** document_ids audited at ANY engine version — the "already audited at all" set.
 *  Both S5 and S6 exclude on this: the Gemini worker only ever audits GENUINELY NEW docs, and
 *  the Mini backfill never re-audits what prod already has (the OPD division of labour). */
export async function auditedDocIdsAnyVersion(): Promise<string[]> {
  const rows = (await sql(`SELECT DISTINCT document_id FROM ipd_discharge_audits`)) as Array<{ document_id: string }>;
  return rows.map((r) => r.document_id).filter(Boolean);
}

/** Count audited (any engine version) — the backfill's progress numerator. */
export async function auditedCountAnyVersion(): Promise<number> {
  const rows = (await sql(`SELECT count(DISTINCT document_id)::int AS n FROM ipd_discharge_audits`)) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/** Earliest IST day (by discharge date) that has any audit — the floor for the gap-fill sweep.
 *  Null if nothing audited yet. */
export async function earliestAuditedDay(): Promise<string | null> {
  const rows = (await sql(
    `SELECT to_char(min((discharged_at AT TIME ZONE 'Asia/Kolkata')::date),'YYYY-MM-DD') AS d FROM ipd_discharge_audits`,
  )) as Array<{ d: string | null }>;
  return rows[0]?.d ?? null;
}
