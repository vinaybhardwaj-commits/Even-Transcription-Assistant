/**
 * lib/lab-v2/sources/audits.ts — the filter→SQL layer over `opd_note_audits`
 * (LAB-MCP-V2-PRD-v1.0 §8.2, §17.2).
 *
 * ⚠️ A CALLER NEVER SUPPLIES SQL. §8.2 is explicit: `audit_search` and `audit_aggregate` take a
 * FILTER SCHEMA, never SQL. Everything below is built from Zod-validated enums, integers and
 * date strings; the only free-text values that reach a statement are `engine_version`,
 * `doctor_uid` and `uid`, and each is passed through `lit()`, which REFUSES anything outside a
 * conservative identifier charset rather than trying to escape it. Refusing is the right shape
 * here: every legitimate value of those three fields is an id or a version string, so a value
 * that needs escaping is a value that should not be there.
 *
 * ⚠️ AND THE RESULT STILL GOES THROUGH THE V1 GUARD. `guardReadOnlySql` (lib/sql-guard-core.ts)
 * is the same function `audit_query` fronts: SELECT/WITH only, single statement, no write or DDL
 * or system-read token, no PHI-bearing relation, and a hard LIMIT ceiling. Building the string
 * ourselves is not a reason to skip it — it is a second, independent check that a filter bug
 * cannot turn into a write, and it is what §8.2 means by "through the existing v1 read-only
 * guard".
 *
 * EVERY STATEMENT IN THIS FILE IS INFERRED and is listed verbatim in the build report. The
 * column names were confirmed live against production Neon through the v1 `audit_query`
 * connector on 05 Sep 2026 (all 42 columns of `opd_note_audits`, and the 19 distinct keys of
 * its `findings` jsonb elements) before this file was written.
 *
 * NEVER NOTE TEXT, NEVER A PATIENT FIELD. The projection is a fixed column list. `findings` is
 * reduced to finding SUBJECTS and the metadata §17.2 names. `opd_note_audits` holds no patient
 * identifier and no note body, and this file selects `*` from nothing.
 */
import { z } from 'zod';
import { LabError } from '../contracts';
import { boundedRead } from './read';

const SOURCE = 'opd_note_audits';

/** The ceiling handed to the v1 guard. It appends `LIMIT` when a statement carries none. */
const GUARD_MAX = 500;

/**
 * A safe SQL literal, by REFUSAL rather than escaping. Ids and version strings in this schema
 * are `[A-Za-z0-9._:/-]`; anything else is rejected before a statement is built.
 */
function lit(value: string, field: string): string {
  if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(value)) {
    throw new LabError('INVALID_INPUT', `${field} contains characters that are not allowed in a filter value`);
  }
  return `'${value}'`;
}

/** An ISO date (YYYY-MM-DD), refused otherwise. Compared against note_date in UTC. */
function dateLit(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new LabError('INVALID_INPUT', `${field} must be an ISO date (YYYY-MM-DD)`);
  }
  return `'${value}'`;
}

/**
 * ⚠️ BOTH ENUMS ARE THE LIVE VALUES, read from production Neon on 05 Sep 2026, not guessed.
 * A first draft of this file had `band` as excellent/good/fair/poor and `verdict` as
 * appropriate/unclear/contraindicated. Both were wrong, and wrong in the silent direction: a
 * filter on a value the column never holds returns zero rows and looks like a true negative.
 * Measured: band A 14,621 · B 21,200 · C 5,889 · D 637 · E 133; verdict context-dependent
 * 38,163 · low-value 34,428 · uncertain 9,816 · high-value 5,563.
 */
export const BANDS = ['A', 'B', 'C', 'D', 'E'] as const;
export const VERDICTS = ['high-value', 'low-value', 'context-dependent', 'uncertain'] as const;
/** The twelve live categories, confirmed by the same read (counts from 8,655 down to 131). */
export const LVC_CATEGORIES = [
  'antibiotic', 'imaging', 'supplement_polypharmacy', 'therapeutic_duplication', 'systemic_steroid',
  'gi_ppi_prokinetic', 'antihistamine_allergy', 'nsaid_analgesic', 'cough_cold_fdc',
  'cough_expectorant', 'unindicated_investigation', 'other',
] as const;

export const GROUP_BY = ['engine_version', 'doctor_uid', 'band', 'lvc_category', 'note_month'] as const;
export const METRICS = ['count', 'avg_note_quality_index', 'avg_completeness_pct', 'sum_findings', 'sum_low_value'] as const;

/** §17.2's filter, exactly. Free text is confined to the three id-shaped fields. */
export const auditFilterSchema = z.object({
  engine_version: z.string().max(128).optional(),
  doctor_uid: z.string().max(128).optional(),
  band: z.enum(BANDS).optional(),
  note_date_from: z.string().optional(),
  note_date_to: z.string().optional(),
  lvc_category: z.enum(LVC_CATEGORIES).optional(),
  verdict: z.enum(VERDICTS).optional(),
  min_findings: z.number().int().min(0).max(1000).optional(),
});
export type AuditFilter = z.infer<typeof auditFilterSchema>;

/**
 * The WHERE clauses for one filter. `lvc_category` and `verdict` live INSIDE the `findings`
 * jsonb array, so each becomes an EXISTS over its elements rather than a column comparison —
 * an audit matches when ANY of its findings does.
 */
export function whereClauses(f: AuditFilter): string[] {
  const w: string[] = [];
  if (f.engine_version) w.push(`a.engine_version = ${lit(f.engine_version, 'engine_version')}`);
  if (f.doctor_uid) w.push(`a.doctor_uid = ${lit(f.doctor_uid, 'doctor_uid')}`);
  if (f.band) w.push(`a.band = ${lit(f.band, 'band')}`);
  if (f.note_date_from) w.push(`a.note_date >= ${dateLit(f.note_date_from, 'note_date_from')}`);
  if (f.note_date_to) w.push(`a.note_date < (${dateLit(f.note_date_to, 'note_date_to')}::date + 1)`);
  if (typeof f.min_findings === 'number') w.push(`a.n_findings >= ${Math.trunc(f.min_findings)}`);
  if (f.lvc_category) {
    w.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(a.findings) fx WHERE fx->>'lvc_category' = ${lit(f.lvc_category, 'lvc_category')})`);
  }
  if (f.verdict) {
    w.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(a.findings) fx WHERE fx->>'verdict' = ${lit(f.verdict, 'verdict')})`);
  }
  return w;
}

const WHERE = (w: string[]) => (w.length ? ` WHERE ${w.join(' AND ')}` : '');

/** The fixed projection. No note text, no patient field — §17.2's list and nothing more. */
const SEARCH_COLUMNS =
  `a.uid, a.engine_version, a.note_date, a.band, a.note_quality_index, a.completeness_pct, ` +
  `a.n_findings, a.n_low_value, ` +
  `(SELECT coalesce(jsonb_agg(fs->>'subject'), '[]'::jsonb) FROM jsonb_array_elements(a.findings) fs) AS finding_subjects`;

export interface AuditRow {
  uid: string; engine_version: string; note_date: string | null; band: string | null;
  note_quality_index: number | null; completeness_pct: number | null;
  n_findings: number | null; n_low_value: number | null; finding_subjects: string[] | null;
}

/**
 * Guard, then deadline (decision 31). ./read.ts owns both, so an added statement here cannot
 * accidentally run unguarded or unbounded — a 60 s route timeout is a 504 with no tool error in
 * it, which is what corpus_search produced before that decision.
 */
async function guarded<T>(statement: string): Promise<T[]> {
  return boundedRead<T>(SOURCE, statement, [], GUARD_MAX);
}

export function buildSearchSql(f: AuditFilter, limit: number, offset: number): string {
  return `SELECT ${SEARCH_COLUMNS} FROM opd_note_audits a${WHERE(whereClauses(f))}` +
    ` ORDER BY a.note_date DESC NULLS LAST, a.uid` +
    ` OFFSET ${Math.trunc(offset)} LIMIT ${Math.trunc(limit)}`;
}

export async function searchAudits(f: AuditFilter, limit: number, offset: number): Promise<AuditRow[]> {
  return guarded<AuditRow>(buildSearchSql(f, limit, offset));
}

const GROUP_EXPR: Record<(typeof GROUP_BY)[number], string> = {
  engine_version: 'a.engine_version',
  doctor_uid: 'a.doctor_uid',
  band: 'a.band',
  note_month: `to_char(a.note_date, 'YYYY-MM')`,
  lvc_category: `fg->>'lvc_category'`,
};

const METRIC_EXPR: Record<(typeof METRICS)[number], string> = {
  count: 'count(*)',
  avg_note_quality_index: 'avg(note_quality_index)',
  avg_completeness_pct: 'avg(completeness_pct)',
  sum_findings: 'sum(n_findings)',
  sum_low_value: 'sum(n_low_value)',
};

/**
 * ⚠️ GRAIN. Grouping by `lvc_category` needs the findings array unnested, which would otherwise
 * multiply an audit's row by its finding count and silently corrupt every average. The CTE
 * reduces to DISTINCT (audit, category) pairs FIRST, so a metric is always computed over AUDITS —
 * one audit contributes once per category it carries, and never twice to the same category.
 * Every other grouping needs no unnesting and reads the table directly.
 */
export function buildAggregateSql(f: AuditFilter, groupBy: (typeof GROUP_BY)[number], metric: (typeof METRICS)[number], maxGroups: number): string {
  const w = whereClauses(f);
  if (groupBy === 'lvc_category') {
    const inner = `SELECT DISTINCT a.id, a.note_quality_index, a.completeness_pct, a.n_findings, a.n_low_value, ${GROUP_EXPR.lvc_category} AS grp` +
      ` FROM opd_note_audits a, LATERAL jsonb_array_elements(a.findings) fg` +
      `${WHERE([...w, `fg->>'lvc_category' IS NOT NULL`])}`;
    return `WITH base AS (${inner}) SELECT grp AS group_key, ${METRIC_EXPR[metric]} AS value, count(*) AS n_audits` +
      ` FROM base GROUP BY grp ORDER BY value DESC NULLS LAST LIMIT ${Math.trunc(maxGroups)}`;
  }
  const expr = GROUP_EXPR[groupBy];
  const inner = `SELECT ${expr} AS grp, a.note_quality_index, a.completeness_pct, a.n_findings, a.n_low_value FROM opd_note_audits a${WHERE(w)}`;
  return `WITH base AS (${inner}) SELECT grp AS group_key, ${METRIC_EXPR[metric]} AS value, count(*) AS n_audits` +
    ` FROM base GROUP BY grp ORDER BY value DESC NULLS LAST LIMIT ${Math.trunc(maxGroups)}`;
}

export interface AggregateRow { group_key: string | null; value: string | number | null; n_audits: string | number }

export async function aggregateAudits(
  f: AuditFilter, groupBy: (typeof GROUP_BY)[number], metric: (typeof METRICS)[number], maxGroups: number,
): Promise<AggregateRow[]> {
  return guarded<AggregateRow>(buildAggregateSql(f, groupBy, metric, maxGroups));
}

export function buildOneAuditSql(uid: string): string {
  return `SELECT ${SEARCH_COLUMNS} FROM opd_note_audits a WHERE a.uid = ${lit(uid, 'uid')} ORDER BY a.audited_at DESC LIMIT 1`;
}

export async function oneAudit(uid: string): Promise<AuditRow | null> {
  const rows = await guarded<AuditRow>(buildOneAuditSql(uid));
  return rows[0] ?? null;
}

/** The findings array of one audit, with the metadata `audit_explain` resolves. No note text. */
export function buildFindingsSql(uid: string): string {
  return `SELECT a.uid, a.engine_version, a.sources, ` +
    `(SELECT coalesce(jsonb_agg(jsonb_build_object(` +
    `'subject', fe->>'subject', 'verdict', fe->>'verdict', 'domain', fe->>'domain', ` +
    `'source', fe->>'source', 'signal_type', fe->>'signal_type', 'rule_ref', fe->>'rule_ref', ` +
    `'lvc_category', fe->>'lvc_category', 'informational', fe->'informational', ` +
    `'citation_ids', fe->'citation_ids')), '[]'::jsonb) FROM jsonb_array_elements(a.findings) fe) AS findings ` +
    `FROM opd_note_audits a WHERE a.uid = ${lit(uid, 'uid')} ORDER BY a.audited_at DESC LIMIT 1`;
}

export interface AuditFindingsRow {
  uid: string; engine_version: string;
  sources: unknown;
  findings: Record<string, unknown>[] | null;
}

export async function auditFindings(uid: string): Promise<AuditFindingsRow | null> {
  const rows = await guarded<AuditFindingsRow>(buildFindingsSql(uid));
  return rows[0] ?? null;
}
