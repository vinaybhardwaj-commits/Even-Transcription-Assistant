/**
 * Pure core for OPD-audit feedback capture (PRD §4.3 + Gold-Label Review-Mode PRD §3). No Next / no
 * db imports so it strip-types and unit-tests standalone. The route (app/api/opd-audit/feedback/
 * route.ts) calls parseFeedbackBody to validate + normalise the request body, then inserts the
 * returned columns verbatim.
 *
 * Scopes (PRD §4.1 + Review-Mode §2/§3):
 *   - 'audit'   → whole-audit reaction + general comment (legacy path; a bare comment is allowed).
 *   - 'finding' → reviewer's call on a finding that FIRED; verdict ∈ FINDING_VERDICTS, finding_ref required.
 *   - 'impact'  → TP-only optional SECOND tap on a finding: verdict ∈ IMPACT_TAGS, finding_ref required.
 *   - 'missed'  → a finding that SHOULD have fired but didn't; verdict='missed', comment required,
 *                 `category` from MISSED_CATEGORIES REQUIRED (F6 / addendum A10.1; was optional).
 *
 * Append-only: one call = one row; current state = latest row per (audit_id, finding_ref, scope).
 */

export const FINDING_VERDICTS = ['true_positive', 'nitpick', 'false', 'contested'] as const;
export const AUDIT_VERDICTS = ['agree', 'disagree', 'needs_action'] as const;
/** Review-Mode §1.2 — the TP-only optional second tap (`i`). One row per (finding_ref) with scope='impact'. */
export const IMPACT_TAGS = ['changes_management', 'chart_hygiene'] as const;
/** Review-Mode §1.6 — domain-aligned missed-finding categories (validated whitelist). */
export const MISSED_CATEGORIES = [
  'documentation', 'note_quality', 'appropriateness_low_value', 'prescribing_safety',
  'continuity', 'coding', 'other',
] as const;
export const MISSED_VERDICT = 'missed';
export const SCOPES = ['audit', 'finding', 'missed', 'impact'] as const;

export type FindingVerdict = (typeof FINDING_VERDICTS)[number];
export type AuditVerdict = (typeof AUDIT_VERDICTS)[number];
export type ImpactTag = (typeof IMPACT_TAGS)[number];
export type MissedCategory = (typeof MISSED_CATEGORIES)[number];
export type FeedbackScope = (typeof SCOPES)[number];

/** Allowed verdict values keyed by scope (PRD §4.1 table + Review-Mode extensions). */
export const FEEDBACK_VERDICTS: Record<FeedbackScope, ReadonlySet<string>> = {
  audit: new Set(AUDIT_VERDICTS),
  finding: new Set(FINDING_VERDICTS),
  missed: new Set([MISSED_VERDICT]),
  impact: new Set(IMPACT_TAGS),
};

const AUDIT_ID_RE = /^[0-9a-f-]{36}$/i;

export type FeedbackRow = {
  auditId: string;
  scope: FeedbackScope;
  uid: string | null;
  verdict: string | null;
  comment: string | null;
  author: string | null;
  finding_ref: string | null;
  signal_type: string | null;
  category: string | null;
  /** Study-filter build (§8, D8): the labelling study this row belongs to. NULL = production.
   *  Non-null study REQUIRES a non-empty author (validated here, not in the route) — an
   *  unattributable study row can never be compared across raters. Stored exactly as typed
   *  (author too — D9/D10: trim/casefold only in reducers, never in SQL, never at write time). */
  study: string | null;
};

export type ParseResult =
  | { ok: true; value: FeedbackRow }
  | { ok: false; error: string };

function str(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().slice(0, max);
  return s.length ? s : null;
}

/**
 * Validate + normalise a feedback POST body. Backward-compatible: a body with no `scope` is treated
 * as legacy 'audit'. Returns normalised columns ready to insert, or a 400-worthy error string.
 */
export function parseFeedbackBody(input: unknown): ParseResult {
  const body: Record<string, unknown> = (input && typeof input === 'object') ? (input as Record<string, unknown>) : {};

  const auditId = String(body.auditId ?? '').trim();
  if (!AUDIT_ID_RE.test(auditId)) return { ok: false, error: 'bad auditId' };

  const rawScope = body.scope === undefined || body.scope === null ? 'audit' : String(body.scope);
  if (!(SCOPES as readonly string[]).includes(rawScope)) return { ok: false, error: 'bad scope' };
  const scope = rawScope as FeedbackScope;

  const uid = str(body.uid, 64);
  const comment = str(body.comment, 4000);
  const author = str(body.author, 120);
  const rawVerdict = str(body.verdict, 40);
  const finding_ref = str(body.finding_ref, 40);
  const signal_type = str(body.signal_type, 120);
  const rawCategory = str(body.category, 60);
  // Study-filter build (§8, D8): string, trimmed, ≤64 chars, empty → null. A non-null study
  // REQUIRES an author — the rule lives HERE so every write path through this parser enforces it.
  const study = str(body.study, 64);
  if (study !== null && author === null) {
    return { ok: false, error: 'author required when study is set' };
  }

  if (scope === 'finding') {
    if (!rawVerdict || !FEEDBACK_VERDICTS.finding.has(rawVerdict)) {
      return { ok: false, error: 'finding verdict must be one of ' + FINDING_VERDICTS.join(', ') };
    }
    if (!finding_ref) return { ok: false, error: 'finding_ref required for scope=finding' };
    return { ok: true, value: { auditId, scope, uid, verdict: rawVerdict, comment, author, finding_ref, signal_type, category: null, study } };
  }

  if (scope === 'impact') {
    // Review-Mode §1.2 — the TP-only optional second tap. Its own append-row so the base verdict
    // stays a clean true_positive; current impact = latest scope='impact' row per finding_ref.
    if (!rawVerdict || !FEEDBACK_VERDICTS.impact.has(rawVerdict)) {
      return { ok: false, error: 'impact tag must be one of ' + IMPACT_TAGS.join(', ') };
    }
    if (!finding_ref) return { ok: false, error: 'finding_ref required for scope=impact' };
    return { ok: true, value: { auditId, scope, uid, verdict: rawVerdict, comment, author, finding_ref, signal_type, category: null, study } };
  }

  if (scope === 'missed') {
    if (!comment) return { ok: false, error: 'comment required for scope=missed' };
    // F6 (addendum A10.1): `category` is REQUIRED for scope='missed' — changed from optional.
    // The whitelist already existed and already rejected unknowns; the only defect was that the
    // client could omit it, so recall had no denominator to group by. NO new classifier is invented:
    // MISSED_CATEGORIES is reused verbatim. Existing rows with no category are NOT backfilled with a
    // guess — feedback_rollup groups them as '(unclassified)'.
    if (rawCategory === null) {
      return { ok: false, error: 'category required for scope=missed — one of ' + MISSED_CATEGORIES.join(', ') };
    }
    if (!(MISSED_CATEGORIES as readonly string[]).includes(rawCategory)) {
      return { ok: false, error: 'category must be one of ' + MISSED_CATEGORIES.join(', ') };
    }
    const category: string = rawCategory;
    // verdict is fixed for missed; ignore/override whatever was sent.
    return { ok: true, value: { auditId, scope, uid, verdict: MISSED_VERDICT, comment, author, finding_ref: null, signal_type, category, study } };
  }

  // scope === 'audit' — legacy path. verdict optional (constrained if present); bare comment allowed.
  const verdict = rawVerdict && FEEDBACK_VERDICTS.audit.has(rawVerdict) ? rawVerdict : null;
  if (!verdict && !comment) return { ok: false, error: 'provide a verdict or a comment' };
  return { ok: true, value: { auditId, scope, uid, verdict, comment, author, finding_ref: null, signal_type: null, category: null, study } };
}
