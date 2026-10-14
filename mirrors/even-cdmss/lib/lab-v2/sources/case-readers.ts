/**
 * lib/lab-v2/sources/case-readers.ts — the narrow production reads behind `case_ask` and
 * `case_timeline` (LAB-MCP-V2-PRD-v1.0 §17.11, decisions 141 and 146).
 *
 * WHAT THIS FILE IS FOR. Four engines already store a per-case audit row, and every existing
 * reader of those rows was written for a CLINICIAN'S SURFACE: `fetchFindingForSurface`
 * (`lib/readmission/store.ts:468`) returns both doctors' names, both encounter ids and the case
 * manager's note; `getFinding` (`lib/preop/store.ts:356`) is `SELECT *` over a table carrying
 * `patient_name`, `uhid`, `individual_uid` and three prose lines; `getIpdAuditByVersion`
 * (`lib/ipd-audit/store.ts:212`) is `SELECT *` including `ip_uid`, `member_id` and the whole
 * `report`. Every one of them is correct where it is and unusable here.
 *
 * ⚠️ SO NONE OF THEM IS CALLED. Decision 146: these two tools never pass a reader's row through.
 * Each statement below names its columns, and the columns it does NOT name are the point of it —
 * `cm_note`, `finding`, `omission_evidence`, `why_line`, `missing_line`, `situation_line`,
 * `patient_name`, `surgeon`, both doctor names, `rawText` and `courseSummary` are never SELECTed,
 * so no free-text column is ever read into this process, let alone returned. The de-identifying
 * step is the statement itself rather than a filter after it: a filter can be forgotten, and a
 * column that was never selected cannot leak through a new field on an output schema.
 *
 * ⚠️ THE IDENTIFIER IS AN ARGUMENT, NEVER A RETURN VALUE. A `uhid`, a `member_id` or an
 * `individual_uid` arrives as a bind parameter, resolves rows, and is replaced in the response by
 * the salted `member_key` every other object in this platform is keyed by (`sources/opd.ts:75-77`).
 * `document_id` and `ip_uid` ARE selected — the `episode_states` join needs the second and the
 * first orders the rows — and neither reaches a caller. `identifyingKeys()` runs over the whole
 * response in `tools/case.ts` as the check on that claim, not as the mechanism.
 *
 * ⚠️ EVERY STATEMENT HERE IS INFERRED (decision 87), and each is exercised once in
 * `d3-case-readers.test.ts` against a PGlite table built from the DDL that creates the real one:
 * `app/api/admin/migrate-readmissions/route.ts:86`, `app/api/admin/migrate-preop/route.ts:45-85`,
 * `migrations/0016_episode_states.sql:13-25`, and `lib/ipd-audit/store.ts:110-115`'s own insert
 * column list for `ipd_discharge_audits`. The fixtures are shaped from production rows with every
 * id replaced. No live Neon was available to the builder, so the statements are listed verbatim in
 * the round report and the PGlite exercise is the evidence that they parse and select what they say.
 *
 * ⚠️ FAIL-SAFE: every read error is `SOURCE_UNAVAILABLE` with a short reason, never a partial
 * answer and never an empty result dressed as "no audit". `boundedRead` (`sources/read.ts:54`)
 * supplies both the read-only guard and decision 31's 15 s deadline, so nothing here can run
 * unguarded or hang a 60 s route into a 504.
 *
 * NO WRITE. Every statement is a SELECT; `guardReadOnlySql` refuses anything else before it runs.
 */
import { LabError } from '../contracts';
import { boundedRead } from './read';
import { metabaseQuery } from '../../metabase';

/** Decision 141 — the three identifier kinds, and nothing else resolves a case. */
export const IDENTIFIER_KINDS = ['uhid', 'member_id', 'individual_uid'] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/** The four engines that store a per-case audit row this platform can read. */
export const CASE_ENGINES = ['readmission', 'preop', 'opd_note_audit', 'ipd_discharge'] as const;
export type CaseEngine = (typeof CASE_ENGINES)[number];

/**
 * DECISION 141 — which engines key on which identifier, and the whole of cross-family resolution.
 *
 * ⚠️ THERE IS NO JOIN BETWEEN THE FAMILIES HERE, DELIBERATELY. A `uhid` and a `member_id` name the
 * same person in db13 and this platform cannot prove that from Neon alone; decision 141 defers the
 * resolution to a later round after a db13 survey rather than inventing a link whose failure mode
 * would be attributing one person's episode to another.
 */
export const ENGINES_BY_KIND: Record<IdentifierKind, readonly CaseEngine[]> = {
  uhid: ['readmission', 'preop'],
  member_id: ['ipd_discharge'],
  individual_uid: ['opd_note_audit'],
};

/** The one kind each engine's own table is keyed by. `case_ask` refuses any other. */
export const KIND_BY_ENGINE: Record<CaseEngine, IdentifierKind> = {
  readmission: 'uhid',
  preop: 'uhid',
  opd_note_audit: 'individual_uid',
  ipd_discharge: 'member_id',
};

// ─────────────────────────────────────────────────────────────────────────────────────
// The statements. INFERRED, one per engine per shape, narrow, parameterised.
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Readmission, newest AUDITED finding for one uhid.
 *
 * ⚠️ `audit_status = 'audited'` IS PART OF THE QUESTION, NOT AN OPTIMISATION. A `detected` row is a
 * pair the detector found and the engine has not judged; returning one as an answer to "what did
 * the audit say about this person" would report a blank as a verdict. `lib/readmission/run.ts`
 * moves the column detected → audited, and the surface reader checks the same value.
 *
 * Sixteen columns, and the three that are NOT here are the reason the statement exists:
 * `cm_note` (the case manager's typed note), `finding` (the engine's prose object) and
 * `omission_evidence` (quoted chart lines). `index_doctor`, `readmit_doctor`, both encounter ids
 * and `uhid` itself are likewise absent.
 */
export const READMISSION_CASE_SQL = `SELECT dedup_key, engine_version,
       to_char(audited_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS audited_at,
       finding_class, lane, audit_status, gap_days,
       planned, same_condition, avoidable, lab_tier, n_omissions,
       needs_human_review, promoted_to_full, preventable_injury, negligence
  FROM readmission_findings
 WHERE uhid = $1 AND audit_status = 'audited'
 ORDER BY audited_at DESC NULLS LAST
 LIMIT 1`;

/** The same row shape, the whole history for one uhid, newest first. `case_timeline`'s readmission leg. */
export const READMISSION_TIMELINE_SQL = `SELECT dedup_key, engine_version,
       to_char(audited_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS audited_at,
       finding_class, lane, audit_status, gap_days,
       avoidable, n_omissions, preventable_injury
  FROM readmission_findings
 WHERE uhid = $1
 ORDER BY audited_at DESC NULLS LAST
 LIMIT 50`;

/**
 * Preop, newest computed finding for one uhid.
 *
 * ⚠️ `preop_findings` IS THE MOST IDENTIFYING TABLE THIS PLATFORM READS — `patient_name`, `uhid`,
 * `individual_uid`, `surgeon`, `age` and `sex` all sit on it, and its production reader is
 * `SELECT *`. Sixteen columns are named; the six above and the three prose lines
 * (`why_line`, `missing_line`, `situation_line`) and the whole `snapshot` jsonb are not among them.
 */
export const PREOP_CASE_SQL = `SELECT episode_key, engine_version,
       to_char(computed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS computed_at,
       tier, rcri_lo, rcri_hi, mfi_lo, mfi_hi, cci_lo, cci_hi,
       needs_review, booking_only, pac_on_file, pac_status, pac_verdict
  FROM preop_findings
 WHERE uhid = $1
 ORDER BY computed_at DESC NULLS LAST
 LIMIT 1`;

export const PREOP_TIMELINE_SQL = `SELECT episode_key, engine_version,
       to_char(computed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS computed_at,
       tier, needs_review, booking_only, pac_on_file, pac_status, pac_verdict
  FROM preop_findings
 WHERE uhid = $1
 ORDER BY computed_at DESC NULLS LAST
 LIMIT 50`;

/**
 * OPD, newest audit over the note uids one `individual_uid` owns.
 *
 * The findings sub-select is `sources/audits.ts:191-207`'s projection minus its prose fields: four
 * keys per finding and no `rationale`, no `evidence`, no note text. `opd_note_audits` carries no
 * name and no UHID, which is why this is the only one of the four whose whole-row read was already
 * safe — it is narrowed anyway, because a column added to that table later must not appear here by
 * default.
 */
export const OPD_CASE_SQL = `SELECT a.uid, a.engine_version,
       to_char(a.audited_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS audited_at,
       a.band, a.note_quality_index, a.completeness_pct, a.n_findings, a.n_low_value,
       a.score_documentation, a.score_appropriateness, a.score_prescribing_safety, a.score_patient_centred,
       (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'subject', fe->>'subject', 'verdict', fe->>'verdict',
          'domain', fe->>'domain', 'citation_ids', fe->'citation_ids')), '[]'::jsonb)
          FROM jsonb_array_elements(a.findings) fe) AS findings
  FROM opd_note_audits a
 WHERE a.uid = ANY($1::text[])
 ORDER BY a.audited_at DESC
 LIMIT 1`;

export const OPD_TIMELINE_SQL = `SELECT a.uid, a.engine_version,
       to_char(a.audited_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS audited_at,
       a.band, a.note_quality_index, a.completeness_pct, a.n_findings, a.n_low_value
  FROM opd_note_audits a
 WHERE a.uid = ANY($1::text[])
 ORDER BY a.audited_at DESC
 LIMIT 50`;

/**
 * db13, the one resolution `individual_uid` needs. INFERRED and NOT exercisable against Neon at
 * all: `dpipe_prescription_pipeline` lives in db13 behind `metabaseQuery`, which takes no bind
 * parameters — hence the literal, escaped the way `MEMBER_RESOLVE_SQL` (`sources/opd.ts:52-53`)
 * escapes its own, and the same table and columns that read resolves in the other direction.
 */
export const OPD_UIDS_BY_INDIVIDUAL_SQL = (individualUid: string) =>
  `SELECT uid FROM dpipe_prescription_pipeline WHERE individual_uid = '${individualUid.replace(/'/g, "''")}' LIMIT 200`;

/**
 * IPD discharge, newest audit for one member. `ORDER BY audited_at DESC` over every document that
 * member has, so "newest per document" is the first row of each document's group and the newest
 * overall is row one.
 *
 * ⚠️ `document_id` AND `ip_uid` ARE SELECTED AND NEITHER IS RETURNED. `ip_uid` is the join key
 * `episode_states` is indexed on (`migrations/0016_episode_states.sql:26`) and there is no other
 * path to a member's episode projections; `document_id` distinguishes two admissions on the same
 * day. Both stop at `tools/case.ts`, which builds its response field by field.
 * `report` — the whole audited body, with its idealised summary — is not selected.
 */
export const IPD_DISCHARGE_CASE_SQL = `SELECT document_id, ip_uid, engine_version,
       to_char(audited_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS audited_at,
       care_value_index, band, completeness_pct, n_findings, n_low_value, n_context_dependent,
       score_appropriateness, score_efficiency, score_safety, score_cost,
       score_documentation, score_patient_centred, los_days, discharge_type, speciality,
       (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'subject', fe->>'subject', 'verdict', fe->>'verdict',
          'domain', fe->>'domain', 'citation_ids', fe->'citation_ids')), '[]'::jsonb)
          FROM jsonb_array_elements(findings) fe) AS findings
  FROM ipd_discharge_audits
 WHERE member_id = $1
 ORDER BY audited_at DESC
 LIMIT 1`;

export const IPD_DISCHARGE_TIMELINE_SQL = `SELECT document_id, ip_uid, engine_version,
       to_char(audited_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS audited_at,
       care_value_index, band, completeness_pct, n_findings, n_low_value, los_days
  FROM ipd_discharge_audits
 WHERE member_id = $1
 ORDER BY audited_at DESC
 LIMIT 50`;

/**
 * `episode_states` for the admissions one member's audits point at.
 *
 * ⚠️ THE `state` JSONB IS NEVER SELECTED, AND THAT IS THE WHOLE DESIGN OF THIS STATEMENT. Every
 * `EpisodeFact` carries a `provenance.rawText` that is a VERBATIM substring of the discharge
 * summary (`lib/episode-state/schema.ts:33`) and `intra.courseSummary` is the documented narrative
 * itself (`:69`). Decision 146 says a free-text column is never selected, so the two numbers
 * decision 141 asks for — the fact count and the day span — are computed by Postgres inside the
 * row and only the integers cross the wire. Selecting `state` and counting in JavaScript would
 * have read every one of those substrings into this process to return two numbers.
 *
 * `jsonb_typeof` guards each length: a 0.1-era row whose phase is absent yields 0 rather than an
 * error that would fail the whole timeline.
 */
export const EPISODE_STATE_TIMELINE_SQL = `SELECT version,
       to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS updated_at,
       state->'intra'->'admission'->'lengthOfStayDays'->>'value' AS los_value,
       (CASE WHEN jsonb_typeof(state->'intra'->'procedures') = 'array' THEN jsonb_array_length(state->'intra'->'procedures') ELSE 0 END)
     + (CASE WHEN jsonb_typeof(state->'intra'->'medications') = 'array' THEN jsonb_array_length(state->'intra'->'medications') ELSE 0 END)
     + (CASE WHEN jsonb_typeof(state->'intra'->'investigations') = 'array' THEN jsonb_array_length(state->'intra'->'investigations') ELSE 0 END)
     + (CASE WHEN jsonb_typeof(state->'intra'->'treatments') = 'array' THEN jsonb_array_length(state->'intra'->'treatments') ELSE 0 END)
       AS fact_count
  FROM episode_states
 WHERE ip_uid = ANY($1::text[])
 ORDER BY updated_at DESC
 LIMIT 50`;

/** Every statement this file can run, for the decision 87 exercise and the round report. */
export const CASE_READER_STATEMENTS: Record<string, string> = {
  READMISSION_CASE_SQL,
  READMISSION_TIMELINE_SQL,
  PREOP_CASE_SQL,
  PREOP_TIMELINE_SQL,
  OPD_CASE_SQL,
  OPD_TIMELINE_SQL,
  IPD_DISCHARGE_CASE_SQL,
  IPD_DISCHARGE_TIMELINE_SQL,
  EPISODE_STATE_TIMELINE_SQL,
};

// ─────────────────────────────────────────────────────────────────────────────────────
// The readers
// ─────────────────────────────────────────────────────────────────────────────────────

export type Row = Record<string, unknown>;

/** Injection seam for unit tests (repo idiom). Production replaces neither. */
export interface CaseReaderDeps {
  /** Neon, through the guard and the deadline. */
  read?: <T>(source: string, statement: string, params: unknown[]) => Promise<T[]>;
  /** db13, which has no bind parameters and no guard of its own. */
  db13?: (statement: string) => Promise<Row[]>;
}

const liveRead = <T,>(source: string, statement: string, params: unknown[]): Promise<T[]> =>
  boundedRead<T>(source, statement, params);

const liveDb13 = (statement: string): Promise<Row[]> =>
  metabaseQuery(statement) as unknown as Promise<Row[]>;

/** Fail-safe (decision 87's companion): every fault is this source's `SOURCE_UNAVAILABLE`. */
async function readRows(deps: CaseReaderDeps, source: string, statement: string, params: unknown[]): Promise<Row[]> {
  const read = deps.read ?? liveRead;
  try {
    return await read<Row>(source, statement, params);
  } catch (e) {
    if (e instanceof LabError) throw e;
    throw new LabError('SOURCE_UNAVAILABLE', `${source} unavailable: ${String((e as Error).message).slice(0, 200)}`);
  }
}

/**
 * The note uids one `individual_uid` owns, from db13. An empty list is a FACT (this member has no
 * prescription rows in the window db13 keeps), not an error; a fault is `SOURCE_UNAVAILABLE`.
 */
export async function opdUidsForIndividual(individualUid: string, deps: CaseReaderDeps = {}): Promise<string[]> {
  const db13 = deps.db13 ?? liveDb13;
  let rows: Row[];
  try {
    rows = await db13(OPD_UIDS_BY_INDIVIDUAL_SQL(individualUid));
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE',
      `db13 could not resolve the note uids for that individual: ${String((e as Error).message).slice(0, 200)}`);
  }
  return [...new Set(rows.map((r) => (r.uid == null ? '' : String(r.uid))).filter(Boolean))];
}

export const readReadmissionCase = (uhid: string, d: CaseReaderDeps = {}) =>
  readRows(d, 'readmission_findings', READMISSION_CASE_SQL, [uhid]);
export const readReadmissionTimeline = (uhid: string, d: CaseReaderDeps = {}) =>
  readRows(d, 'readmission_findings', READMISSION_TIMELINE_SQL, [uhid]);
export const readPreopCase = (uhid: string, d: CaseReaderDeps = {}) =>
  readRows(d, 'preop_findings', PREOP_CASE_SQL, [uhid]);
export const readPreopTimeline = (uhid: string, d: CaseReaderDeps = {}) =>
  readRows(d, 'preop_findings', PREOP_TIMELINE_SQL, [uhid]);
export const readOpdCase = (uids: string[], d: CaseReaderDeps = {}) =>
  readRows(d, 'opd_note_audits', OPD_CASE_SQL, [uids]);
export const readOpdTimeline = (uids: string[], d: CaseReaderDeps = {}) =>
  readRows(d, 'opd_note_audits', OPD_TIMELINE_SQL, [uids]);
export const readIpdDischargeCase = (memberId: string, d: CaseReaderDeps = {}) =>
  readRows(d, 'ipd_discharge_audits', IPD_DISCHARGE_CASE_SQL, [memberId]);
export const readIpdDischargeTimeline = (memberId: string, d: CaseReaderDeps = {}) =>
  readRows(d, 'ipd_discharge_audits', IPD_DISCHARGE_TIMELINE_SQL, [memberId]);
export const readEpisodeStates = (ipUids: string[], d: CaseReaderDeps = {}) =>
  readRows(d, 'episode_states', EPISODE_STATE_TIMELINE_SQL, [ipUids]);
