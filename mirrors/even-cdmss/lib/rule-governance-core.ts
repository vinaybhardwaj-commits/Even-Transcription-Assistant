/**
 * lib/rule-governance-core.ts — R3-A: the Even rule book, PURE core (CDMSS R3-A PRD + kickoff,
 * 20 Aug 2026; ruling authority Saul Rep 41, product authority V).
 *
 * DORMANT. Nothing in the repo imports this module except its own store and its own two admin
 * routes. It is not reachable from the audit engine, the score core, the LVP shelf, the care
 * surfaces or any worker. See lib/__tests__/rule-governance-dormancy.test.ts, which proves it.
 *
 * NO LLM. This module issues no prompt, registers no prompt, and calls no model (kickoff §6
 * trap 7 — if it ever did, the reasoning registry gate would apply to it, and it does not).
 *
 * WHAT LIVES HERE (kickoff §5): types · the derived validity-window computation (S2) · evidence
 * validation (§3.4) · the flag predicate (S3) · the definition-hash field order. No IO, no SQL,
 * no env read at module scope — every function that depends on the environment takes it as a
 * parameter, so the flag-off proof can sweep it (kickoff §4 proof 2).
 *
 * THE SHAPE OF THE RULE BOOK (S2, Saul Rep 41): a version row is IMMUTABLE — written once, never
 * updated, never deleted, and carrying NO `valid_to` column. Activation and retirement are
 * append-only EVENTS. `[valid_from, valid_to)` is DERIVED from the event stream: an `activate`
 * opens a window, the NEXT event on the same rule closes it, and the currently active version has
 * `valid_to = null`. Reactivating an earlier version appends a second `activate` and therefore
 * yields a SECOND window for that version — which is why the window is derived and not stored.
 */

// ── the flag (S3) ────────────────────────────────────────────────────────────────────────────────
// Checked as the EXACT string '1'. Never `Boolean(env.X)`, never `!== '0'`: the anti-truthiness
// sweep in the dormancy test pins ['', '0', 'true', 'yes', '2', 'on', ' 1 ', undefined] to OFF.

export const RULE_GOVERNANCE_FLAG = 'LVC_RULE_GOVERNANCE_ENABLED';

/** The gate object. Flag off ⇒ `{}` — the `enabled` key is ABSENT, not false, copying the
 *  lib/__tests__/opd-normative-leg-gate.test.ts precedent: a key that is never written cannot be
 *  read as accidentally-truthy by a later caller. */
export interface RuleGovernanceGate {
  enabled?: true;
}

/** Pure: env in, gate out. The ONLY place the flag string is compared, anywhere in the module. */
export function ruleGovernanceGate(env: Record<string, string | undefined>): RuleGovernanceGate {
  return env[RULE_GOVERNANCE_FLAG] === '1' ? { enabled: true } : {};
}

/** Convenience predicate over the same gate. Off by default and off for every non-'1' value. */
export function isRuleGovernanceEnabled(env: Record<string, string | undefined>): boolean {
  return 'enabled' in ruleGovernanceGate(env);
}

// ── the evidence tuple (§3.4) ────────────────────────────────────────────────────────────────────
// Copied from lvc_concept_rulings (migration 0020:28-43) and its rationale, verbatim: "Evidence
// columns, all mandatory: they exist so a later reader can distinguish a ruling made on evidence
// from one made on a label. reviewed_n = 0 is a ruling on an abstraction."

export interface GovernanceEvidence {
  ratified_by: string;       // a NAMED human. never 'admin' (§3.4; S5 keeps the live-suppression
                             // `approved_by='admin'` removal out of this unit, but nothing new
                             // here is allowed to add another one)
  rationale: string;
  sample_size: number;
  reviewed_n: number;
  sample_seed: string;
  n_not_belonging: number | null;   // "where meaningful" (§3.4) — null is honest, 0 is a claim
}

const BANNED_RATIFIERS = new Set(['admin', 'system', 'cron', 'worker', 'care-manager']);

export type EvidenceProblem = string;

/** Pure validation of the evidence tuple. Returns [] when the tuple may be written. */
export function validateEvidence(raw: unknown): EvidenceProblem[] {
  const problems: EvidenceProblem[] = [];
  if (raw == null || typeof raw !== 'object') return ['evidence: must be an object'];
  const e = raw as Record<string, unknown>;

  const by = typeof e.ratified_by === 'string' ? e.ratified_by.trim() : '';
  if (!by) problems.push('ratified_by: required — a named human, never a role');
  else if (BANNED_RATIFIERS.has(by.toLowerCase())) {
    problems.push(`ratified_by: '${by}' is a role, not a person — name the human who ruled`);
  }

  const rationale = typeof e.rationale === 'string' ? e.rationale.trim() : '';
  if (!rationale) problems.push('rationale: required — a ruling with no stated reason is not evidence');

  for (const k of ['sample_size', 'reviewed_n'] as const) {
    const v = e[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      problems.push(`${k}: required — a non-negative integer (0 is legitimate and means "ruled on an abstraction")`);
    }
  }
  if (problems.length === 0 && (e.reviewed_n as number) > (e.sample_size as number)) {
    problems.push('reviewed_n: cannot exceed sample_size');
  }

  const seed = typeof e.sample_seed === 'string' ? e.sample_seed.trim() : '';
  if (!seed) problems.push('sample_seed: required — an unseeded sample cannot be re-drawn');

  const nnb = e.n_not_belonging;
  if (nnb != null && (typeof nnb !== 'number' || !Number.isInteger(nnb) || nnb < 0)) {
    problems.push('n_not_belonging: when supplied, a non-negative integer');
  }
  return problems;
}

/** Narrow an already-validated tuple. Throws on invalid input — callers validate first. */
export function asEvidence(raw: unknown): GovernanceEvidence {
  const problems = validateEvidence(raw);
  if (problems.length) throw new Error(`invalid evidence: ${problems.join('; ')}`);
  const e = raw as Record<string, unknown>;
  return {
    ratified_by: String(e.ratified_by).trim(),
    rationale: String(e.rationale).trim(),
    sample_size: Number(e.sample_size),
    reviewed_n: Number(e.reviewed_n),
    sample_seed: String(e.sample_seed).trim(),
    n_not_belonging: e.n_not_belonging == null ? null : Number(e.n_not_belonging),
  };
}

// ── the frozen executable definition (§3.1) ──────────────────────────────────────────────────────

/**
 * The fields the matcher and the recall legs actually read off a registry row, in the ONE
 * canonical order the definition hash uses. Both write paths (bootstrap over lvc_recommendations,
 * and the pattern proposal) build the hash from these fields in this order — a test asserts both
 * SQL statements do, so the two can never hash the same definition differently.
 *
 * WHY THESE FIVE: `keywords` + `category` are what lib/opd-note-audit.ts:120 reads to match;
 * `statement` + `precondition` are what the recall leg and the judge read; `action_type` is what
 * the classifier reads. Nothing else on the row changes what a rule DOES.
 */
export const DEFINITION_HASH_FIELDS = [
  'statement', 'precondition', 'action_type', 'keywords', 'category',
] as const;

export type DefinitionField = (typeof DEFINITION_HASH_FIELDS)[number];

export interface RuleDefinition {
  statement: string;
  precondition: string | null;
  action_type: string | null;
  keywords: unknown;          // jsonb — array | json-string | csv, exactly as the registry stores it
  category: string | null;
}

/** The evaluator disposition every governance row is stamped with (S4). Hardcoded, never an
 *  argument: a governed rule version in R3-A can only ever be informational. */
export const EVALUATOR_DISPOSITION = 'informational' as const;

/** Where a version row came from. `bootstrap_snapshot` is NEVER a retroactive ratification (§3.8). */
export type VersionOrigin = 'bootstrap_snapshot' | 'proposal';

export interface RuleVersionRow extends RuleDefinition, GovernanceEvidence {
  rule_ref: string;
  version: number;
  definition_hash: string;
  origin: VersionOrigin;
  evaluator_disposition: typeof EVALUATOR_DISPOSITION;
  proposal_id: string | null;
  created_at: string;
}

// ── the event stream and the derived window (S2, §3.3) ───────────────────────────────────────────

export type ActivationEventKind = 'activate' | 'retire';

export interface ActivationEvent {
  rule_ref: string;
  version: number;
  event: ActivationEventKind;
  effective_at: string;      // ISO timestamp
  id?: number;               // tie-breaker within one effective_at (bigserial, ascending)
}

export interface ValidityWindow {
  rule_ref: string;
  version: number;
  valid_from: string;
  valid_to: string | null;   // null ⇒ this version is the currently active one
}

/**
 * The DERIVED validity windows (S2 — this is why `lvc_rule_versions` has no `valid_to` column).
 *
 * The stream is per RULE, not per version: a retire of v1 and an activate of v2 both close v1's
 * window, because both are "the next event". An `activate` opens a window; the next event on the
 * same rule_ref — whatever it is — closes it; the last activate with nothing after it stays open.
 * Reactivating an earlier version appends a SECOND activate and therefore yields a SECOND window
 * for that version, which a stored valid_to could not represent.
 *
 * Ordering is (effective_at, id) so two events stamped in the same instant still order the way
 * they were appended. Pure — the SQL view v_lvc_rule_validity computes exactly this shape with
 * lead() over the same ordering.
 */
export function deriveValidityWindows(events: ActivationEvent[]): ValidityWindow[] {
  const byRule = new Map<string, ActivationEvent[]>();
  for (const e of events) {
    const list = byRule.get(e.rule_ref) ?? [];
    list.push(e);
    byRule.set(e.rule_ref, list);
  }
  const windows: ValidityWindow[] = [];
  for (const [rule_ref, list] of byRule) {
    const ordered = [...list].sort((a, b) =>
      (a.effective_at < b.effective_at ? -1 : a.effective_at > b.effective_at ? 1 : 0)
      || ((a.id ?? 0) - (b.id ?? 0)));
    for (let i = 0; i < ordered.length; i++) {
      const e = ordered[i];
      if (e.event !== 'activate') continue;
      const next = ordered[i + 1];
      windows.push({
        rule_ref,
        version: e.version,
        valid_from: e.effective_at,
        valid_to: next ? next.effective_at : null,
      });
    }
  }
  return windows.sort((a, b) =>
    a.rule_ref.localeCompare(b.rule_ref)
    || (a.valid_from < b.valid_from ? -1 : a.valid_from > b.valid_from ? 1 : 0)
    || a.version - b.version);
}

/** The version active for a rule at an instant, or null. Derived, never stored. */
export function activeVersionAt(events: ActivationEvent[], ruleRef: string, at: string): number | null {
  const w = deriveValidityWindows(events).filter((x) => x.rule_ref === ruleRef
    && x.valid_from <= at && (x.valid_to === null || at < x.valid_to));
  return w.length ? w[w.length - 1].version : null;
}

// ── the pattern → rule bridge snapshot (§3.7, S8) ────────────────────────────────────────────────

/** Which source supplied direction/action/target for a shelf pattern (S8). The lvc_concepts join
 *  is authoritative when the row exists; the concept-id prefix parse is the fallback. The shelf
 *  computes this and discards it — a frozen snapshot that does not record which one was used
 *  cannot be replayed, because the two disagree for any concept absent from the dictionary. */
export type SlotsProvenance = 'dictionary' | 'prefix_parse';

/**
 * The FROZEN evidence snapshot (§3.7). The shelf is computed on read over a moving seven-day IST
 * window, with hide-filtering applied BEFORE the floor and the cap — so nothing about a card is
 * reproducible later unless it is frozen at proposal time, constants included. The three shelf
 * constants changed on 20 Aug 2026 (Addendum B split the single cap into a per-block pair); a
 * snapshot omitting them cannot be replayed against a shelf built under a different pair.
 */
export interface PatternEvidenceSnapshot {
  pattern_id: string;
  concept_id: string;
  volume_week: number;
  doctor_count: number | null;
  direction: string;
  action: string;
  target: string;
  slots_provenance: SlotsProvenance;
  first_seen: string | null;
  examples: string[];
  generated_at: string;
  model: string;
  // the constants in force at freeze time (S8)
  lvp_floor: number;
  lvp_cap: number;
  lvp_non_overuse_cap: number;
}

/** Every key a frozen snapshot must carry. A test asserts the bridge writes all of them. */
export const PATTERN_SNAPSHOT_KEYS: readonly (keyof PatternEvidenceSnapshot)[] = [
  'pattern_id', 'concept_id', 'volume_week', 'doctor_count', 'direction', 'action', 'target',
  'slots_provenance', 'first_seen', 'examples', 'generated_at', 'model',
  'lvp_floor', 'lvp_cap', 'lvp_non_overuse_cap',
] as const;

/** Pure completeness check on a built snapshot — no key may be missing, not even as undefined. */
export function missingSnapshotKeys(snapshot: Record<string, unknown>): string[] {
  return PATTERN_SNAPSHOT_KEYS.filter((k) => !(k in snapshot)).map(String);
}
