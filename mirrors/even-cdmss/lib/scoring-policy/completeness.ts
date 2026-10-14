/**
 * lib/scoring-policy/completeness.ts — weighted NABH completeness over a STORED items array.
 *
 * PURE, dependency-free, strip-types testable. PRD §2.3.
 *
 *     C = 100 × Σ(wᵢ · eᵢ) ÷ Σ(wᵢ)      for i ∈ A (the applicable fields)
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE INVARIANT (PRD §2.5) — READ THIS BEFORE CHANGING ANY LINE BELOW
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * With every field on Standard this must reproduce stored `completeness_pct` EXACTLY on real rows.
 * That constrains three things which are NOT free choices:
 *
 *   1. APPLICABILITY must match lib/doc-audit-core.ts `assembleCompleteness` (the legacy producer):
 *        · a mandatory NON-conditional field is ALWAYS in the denominator, whatever its status;
 *        · a mandatory CONDITIONAL field is in the denominator only when its status is
 *          present | partial | missing — `na` removes it from numerator AND denominator.
 *
 *   2. CREDIT must match it too — and here legacy and the PRD's prose DIVERGE. See NA_POLICY below.
 *
 *   3. ROUNDING is DOUBLE, not single. Legacy computes
 *        coverage        = Math.round((met / total) * 100) / 100      (lib/doc-audit-core.ts)
 *        completeness_pct = Math.round(coverage * 100)                (lib/ipd-audit/assemble.ts:59)
 *      Both are Math.round — half-up toward +∞, which for a non-negative percentage IS half-up.
 *      The double round is reproduced verbatim in `roundPctLikeLegacy` rather than collapsed to a
 *      single Math.round, because collapsing it is only *usually* equivalent and this function's
 *      whole job is to be exactly equivalent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { pointsFor, type WeightVector } from './weights';

export type FieldStatus = 'present' | 'partial' | 'missing' | 'na';

/** The stored item shape, as persisted in `report.completeness.items` (lib/doc-audit-core.ts
 *  CompletenessItem). `section`/`ref`/`label` are carried for rendering; only `key` and `status`
 *  enter the arithmetic. Extra properties are tolerated and ignored. */
export interface StoredItem {
  key: string;
  status?: unknown;
  label?: string;
  section?: string;
  ref?: string;
  note?: string;
  mandatory?: boolean;
}

/**
 * ⚠️ THE ONE GENUINELY UNSETTLED POINT IN THIS BUILD — flagged, not improvised.
 *
 * The kickoff's normative list says: "na = EXCLUDED from numerator AND denominator" and
 * "Applicability = (status !== 'na')". The LEGACY CODE THAT PRODUCED THE STORED VALUES does
 * something different for NON-CONDITIONAL fields — lib/doc-audit-core.ts:608 reads
 *
 *     if (st === 'present' || st === 'na') mandatoryMet += 1;
 *
 * i.e. `na` on a non-conditional mandatory field scores FULL CREDIT and STAYS in the denominator.
 * Only CONDITIONAL fields (`cause_of_death` is the sole one — data/nabh-rubric.json) are dropped
 * from both sides when `na`.
 *
 * These two rules give different numbers whenever a non-conditional field is `na` and anything
 * else is missing. Worked example, 20 fields, 1 `na`, 10 present, 9 missing:
 *     kickoff rule  → 10/19 = 52.6 → 53
 *     legacy rule   → 11/20 = 55.0 → 55
 *
 * Corroborating evidence that legacy is what the stored data reflects: PRD §2.1 reports that
 * `mandatoryMet = present + 0.5×partial` holds on 313 of 345 audits and attributes the 32
 * exceptions to "a rounding tie-break". But `mandatoryMet` is a raw sum of 1.0 / 0.5 / 0.0 terms —
 * it is a multiple of 0.5 by construction, so `Math.round(met*10)/10` is a no-op on it and ROUNDING
 * CANNOT PRODUCE AN EXCEPTION THERE. An `na` on a non-conditional field adds exactly the missing
 * +1 and explains all 32. `procedures_performed` is the rubric's one `"na": true` field and is the
 * obvious source.
 *
 * RESOLUTION: PRD §2.5 makes reproducing the stored values the hard gate ("the build is not
 * complete until v1 reproduces all 345 stored values exactly"), and ranks it above its own prose.
 * So the default is LEGACY_EXACT. The alternative is implemented, named and switchable so that if
 * the orchestrator's live check shows otherwise it is a one-constant change, not a rewrite.
 */
export type NaPolicy =
  /** Reproduces lib/doc-audit-core.ts exactly: `na` on a non-conditional field = full credit,
   *  stays in the denominator; `na` on a conditional field leaves both sides. THE DEFAULT. */
  | 'legacy-exact'
  /** The kickoff's literal prose: `na` always leaves numerator and denominator. */
  | 'na-excluded';

export const NA_POLICY: NaPolicy = 'legacy-exact';

/**
 * The ONE conditional key in `discharge_summary`, read VERBATIM from data/nabh-rubric.json:
 *     {"key":"cause_of_death", …, "cond":"outcome=Death"}
 * No other field in any section carries `cond`. Passed as a parameter (not imported) so this core
 * stays pure and so a rubric change is a caller concern, not a hidden coupling.
 */
export const DISCHARGE_SUMMARY_COND_KEYS: readonly string[] = ['cause_of_death'];

/** OPD emits no conditional fields — its conditionality is expressed by the item simply not being
 *  emitted for that encounter (a teleconsult has no `examination` item at all). */
export const OPD_RX_COND_KEYS: readonly string[] = [];

const VALID: ReadonlySet<string> = new Set(['present', 'partial', 'missing', 'na']);

/** Coerce a stored status. Anything unrecognised is treated as `missing`, matching legacy's
 *  `const status: FieldStatus = r ? r.status : 'missing'` for an absent reading. */
export function asStatus(v: unknown): FieldStatus {
  return typeof v === 'string' && VALID.has(v) ? (v as FieldStatus) : 'missing';
}

/** Per-field credit eᵢ (PRD §2.1). `na` is handled by the caller via the policy, not here. */
export function creditFor(status: FieldStatus): number {
  if (status === 'present') return 1;
  if (status === 'partial') return 0.5;
  return 0;   // missing; `na` never reaches here under either policy
}

/**
 * Legacy's exact rounding chain. Input is the raw ratio (0..1), output the integer percentage.
 * Deliberately two rounds — see the header note. Do not "simplify" this.
 */
export function roundPctLikeLegacy(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  const coverage = Math.round(ratio * 100) / 100;   // lib/doc-audit-core.ts:623
  return Math.round(coverage * 100);                // lib/ipd-audit/assemble.ts:59
}

export interface WeightedCompleteness {
  /** 0..100 integer, rounded exactly as legacy rounds. */
  pct: number;
  /** How many fields entered the denominator. */
  applicable: number;
  /** Labels of applicable fields returned `missing` — the unweighted NABH gap count (PRD §6.5). */
  missingMandatory: string[];
  /** Σ(wᵢ) over applicable fields, in raw tier points. 0 ⇒ the all-`na` case. */
  weightSum: number;
}

export interface WeightedCompletenessOptions {
  /** Keys that are CONDITIONAL for this note type. Default: none. */
  condKeys?: readonly string[];
  /** Default 'legacy-exact' — see NA_POLICY. */
  naPolicy?: NaPolicy;
}

/**
 * §2.3 over a stored items array. Never throws; a malformed input degrades to a defined answer.
 *
 * `vector` may be null — that is the PRD §8.1 fallback (no active version / table missing) and
 * yields equal weighting, i.e. exactly legacy behaviour.
 */
export function weightedCompleteness(
  items: StoredItem[] | null | undefined,
  vector: WeightVector | null | undefined,
  opts: WeightedCompletenessOptions = {},
): WeightedCompleteness {
  const cond = new Set(opts.condKeys ?? []);
  const policy = opts.naPolicy ?? NA_POLICY;
  const list = Array.isArray(items) ? items : [];

  let num = 0, den = 0, applicable = 0;
  const missingMandatory: string[] = [];

  for (const it of list) {
    if (!it || typeof it.key !== 'string' || !it.key) continue;
    const status = asStatus(it.status);
    const isCond = cond.has(it.key);

    // ── APPLICABILITY ──────────────────────────────────────────────────────────────────────────
    // Conditional + `na` ⇒ the condition did not hold; the field leaves both sides. This branch is
    // identical under both policies and is what makes mandatoryTotal 20 rather than 21 on the 342
    // audits where `cause_of_death` is `na` (PRD §2.9).
    if (isCond && status === 'na') continue;
    // Non-conditional + `na` ⇒ policy decides. Under 'legacy-exact' it stays, with full credit.
    if (!isCond && status === 'na' && policy === 'na-excluded') continue;

    const w = pointsFor(vector, it.key);
    den += w;
    applicable += 1;
    num += w * (status === 'na' ? 1 : creditFor(status));
    if (status === 'missing') missingMandatory.push(it.label || it.key);
  }

  // PRD §8.5 — a document where every field is `na`: Σ(wᵢ)=0 ⇒ return 100, never divide by zero.
  if (den <= 0) return { pct: 100, applicable: 0, missingMandatory, weightSum: 0 };

  return { pct: roundPctLikeLegacy(num / den), applicable, missingMandatory, weightSum: den };
}

/**
 * The legacy value, recomputed from the same items with no weighting at all. Used by the
 * regression test as the reference, and by the UI to show "what this was before".
 * Identical to `weightedCompleteness(items, null, …)` by construction — kept as its own named
 * function so the test asserts an INDEPENDENT path rather than the same expression twice.
 */
export function legacyCompleteness(
  items: StoredItem[] | null | undefined,
  opts: WeightedCompletenessOptions = {},
): number {
  const cond = new Set(opts.condKeys ?? []);
  const policy = opts.naPolicy ?? NA_POLICY;
  const list = Array.isArray(items) ? items : [];
  let met = 0, total = 0;
  for (const it of list) {
    if (!it || typeof it.key !== 'string' || !it.key) continue;
    const status = asStatus(it.status);
    const isCond = cond.has(it.key);
    if (isCond && status === 'na') continue;
    if (!isCond && status === 'na' && policy === 'na-excluded') continue;
    total += 1;
    if (status === 'present' || status === 'na') met += 1;
    else if (status === 'partial') met += 0.5;
  }
  if (total <= 0) return 100;
  return roundPctLikeLegacy(met / total);
}

/** Group items by their stored `section`, preserving first-seen section order (PRD §5.3, §6.5). */
export function bySection(items: StoredItem[] | null | undefined): { section: string; items: StoredItem[] }[] {
  const order: string[] = [];
  const map = new Map<string, StoredItem[]>();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it.key !== 'string') continue;
    const s = typeof it.section === 'string' && it.section ? it.section : 'other';
    if (!map.has(s)) { map.set(s, []); order.push(s); }
    map.get(s)!.push(it);
  }
  return order.map((s) => ({ section: s, items: map.get(s)! }));
}
