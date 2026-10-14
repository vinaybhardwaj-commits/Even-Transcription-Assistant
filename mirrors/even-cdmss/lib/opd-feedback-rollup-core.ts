/**
 * Pure core for the OPD Feedback Loop MCP tools (PRD OPD-FEEDBACK-LOOP-MCP-PRD-v1.1 §3–§6).
 * NO imports from lib/db, next/*, or any transport layer — this module only builds parameterized
 * SQL text ($1…$n; user args are NEVER string-interpolated) and reduces raw result rows into the
 * tool response shapes. The impure runner (lib/mcp-tools.ts) executes the SQL and calls the reducers.
 *
 * Semantics (normative, PRD §3):
 *  - Current-state dedup: effective verdict of (audit_id, finding_ref) = latest created_at, tie-break
 *    highest id. Earlier rows are history (excluded from rollups; surfaced by feedback_detail history=true).
 *  - precision_strict = tp / (tp + nitpick + false); contested EXCLUDED (demand-side dispute).
 *  - contested_rate = contested / triaged. Zero denominator → null (never NaN).
 *  - coverage_pct = triaged / fired per engine_version × signal_type.
 *  - open-adjudication: (false + nitpick) ≥ OPEN_ADJ_THRESHOLD with no current non-defer ledger decision.
 */

// LAB-MCP Phase 1: cluster_key normalisation is shared with the identity core (one definition).
import { normalizeClusterKey } from './opd-finding-identity-core';
export { normalizeClusterKey };
// F17/A10.3: import the impact tags rather than re-declare them, so the write and read sides of the
// 'impact' scope can never drift. This is the ONE deliberate link between the two feedback cores.
import { IMPACT_TAGS } from './opd-feedback-core';

// ── controlled vocab ──────────────────────────────────────────────────────────
export const FINDING_VERDICTS = ['true_positive', 'nitpick', 'false', 'contested'] as const;
export const AUDIT_VERDICTS = ['agree', 'disagree', 'needs_action'] as const;
export const MISSED_VERDICTS = ['missed'] as const;
export const SCOPES = ['finding', 'missed', 'audit'] as const;
/**
 * F17 / A10.3 — the DELIBERATE reconciliation of the D22 vocabulary collision.
 *
 * opd-feedback-core.SCOPES has FOUR entries (audit, finding, missed, impact) because the WRITE path
 * has always accepted 'impact'. This module's SCOPES has three because the ROLLUP has always grouped
 * three. Those are two different facts and unifying them blind would silently change what
 * reduceRollup buckets. So the read-side whitelist gets its own name: feedback_detail admits
 * 'impact' (that is F17 — the scope was write-only), while SCOPES above is untouched.
 * IMPACT_TAGS is IMPORTED rather than re-declared so the two modules can never disagree on the tags.
 */
export const DETAIL_SCOPES = ['finding', 'missed', 'audit', 'impact'] as const;
export type DetailScope = (typeof DETAIL_SCOPES)[number];
export const DECISIONS = ['fix', 'suppress', 'accept', 'defer', 'monitor'] as const;

export type FeedbackScope = (typeof SCOPES)[number];
export type Decision = (typeof DECISIONS)[number];

export const OPEN_ADJ_THRESHOLD = 3;           // ≥3 false+nitpick with no non-defer decision → open
export const ESCALATION_MARKER = '[escalation package generated]';
export const UNCLASSIFIED = '(unclassified)';   // label for null signal_type
export const UNJOINED = 'unjoined';             // label for feedback whose audit_id no longer joins
export const DETAIL_LIMIT_DEFAULT = 50;
export const DETAIL_LIMIT_MAX = 200;

// dedup ordering, documented once (used by every current-state CTE)
export const CURRENT_STATE_ORDER = 'ORDER BY f.audit_id, f.finding_ref, f.created_at DESC, f.id DESC';

/** Latest created_at (tie-break highest id) at the SQL level is expressed as DISTINCT ON + this order. */

// ── small numeric helpers ─────────────────────────────────────────────────────
const round1 = (x: number) => Math.round(x * 10) / 10;
const round4 = (x: number) => Math.round(x * 10000) / 10000;
/** Ratio with a zero-denominator → null guard (never NaN). PRD §3. */
export function ratio(num: number, den: number): number | null {
  return den > 0 ? round4(num / den) : null;
}
/** Percentage (one decimal) with the same zero-denominator → null guard. */
export function pct(num: number, den: number): number | null {
  return den > 0 ? round1((num / den) * 100) : null;
}
export function clampLimit(v: unknown, def = DETAIL_LIMIT_DEFAULT, min = 1, max = DETAIL_LIMIT_MAX): number {
  const nRaw = Number(v);
  if (!Number.isFinite(nRaw)) return def;
  return Math.max(min, Math.min(max, Math.floor(nRaw)));
}
/** Convention: cluster_key for a signal_type × engine_version bucket. */
export function clusterKey(signalType: string, engineVersion: string): string {
  return `${signalType}@${engineVersion}`;
}
/** The F4 escalation marker test — the ONLY definition of "is this comment an escalation event". */
export function isEscalationComment(comment: unknown): boolean {
  return typeof comment === 'string' && comment.startsWith(ESCALATION_MARKER);
}
const nz = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
/**
 * F6 (A10.1) — category → signal_type map for recall_proxy. DELIBERATELY PARTIAL.
 *
 * A missed-finding `category` is domain-aligned; a bucket is keyed by `signal_type`. Only three
 * categories map to signal types unambiguously. The rest (note_quality, continuity, documentation,
 * other) have NO defensible mapping — their recall_proxy is reported as null with the reason, rather
 * than invented. recall_proxy is a LOWER BOUND on sensitivity in every case: the denominator counts
 * only misses a reviewer actually flagged, and nobody flags what they did not notice.
 */
export const CATEGORY_SIGNAL_MAP: Record<string, readonly string[]> = {
  appropriateness_low_value: ['low_value_care', 'appropriateness_low_value', 'appropriateness_review', 'appropriateness_general'],
  prescribing_safety: [
    'prescribing_low_value', 'prescribing_review', 'prescribing_general', 'drug_interaction',
    'high_alert_medication', 'dose_ceiling_exceeded', 'dose_ceiling_sos', 'schedule_x', 'lasa_pair',
    'duplicate_molecule', 'duplicate_prescription', 'banned_fdc', 'incomplete_dosing',
    'unverified_brand', 'off_formulary', 'antibiotic_stewardship',
  ],
  coding: ['coding_completeness'],
};
export const CATEGORY_UNMAPPED_REASON = 'no defensible category→signal_type mapping; recall_proxy would be invented, so it is null';

const labelSig = (v: unknown): string => { const s = v == null ? '' : String(v).trim(); return s || UNCLASSIFIED; };

// ── DDL + write SQL for the adjudication ledger (ensured at call time) ─────────
export const ADJUDICATION_DDL = `CREATE TABLE IF NOT EXISTS opd_feedback_adjudications (
  id bigserial PRIMARY KEY,
  cluster_key text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('fix','suppress','accept','defer','monitor')),
  rationale text NOT NULL,
  prd_ref text,
  author text,
  created_at timestamptz NOT NULL DEFAULT now()
)`;

/**
 * LAB-MCP Phase 1 (normative detail 5): cluster_key becomes the BARE signal_type and the engine
 * version moves to its own NULLABLE column. Additive + idempotent, ensured at call time beside the
 * DDL above. Existing "<signal>@<version>" rows are NOT rewritten — the ledger is append-only and is
 * normalised on read (normalizeClusterKey); this column simply gives new rows somewhere honest to
 * record the version instead of smuggling it into the identity.
 */
export const ADJUDICATION_ENGINE_VERSION_DDL =
  `ALTER TABLE opd_feedback_adjudications ADD COLUMN IF NOT EXISTS engine_version text`;

export type Sql = { text: string; params: unknown[] };

/** Param collector: push a value, get back its $n placeholder. Keeps ordering correct + safe. */
function pb() {
  const params: unknown[] = [];
  const P = (v: unknown) => { params.push(v); return `$${params.length}`; };
  return { params, P };
}

// ── rollup SQL builders (PRD §4.1) ────────────────────────────────────────────
export type RollupFilters = { appSource: string; engineVersion?: string | null; since?: string | null; until?: string | null; signalType?: string | null;
  /** Study-filter build (§8): the labelling study to read. The predicate is ALWAYS present —
   *  `f.study IS NOT DISTINCT FROM $n`, parameterised, default NULL — so NULL matches NULL and a
   *  production read (study unset) can never see a study's rows, nor a study read production's. */
  study?: string | null };

function rangeAnd(P: (v: unknown) => string, since?: string | null, until?: string | null): string {
  let s = '';
  if (since) s += ` AND f.created_at >= ${P(since)}::date`;
  if (until) s += ` AND f.created_at < (${P(until)}::date + INTERVAL '1 day')`;
  return s;
}

/** Current-state finding verdict counts, grouped by engine_version × signal_type × verdict. */
export function buildRollupFindingSql(o: RollupFilters): Sql {
  const { params, P } = pb();
  let cfWhere = `f.scope = 'finding' AND f.finding_ref IS NOT NULL AND f.app_source = ${P(o.appSource)}`;
  cfWhere += ` AND f.study IS NOT DISTINCT FROM ${P(o.study ?? null)}`;
  cfWhere += rangeAnd(P, o.since, o.until);
  if (o.signalType) cfWhere += ` AND f.signal_type = ${P(o.signalType)}`;
  let outer = '';
  if (o.engineVersion) outer = ` WHERE a.engine_version = ${P(o.engineVersion)}`;
  const text = `WITH cf AS (
  SELECT DISTINCT ON (f.audit_id, f.finding_ref) f.audit_id, f.finding_ref, f.signal_type, f.verdict
  FROM opd_audit_feedback f
  WHERE ${cfWhere}
  ${CURRENT_STATE_ORDER}
)
SELECT COALESCE(a.engine_version, '${UNJOINED}') AS engine_version, cf.signal_type AS signal_type, cf.verdict AS verdict, count(*)::int AS n
FROM cf LEFT JOIN opd_note_audits a ON a.id = cf.audit_id${outer}
GROUP BY 1, 2, 3`;
  return { text, params };
}

/** Fired denominator: findings elements in opd_note_audits, grouped by engine_version × signal_type. */
export function buildRollupFiredSql(o: RollupFilters): Sql {
  const { params, P } = pb();
  let where = `a.app_source = ${P(o.appSource)}`;
  if (o.engineVersion) where += ` AND a.engine_version = ${P(o.engineVersion)}`;
  if (o.signalType) where += ` AND elem->>'signal_type' = ${P(o.signalType)}`;
  const text = `SELECT a.engine_version AS engine_version, elem->>'signal_type' AS signal_type, count(*)::int AS fired
FROM opd_note_audits a, jsonb_array_elements(COALESCE(a.findings, '[]'::jsonb)) elem
WHERE ${where}
GROUP BY 1, 2`;
  return { text, params };
}

/**
 * Missed flags (scope='missed'), grouped by engine_version x CATEGORY.
 *
 * F6 (addendum A10.1): this grouped by `signal_type`, which NOTHING populates on a missed row — the
 * write path has never required it and the UI never sent it, so every missed bucket collapsed into a
 * single null key and recall was ungroupable. `category` is the field the write path actually
 * validates (MISSED_CATEGORIES), so grouping by it makes the EXISTING rows partially readable with
 * no write-path migration. Rows predating the F6 required-category change carry NULL and are
 * labelled '(unclassified)' — never backfilled with a guess.
 */
export function buildRollupMissedSql(o: RollupFilters): Sql {
  const { params, P } = pb();
  let where = `f.scope = 'missed' AND f.app_source = ${P(o.appSource)}`;
  where += ` AND f.study IS NOT DISTINCT FROM ${P(o.study ?? null)}`;
  where += rangeAnd(P, o.since, o.until);
  const text = `WITH m AS (
  SELECT f.audit_id, f.category FROM opd_audit_feedback f WHERE ${where}
)
SELECT COALESCE(a.engine_version, '${UNJOINED}') AS engine_version, m.category AS category, count(*)::int AS n
FROM m LEFT JOIN opd_note_audits a ON a.id = m.audit_id
GROUP BY 1, 2`;
  return { text, params };
}

/**
 * F17 (addendum A10.2 / D23) — the `impact` scope, which is WRITE-ONLY today: parseFeedbackBody
 * validates and stores it, and no read tool has ever exposed it. Current impact = the LATEST
 * scope='impact' row per (audit_id, finding_ref), mirroring the finding current-state rule exactly.
 */
export function buildRollupImpactSql(o: RollupFilters): Sql {
  const { params, P } = pb();
  let cfWhere = `f.scope = 'impact' AND f.finding_ref IS NOT NULL AND f.app_source = ${P(o.appSource)}`;
  cfWhere += ` AND f.study IS NOT DISTINCT FROM ${P(o.study ?? null)}`;
  cfWhere += rangeAnd(P, o.since, o.until);
  const text = `WITH ci AS (
  SELECT DISTINCT ON (f.audit_id, f.finding_ref) f.audit_id, f.finding_ref, f.verdict
  FROM opd_audit_feedback f
  WHERE ${cfWhere}
  ${CURRENT_STATE_ORDER}
)
SELECT ci.verdict AS verdict, count(*)::int AS n, count(DISTINCT ci.finding_ref)::int AS n_refs
FROM ci
GROUP BY 1`;
  return { text, params };
}

/** Audit-scope rows (verdict + comment) for the reducer to tally (comments never leave in output). */
export function buildRollupAuditSql(o: RollupFilters): Sql {
  const { params, P } = pb();
  let where = `f.scope = 'audit' AND f.app_source = ${P(o.appSource)}`;
  where += ` AND f.study IS NOT DISTINCT FROM ${P(o.study ?? null)}`;
  where += rangeAnd(P, o.since, o.until);
  const text = `SELECT f.verdict AS verdict, f.comment AS comment FROM opd_audit_feedback f WHERE ${where}`;
  return { text, params };
}

/**
 * Reviewer tally — ALL rows with an author in the range. UNCHANGED, and deliberately so: this is the
 * existing `reviewers` number, renamed in the output to `reviewers_all_rows` (F4).
 *
 * WHAT IT COUNTS, exactly (this is the `basis` string the tool now emits): every opd_audit_feedback
 * row with a non-blank author in the window, across ALL scopes (finding + missed + audit) and
 * INCLUDING superseded revisions. It is a reviewer-activity measure, not a triage-coverage measure.
 */
export function buildRollupReviewerSql(o: RollupFilters): Sql {
  const { params, P } = pb();
  let where = `f.app_source = ${P(o.appSource)} AND f.author IS NOT NULL AND btrim(f.author) <> ''`;
  where += ` AND f.study IS NOT DISTINCT FROM ${P(o.study ?? null)}`;
  where += rangeAnd(P, o.since, o.until);
  const text = `SELECT f.author AS author, count(*)::int AS n FROM opd_audit_feedback f WHERE ${where} GROUP BY f.author ORDER BY n DESC`;
  return { text, params };
}

/**
 * F4 — reviewer tally over the CURRENT-STATE TRIAGED SET ONLY, so it reconciles with totals.triaged.
 *
 * ROOT CAUSE of the mismatch this fixes: buildRollupReviewerSql counts every authored row in the
 * window, while totals.triaged counts only the current-state finding verdicts — DISTINCT ON
 * (audit_id, finding_ref), scope='finding', finding_ref NOT NULL. The two therefore differ by
 * (a) scope='missed' and scope='audit' rows, which have an author but are not finding triage, and
 * (b) every superseded revision of a finding verdict, which the current-state dedup collapses but the
 * reviewer tally counts once per revision. Neither is a bug in the data; they are two different
 * questions that shared one label.
 *
 * This query mirrors the finding-rollup CTE EXACTLY (same predicate, same CURRENT_STATE_ORDER) and
 * takes the author off the surviving row, so sum(n) === totals.triaged by construction.
 */
export function buildRollupReviewerCurrentSql(o: RollupFilters): Sql {
  const { params, P } = pb();
  let cfWhere = `f.scope = 'finding' AND f.finding_ref IS NOT NULL AND f.app_source = ${P(o.appSource)}`;
  cfWhere += ` AND f.study IS NOT DISTINCT FROM ${P(o.study ?? null)}`;
  cfWhere += rangeAnd(P, o.since, o.until);
  if (o.signalType) cfWhere += ` AND f.signal_type = ${P(o.signalType)}`;
  let outer = '';
  if (o.engineVersion) outer = ` WHERE a.engine_version = ${P(o.engineVersion)}`;
  const text = `WITH cf AS (
  SELECT DISTINCT ON (f.audit_id, f.finding_ref) f.audit_id, f.finding_ref, f.author
  FROM opd_audit_feedback f
  WHERE ${cfWhere}
  ${CURRENT_STATE_ORDER}
)
SELECT COALESCE(NULLIF(btrim(cf.author), ''), '(unattributed)') AS author, count(*)::int AS n
FROM cf LEFT JOIN opd_note_audits a ON a.id = cf.audit_id${outer}
GROUP BY 1
ORDER BY n DESC`;
  return { text, params };
}

/**
 * Study-filter build (§8) — per-AUTHOR current state over scope='finding' rows: the latest verdict
 * each author holds on each finding. This is the inter-rater read a study needs (compare two
 * authors' current calls on the same finding), which no existing builder can produce — the
 * (audit_id, finding_ref) dedup collapses authors into one winner.
 *
 * The DISTINCT ON key is (f.audit_id, f.finding_ref, f.author) and the ORDER BY leads with the
 * SAME three columns before the shared currentness tail — derived from CURRENT_STATE_ORDER (the
 * single definition of current state) rather than restated, so the tie-break can never drift.
 */
export const AUTHOR_CURRENT_STATE_ORDER = CURRENT_STATE_ORDER.replace('f.finding_ref,', 'f.finding_ref, f.author,');

export function buildFindingAuthorCurrentSql(o: RollupFilters): Sql {
  const { params, P } = pb();
  let cfWhere = `f.scope = 'finding' AND f.finding_ref IS NOT NULL AND f.app_source = ${P(o.appSource)}`;
  cfWhere += ` AND f.study IS NOT DISTINCT FROM ${P(o.study ?? null)}`;
  cfWhere += rangeAnd(P, o.since, o.until);
  if (o.signalType) cfWhere += ` AND f.signal_type = ${P(o.signalType)}`;
  const text = `SELECT DISTINCT ON (f.audit_id, f.finding_ref, f.author)
  f.audit_id, f.finding_ref, f.author, f.verdict, f.signal_type, f.created_at
FROM opd_audit_feedback f
WHERE ${cfWhere}
${AUTHOR_CURRENT_STATE_ORDER}`;
  return { text, params };
}

/** Latest ledger decision per cluster_key (for the open-adjudication gate). */
export function buildLatestLedgerSql(): Sql {
  return {
    text: `SELECT DISTINCT ON (cluster_key) cluster_key, decision FROM opd_feedback_adjudications ORDER BY cluster_key, created_at DESC, id DESC`,
    params: [],
  };
}

// ── rollup reducer (PRD §3 semantics live here → unit-tested) ──────────────────
export type FindingCountRow = { engine_version: string; signal_type: string | null; verdict: string; n: number | string };
export type FiredRow = { engine_version: string; signal_type: string | null; fired: number | string };
export type MissedRow = { engine_version: string; category: string | null; n: number | string };
export type ImpactRow = { verdict: string | null; n: number | string; n_refs: number | string };
export type AuditRow = { verdict: string | null; comment: string | null };
export type ReviewerRow = { author: string; n: number | string };
export type LedgerLatestRow = { cluster_key: string; decision: string };

export type RollupBucket = {
  engine_version: string; signal_type: string;
  fired: number; triaged: number; coverage_pct: number | null;
  tp: number; nitpick: number; false: number; contested: number;
  precision_strict: number | null; contested_rate: number | null;
};

/** F2 — the serialised-payload ceiling for the rollup response, in characters. */
export const ROLLUP_CHAR_BUDGET = 20000;
/** F2 — summary mode keeps the top N buckets by `fired` … */
export const SUMMARY_TOP_FIRED = 20;
/** … plus EVERY bucket with at least this many triaged, so a reviewed bucket is never dropped. */
export const SUMMARY_MIN_TRIAGED = 5;

export type RollupMode = 'summary' | 'full';

export function reduceRollup(inputs: {
  findingRows: FindingCountRow[]; firedRows: FiredRow[]; missedRows: MissedRow[];
  auditRows: AuditRow[]; reviewerRows: ReviewerRow[]; ledgerRows: LedgerLatestRow[];
  reviewerCurrentRows?: ReviewerRow[];
  impactRows?: ImpactRow[];
}, opts: { threshold?: number; minTriaged?: number; mode?: RollupMode; charBudget?: number } = {}): {
  buckets: RollupBucket[];
  missed: { category: string; n: number; engine_version: string }[];
  recall_proxy: { category: string; tp: number; missed: number; recall_proxy: number | null; basis: string }[];
  impact: { changes_management: number; chart_hygiene: number; coverage_of_tp: number | null; n_refs_tagged: number };
  audit_scope: { n_comments: number; verdict_counts: Record<string, number>; n_escalations: number };
  reviewers_all_rows: { author: string; n: number }[];
  reviewers_basis: string;
  reviewers_current: { author: string; n: number }[];
  open_adjudications: string[];
  totals: Record<string, number | null>;
  mode: RollupMode;
  truncated: boolean;
  n_buckets_omitted: number;
} {
  const threshold = opts.threshold ?? OPEN_ADJ_THRESHOLD;
  const key = (ev: string, st: string) => `${ev} ${st}`;
  const buckets = new Map<string, RollupBucket>();
  const blank = (ev: string, st: string): RollupBucket => ({
    engine_version: ev, signal_type: st, fired: 0, triaged: 0, coverage_pct: null,
    tp: 0, nitpick: 0, false: 0, contested: 0, precision_strict: null, contested_rate: null,
  });
  const get = (ev: string, st: string) => {
    const k = key(ev, st); let b = buckets.get(k); if (!b) { b = blank(ev, st); buckets.set(k, b); } return b;
  };

  // triaged verdict counts (current-state)
  for (const r of inputs.findingRows) {
    const b = get(String(r.engine_version), labelSig(r.signal_type));
    const c = nz(r.n);
    if (r.verdict === 'true_positive') b.tp += c;
    else if (r.verdict === 'nitpick') b.nitpick += c;
    else if (r.verdict === 'false') b.false += c;
    else if (r.verdict === 'contested') b.contested += c;
  }
  // fired denominator
  for (const r of inputs.firedRows) get(String(r.engine_version), labelSig(r.signal_type)).fired += nz(r.fired);

  // finalize per-bucket derived metrics
  const open = new Set<string>();
  for (const b of buckets.values()) {
    b.triaged = b.tp + b.nitpick + b.false + b.contested;
    b.precision_strict = ratio(b.tp, b.tp + b.nitpick + b.false);
    b.contested_rate = ratio(b.contested, b.triaged);
    b.coverage_pct = pct(b.triaged, b.fired);
    // Normative detail 5: cluster_key is now the BARE signal_type — engine version is metadata, not
    // identity. Several engine versions of one signal therefore collapse to one adjudicable cluster.
    if (b.false + b.nitpick >= threshold) open.add(b.signal_type);
  }

  // Open-adjudication gate: keep only cluster_keys with no current non-defer decision.
  // Ledger keys are NORMALISED ON READ (the ledger is append-only, so historical
  // "<signal>@<engine_version>" rows are never rewritten). Rows arrive newest-first per key; after
  // normalisation several historical keys can fold onto one, so the FIRST decision seen for a
  // normalised key wins and later (older) ones must not overwrite it.
  const latest = new Map<string, string>();
  for (const r of inputs.ledgerRows) {
    const nk = normalizeClusterKey(r.cluster_key);
    if (!latest.has(nk)) latest.set(nk, r.decision);
  }
  const open_adjudications = [...open].filter((ck) => {
    const d = latest.get(normalizeClusterKey(ck));
    return d === undefined || d === 'defer';
  }).sort();

  // audit scope tally (marker + verdicts)
  const verdict_counts: Record<string, number> = { agree: 0, disagree: 0, needs_action: 0, none: 0 };
  let n_escalations = 0;
  for (const r of inputs.auditRows) {
    const v = r.verdict && verdict_counts[r.verdict] !== undefined ? r.verdict : 'none';
    verdict_counts[v] += 1;
    if (isEscalationComment(r.comment)) n_escalations += 1;
  }

  // F6: missed is grouped by CATEGORY now (A10.1). Pre-F6 rows carry NULL → '(unclassified)'.
  const missed = inputs.missedRows.map((r) => ({ category: labelSig(r.category), n: nz(r.n), engine_version: String(r.engine_version) }));
  const reviewers = inputs.reviewerRows.map((r) => ({ author: String(r.author), n: nz(r.n) }));

  const bucketList = [...buckets.values()].sort((a, b) => (b.triaged - a.triaged) || (b.fired - a.fired));

  // ── TOTALS ARE COMPUTED OVER **ALL** BUCKETS, ALWAYS ────────────────────────────
  // F2's hard invariant: min_triaged and mode are OUTPUT filters, never semantic ones. Every total
  // below is summed from the complete bucketList BEFORE any filtering or truncation, so
  // totals.tp/nitpick/false/contested are byte-identical to what this reducer returned pre-F2
  // regardless of which buckets are emitted. Filtering after this point cannot move a total.
  const sum = (f: (b: RollupBucket) => number) => bucketList.reduce((s, b) => s + f(b), 0);
  const totTp = sum((b) => b.tp), totNit = sum((b) => b.nitpick), totFalse = sum((b) => b.false), totCon = sum((b) => b.contested);
  const totTriaged = sum((b) => b.triaged), totFired = sum((b) => b.fired);

  // ── F2 output budget: min_triaged → mode → char ceiling ─────────────────────────
  const minTriaged = Number.isFinite(Number(opts.minTriaged)) ? Math.max(0, Math.floor(Number(opts.minTriaged))) : 1;
  const mode: RollupMode = opts.mode === 'full' ? 'full' : 'summary';
  const charBudget = Number.isFinite(Number(opts.charBudget)) ? Math.max(1000, Math.floor(Number(opts.charBudget))) : ROLLUP_CHAR_BUDGET;

  // min_triaged (default 1) drops zero-triaged buckets from `buckets`; they are NOT lost — they are
  // reported in totals as n_buckets_untriaged / fired_untriaged so the fired denominator stays honest.
  const kept = bucketList.filter((b) => b.triaged >= minTriaged);
  const dropped = bucketList.filter((b) => b.triaged < minTriaged);

  let emitted = kept;
  if (mode === 'summary' && kept.length > 0) {
    // top N by FIRED (the volume story) ∪ every bucket with triaged ≥ 5 (the reviewed story).
    const byFired = [...kept].sort((a, b) => (b.fired - a.fired) || (b.triaged - a.triaged)).slice(0, SUMMARY_TOP_FIRED);
    const chosen = new Set<RollupBucket>(byFired);
    for (const b of kept) if (b.triaged >= SUMMARY_MIN_TRIAGED) chosen.add(b);
    emitted = kept.filter((b) => chosen.has(b));   // preserve the canonical triaged-desc ordering
  }

  // Hard character ceiling. Trim from the TAIL (lowest triaged first, since `emitted` is triaged-desc)
  // until the serialised buckets fit. This is a payload guard, not a semantic one — see totals above.
  let truncated = false;
  while (emitted.length > 0 && JSON.stringify(emitted).length > charBudget) {
    emitted = emitted.slice(0, emitted.length - 1);
    truncated = true;
  }
  const n_buckets_omitted = kept.length - emitted.length;

  // ── F6 recall_proxy (A10.1) — per CATEGORY, a LOWER BOUND on sensitivity ────────
  const tpBySignal = new Map<string, number>();
  for (const b of bucketList) tpBySignal.set(b.signal_type, (tpBySignal.get(b.signal_type) ?? 0) + b.tp);
  const missedByCat = new Map<string, number>();
  for (const m of missed) missedByCat.set(m.category, (missedByCat.get(m.category) ?? 0) + m.n);
  const recall_proxy = [...missedByCat.keys()].sort().map((category) => {
    const sigs = CATEGORY_SIGNAL_MAP[category];
    const missedN = missedByCat.get(category) ?? 0;
    if (!sigs) {
      return { category, tp: 0, missed: missedN, recall_proxy: null, basis: CATEGORY_UNMAPPED_REASON };
    }
    const tp = sigs.reduce((acc, sig) => acc + (tpBySignal.get(sig) ?? 0), 0);
    return {
      category, tp, missed: missedN,
      recall_proxy: ratio(tp, tp + missedN),
      basis: 'LOWER BOUND — tp / (tp + reviewer-flagged misses in this category). The denominator counts only misses someone noticed, so true sensitivity is at most this.',
    };
  });

  // ── F17 impact fold (A10.2 / D23) — previously write-only ───────────────────────
  const impactRows = inputs.impactRows ?? [];
  const impactBy = (v: string) => impactRows.filter((r) => r.verdict === v).reduce((acc, r) => acc + nz(r.n), 0);
  const changes_management = impactBy('changes_management');
  const chart_hygiene = impactBy('chart_hygiene');
  const n_refs_tagged = impactRows.reduce((acc, r) => acc + nz(r.n_refs), 0);
  const impact = {
    changes_management, chart_hygiene,
    // What share of true positives a reviewer bothered to tag with an impact at all.
    coverage_of_tp: ratio(n_refs_tagged, totTp),
    n_refs_tagged,
  };

  const totals: Record<string, number | null> = {
    buckets: bucketList.length, fired: totFired, triaged: totTriaged,
    tp: totTp, nitpick: totNit, false: totFalse, contested: totCon,
    precision_strict: ratio(totTp, totTp + totNit + totFalse),
    contested_rate: ratio(totCon, totTriaged),
    coverage_pct: pct(totTriaged, totFired),
    missed: missed.reduce((s, m) => s + m.n, 0),
    n_escalations, open_adjudications: open_adjudications.length,
    // What min_triaged removed from `buckets`, so the omission is visible rather than silent.
    n_buckets_untriaged: dropped.length,
    fired_untriaged: dropped.reduce((s, b) => s + b.fired, 0),
    n_buckets_emitted: emitted.length,
  };

  // F4: the existing tally keeps its number but is RENAMED, with its basis stated in the payload;
  // reviewers_current is the current-state triaged set and sums to totals.triaged.
  const reviewers_current = (inputs.reviewerCurrentRows ?? []).map((r) => ({ author: String(r.author), n: nz(r.n) }));

  return {
    buckets: emitted,
    missed,
    recall_proxy,
    impact,
    audit_scope: { n_comments: inputs.auditRows.length, verdict_counts, n_escalations },
    reviewers_all_rows: reviewers,
    reviewers_basis: 'every opd_audit_feedback row with a non-blank author in the window, across ALL scopes (finding + missed + audit) and INCLUDING superseded revisions — reviewer activity, NOT triage coverage. Use reviewers_current to reconcile with totals.triaged.',
    reviewers_current,
    open_adjudications,
    totals,
    mode,
    truncated,
    n_buckets_omitted,
  };
}

// ── feedback_detail SQL (PRD §4.2) ─────────────────────────────────────────────
export type DetailFilters = {
  appSource: string; scope: DetailScope; verdict?: string | null; signalType?: string | null;
  engineVersion?: string | null; uid?: string | null; history?: boolean; limit: number;
  /** Study-filter build (§8): same always-present `IS NOT DISTINCT FROM` predicate as RollupFilters. */
  study?: string | null;
};

function verdictWhitelistFor(scope: DetailScope): readonly string[] {
  if (scope === 'finding') return FINDING_VERDICTS;
  if (scope === 'missed') return MISSED_VERDICTS;
  if (scope === 'impact') return IMPACT_TAGS;   // F17
  return AUDIT_VERDICTS;
}

/** Build the detail query. Throws on a non-whitelisted scope/verdict filter (PRD §8 test 6). */
export function buildDetailSql(o: DetailFilters): Sql {
  if (!(DETAIL_SCOPES as readonly string[]).includes(o.scope)) throw new Error(`unknown scope filter: ${o.scope}`);
  if (o.verdict && !verdictWhitelistFor(o.scope).includes(o.verdict)) {
    throw new Error(`unknown verdict filter for scope=${o.scope}: ${o.verdict}`);
  }
  const limit = clampLimit(o.limit);
  const { params, P } = pb();
  const app = P(o.appSource);
  const study = P(o.study ?? null);   // §8: one placeholder, reused by every feedback predicate below
  const commonFilters = (fAlias: string, aAlias: string) => {
    let s = '';
    if (o.verdict) s += ` AND ${fAlias}.verdict = ${P(o.verdict)}`;
    if (o.signalType) s += ` AND ${fAlias}.signal_type = ${P(o.signalType)}`;
    if (o.uid) s += ` AND ${fAlias}.uid = ${P(o.uid)}`;
    if (o.engineVersion) s += ` AND ${aAlias}.engine_version = ${P(o.engineVersion)}`;
    return s;
  };
  const cols = `f.id AS feedback_id, f.created_at, f.scope, f.verdict, f.comment, f.author, f.uid,
    f.audit_id, f.finding_ref, f.signal_type, a.engine_version, a.note_date, a.doctor_uid`;
  const lat = `LEFT JOIN LATERAL (
    SELECT elem FROM jsonb_array_elements(COALESCE(a.findings, '[]'::jsonb)) elem
    WHERE elem->>'finding_ref' = f.finding_ref LIMIT 1
  ) fj ON true`;

  let text: string;
  if (o.scope === 'finding') {
    const cfApp = app; // reuse $1 (same appSource) inside the cur CTE
    const curCte = `cur AS (
    SELECT DISTINCT ON (f.audit_id, f.finding_ref) f.id AS cur_id
    FROM opd_audit_feedback f
    WHERE f.scope = 'finding' AND f.finding_ref IS NOT NULL AND f.app_source = ${cfApp} AND f.study IS NOT DISTINCT FROM ${study}
    ${CURRENT_STATE_ORDER}
  )`;
    const join = o.history ? 'LEFT JOIN cur ON cur.cur_id = f.id' : 'JOIN cur ON cur.cur_id = f.id';
    text = `WITH ${curCte}
SELECT ${cols}, fj.elem AS finding_raw, (cur.cur_id IS NULL) AS history
FROM opd_audit_feedback f
${join}
LEFT JOIN opd_note_audits a ON a.id = f.audit_id
${lat}
WHERE f.scope = 'finding' AND f.finding_ref IS NOT NULL AND f.app_source = ${app} AND f.study IS NOT DISTINCT FROM ${study}${commonFilters('f', 'a')}
ORDER BY f.created_at DESC, f.id DESC
LIMIT ${P(limit)}`;
  } else {
    const scopeP = P(o.scope);
    text = `SELECT ${cols}, NULL::jsonb AS finding_raw, false AS history
FROM opd_audit_feedback f
LEFT JOIN opd_note_audits a ON a.id = f.audit_id
WHERE f.scope = ${scopeP} AND f.app_source = ${app} AND f.study IS NOT DISTINCT FROM ${study}${commonFilters('f', 'a')}
ORDER BY f.created_at DESC, f.id DESC
LIMIT ${P(limit)}`;
  }
  return { text, params };
}

export type DetailRawRow = {
  feedback_id: string; created_at: string; scope: string; verdict: string | null; comment: string | null;
  author: string | null; uid: string | null; audit_id: string; finding_ref: string | null; signal_type: string | null;
  engine_version: string | null; note_date: string | null; doctor_uid: string | null;
  finding_raw: unknown; history: boolean;
};
/** Shape a raw detail row into the tool output, resolving the finding object from finding_raw. */
export function shapeDetailRow(r: DetailRawRow): Record<string, unknown> {
  const fr = (r.finding_raw && typeof r.finding_raw === 'object') ? r.finding_raw as Record<string, unknown> : null;
  const ref_resolved = r.scope === 'finding' ? fr !== null : false;
  const finding = fr ? {
    subject: fr.subject ?? null, verdict: fr.verdict ?? null, domain: fr.domain ?? null, rationale: fr.rationale ?? null,
  } : null;
  return {
    feedback_id: r.feedback_id, created_at: r.created_at, scope: r.scope, verdict: r.verdict, comment: r.comment,
    author: r.author, uid: r.uid, audit_id: r.audit_id, finding_ref: r.finding_ref, signal_type: r.signal_type,
    engine_version: r.engine_version ?? null, note_date: r.note_date ?? null, doctor_uid: r.doctor_uid ?? null,
    history: r.history === true, ref_resolved, finding,
  };
}

// ── feedback_adjudicate (PRD §4.3) ─────────────────────────────────────────────
export type AdjudicateParsed =
  | { ok: true; action: 'log'; cluster_key: string; decision: Decision; rationale: string; prd_ref: string | null; author: string }
  | { ok: true; action: 'list'; cluster_key: string | null; limit: number }
  | { ok: false; error: string };

/** Validate feedback_adjudicate args (mirrors parseFeedbackBody style; the ONLY write path). */
export function parseAdjudicateArgs(input: unknown): AdjudicateParsed {
  const a: Record<string, unknown> = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const action = String(a.action ?? '').trim();
  if (action !== 'log' && action !== 'list') return { ok: false, error: "action must be 'log' or 'list'" };

  if (action === 'list') {
    const ck = a.cluster_key == null ? null : String(a.cluster_key).trim();
    return { ok: true, action: 'list', cluster_key: ck && ck.length ? ck : null, limit: clampLimit(a.limit) };
  }

  const cluster_key = String(a.cluster_key ?? '').trim();
  if (!cluster_key) return { ok: false, error: 'cluster_key is required for action=log' };
  const decision = String(a.decision ?? '').trim();
  if (!(DECISIONS as readonly string[]).includes(decision)) {
    return { ok: false, error: 'decision must be one of ' + DECISIONS.join(', ') };
  }
  const rationale = String(a.rationale ?? '').trim();
  if (!rationale) return { ok: false, error: 'rationale is required for action=log' };
  const prd_ref = a.prd_ref == null ? null : (String(a.prd_ref).trim() || null);
  const author = (a.author == null ? '' : String(a.author).trim()) || 'cowork-orchestrator';
  return { ok: true, action: 'log', cluster_key: cluster_key.slice(0, 200), decision: decision as Decision, rationale: rationale.slice(0, 4000), prd_ref: prd_ref ? prd_ref.slice(0, 200) : null, author: author.slice(0, 120) };
}

export function buildAdjudicationInsert(v: { cluster_key: string; decision: string; rationale: string; prd_ref: string | null; author: string }): Sql {
  return {
    text: `INSERT INTO opd_feedback_adjudications (cluster_key, decision, rationale, prd_ref, author)
VALUES ($1, $2, $3, $4, $5) RETURNING id, cluster_key, decision, created_at`,
    params: [v.cluster_key, v.decision, v.rationale, v.prd_ref, v.author],
  };
}

export function buildAdjudicationListSql(o: { cluster_key: string | null; limit: number }): Sql {
  const { params, P } = pb();
  const where = o.cluster_key ? ` WHERE cluster_key = ${P(o.cluster_key)}` : '';
  const text = `SELECT id, cluster_key, decision, rationale, prd_ref, author, created_at
FROM opd_feedback_adjudications${where}
ORDER BY created_at DESC, id DESC
LIMIT ${P(clampLimit(o.limit))}`;
  return { text, params };
}

export type LedgerRow = { id: number | string; cluster_key: string; decision: string; rationale: string; prd_ref: string | null; author: string | null; created_at: string };
/**
 * Flag which listed rows are the current status for their cluster_key (newest per cluster_key).
 *
 * LAB-MCP Phase 1 (normative detail 5): currency is decided on the NORMALISED key. The ledger is
 * append-only, so historical rows keep their '<signal>@<engine_version>' key verbatim — but under the
 * bare-signal_type convention those are the SAME cluster. Without normalising here, 'x@0.81.8' and
 * 'x@0.81.14' would each be flagged is_current, showing two current decisions for one cluster and
 * disagreeing with open_adjudications (which already normalises). The stored cluster_key is returned
 * UNCHANGED; only the currency verdict is computed on the normalised form, and cluster_key_normalized
 * is added so a reader can see which rows folded together.
 */
export function reduceLedgerList(rows: LedgerRow[]): (LedgerRow & { is_current: boolean; cluster_key_normalized: string })[] {
  const seen = new Set<string>();
  // rows arrive newest-first; the first row per NORMALISED cluster_key is current
  return rows.map((r) => {
    const nk = normalizeClusterKey(r.cluster_key);
    const first = !seen.has(nk);
    if (first) seen.add(nk);
    return { ...r, is_current: first, cluster_key_normalized: nk };
  });
}
