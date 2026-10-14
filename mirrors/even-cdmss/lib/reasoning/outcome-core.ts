/**
 * lib/reasoning/outcome-core.ts — version→outcome correlation (Reasoning Observability
 * Stage 3). Joins the COMMITTED eval scorecards (data/right-care-eval/*) to the prompt
 * version/hash that produced them, so a prompt change's effect on its gold is visible.
 *
 * PURE + DETERMINISTIC: static imports of committed JSON only — no DB, no fetch, no env,
 * no re-running of any scorer (the scorecard is the frozen measurement; this module only
 * projects it). Order check is the first vertical with a gold (right-care-check-gold/1.0,
 * shipped b628e15); other verticals join as their gold banks land.
 *
 * The MATURITY GATE lives here too: a manifest entry may claim 'mature' ONLY if its
 * measured version cleared its gold (floor 0.90 — the ratified ddx-eval gate-floor
 * convention). Enforced as a CI assertion in lib/__tests__/reasoning-outcome.test.ts.
 */

import CHECK_SCORECARD from '../../data/right-care-eval/check-gold-scorecard-v1.json';
import { promptFingerprint } from './registry-core';
import type { PromptManifest } from './manifest';

export interface OutcomeStat { mean: number; std: number }

export interface OutcomeArm {
  arm: 'ungrounded' | 'grounded';
  /** What the arm actually toggled — the reader shouldn't need the harness docs. */
  flag: string;
  recall: OutcomeStat;
  specificity: OutcomeStat;
  precision: OutcomeStat;
  f1: OutcomeStat;
}

export interface PromptOutcome {
  promptId: string;
  /** Version hint + sha256 of the prompt text AS MEASURED. The hash is pinned to the
   *  measurement (a historical fact — it must NOT float with the live registry); `current`
   *  says whether the live prompt bytes still match, i.e. whether this evidence still
   *  applies to what production runs today. */
  measuredVersion: string;
  measuredHash: string;
  measuredAtSha: string;
  current: boolean;
  gold: string;
  scorecard: string;
  repeats: number;
  cases: number;
  arms: OutcomeArm[];
  /** The eval harness records neither spend nor latency — honest nulls. Live ₹ by prompt
   *  version is the LLM-cost tab's 4th breakdown (Stage 2). */
  rupeesPerRun: null;
  p50Ms: null;
}

interface RawStat { mean: number; std: number }
interface RawArm { recall: RawStat; specificity: RawStat; precision: RawStat; f1: RawStat }
interface RawScorecard {
  version: string; gold: string; repeats: number;
  armStats: { off: RawArm; on: RawArm };
  caseTable: unknown[];
}

const sc = CHECK_SCORECARD as unknown as RawScorecard;

const stat = (s: RawStat): OutcomeStat => ({ mean: s.mean, std: s.std });

/** sha256 of lvc-core/JUDGE_SYSTEM as measured — re-pinned 16-Jul-2026 for the JUDGE_SYSTEM
 *  calibration (absence-defined preconditions + chronicity + named-exclusions rules); the 1.0
 *  governance gold was re-run on these bytes (check-gold-scorecard-v1, both arms 100%).
 *  Deliberately pinned (not resolved from the live registry): the metrics belong to these
 *  exact prompt bytes; `current` compares against today's registry hash. */
const CHECK_MEASURED_HASH = '12ca534cb6de8e5a5ce0aad4655a4a55f177cc22d415de2b4e3e1e7dd736411a';
const CHECK_MEASURED_AT = 'judge-cal-16jul2026';

function checkOutcome(): PromptOutcome {
  const live = promptFingerprint('lvc-core/JUDGE_SYSTEM');
  return {
    promptId: 'lvc-core/JUDGE_SYSTEM',
    measuredVersion: live?.version ?? 'unversioned (git-tracked)',
    measuredHash: CHECK_MEASURED_HASH,
    measuredAtSha: CHECK_MEASURED_AT,
    current: live?.hash === CHECK_MEASURED_HASH,
    gold: sc.gold,
    scorecard: sc.version,
    repeats: sc.repeats,
    cases: sc.caseTable.length,
    arms: [
      {
        arm: 'ungrounded', flag: 'RIGHT_CARE_CLINICAL_STATE_GROUND=0 (baseline)',
        recall: stat(sc.armStats.off.recall), specificity: stat(sc.armStats.off.specificity),
        precision: stat(sc.armStats.off.precision), f1: stat(sc.armStats.off.f1),
      },
      {
        arm: 'grounded', flag: 'RIGHT_CARE_CLINICAL_STATE_GROUND=1 (ClinicalState PATIENT PICTURE)',
        recall: stat(sc.armStats.on.recall), specificity: stat(sc.armStats.on.specificity),
        precision: stat(sc.armStats.on.precision), f1: stat(sc.armStats.on.f1),
      },
    ],
    rupeesPerRun: null,
    p50Ms: null,
  };
}

/** Every prompt id with a committed gold outcome. Order check only today; a new vertical's
 *  scorecard lands here as one map entry (its gold bank is the hard part, not this join). */
const OUTCOMES: Record<string, () => PromptOutcome> = {
  'lvc-core/JUDGE_SYSTEM': checkOutcome,
};

/** The version→outcome join. Unknown / no-gold id → null, never a throw. */
export function outcomeForPrompt(id: string): PromptOutcome | null {
  const f = OUTCOMES[id];
  return f ? f() : null;
}

export function allOutcomes(): PromptOutcome[] {
  return Object.keys(OUTCOMES).sort().map((id) => outcomeForPrompt(id)!);
}

// ── the maturity gate ────────────────────────────────────────────────────────────────────────

/** Gold gate floor — the ratified ddx-eval convention (gate floor 0.90) applied house-wide. */
export const GOLD_PASS_FLOOR = 0.9;

/** A prompt's gold is cleared when the BASELINE arm (the configuration production ships,
 *  ungrounded) holds recall, specificity and F1 at/above the floor. */
export function outcomeClearsGold(o: PromptOutcome): boolean {
  const base = o.arms.find((a) => a.arm === 'ungrounded') ?? o.arms[0];
  if (!base) return false;
  return base.recall.mean >= GOLD_PASS_FLOOR
    && base.specificity.mean >= GOLD_PASS_FLOOR
    && base.f1.mean >= GOLD_PASS_FLOOR;
}

/**
 * The Stage-3 maturity rule: 'mature' requires a committed, cleared gold measured on the
 * CURRENT prompt bytes; verticals without a gold stay ≤ 'review'. Returns human-readable
 * violations (empty = gate green). Enforced in CI by reasoning-outcome.test.ts — kept out
 * of the serving path so the export's never-throw contract is untouched.
 */
export function maturityGateViolations(
  manifests: readonly Pick<PromptManifest, 'id' | 'maturity'>[],
  outcomeFor: (id: string) => PromptOutcome | null = outcomeForPrompt,
): string[] {
  const out: string[] = [];
  for (const m of manifests) {
    if (m.maturity !== 'mature') continue;
    const o = outcomeFor(m.id);
    if (!o) { out.push(`${m.id}: maturity 'mature' with NO committed gold outcome — no-gold verticals stay ≤ 'review'`); continue; }
    if (!outcomeClearsGold(o)) out.push(`${m.id}: maturity 'mature' but its gold baseline is below the ${GOLD_PASS_FLOOR} floor`);
    else if (!o.current) out.push(`${m.id}: maturity 'mature' but the prompt text changed since its gold was measured (${o.measuredAtSha}) — re-run the gold`);
  }
  return out;
}
