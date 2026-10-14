/**
 * lib/lvc-judge-aa-core.ts — LVC applicability-judge A/A comparator (PURE).
 * DETERMINISM-TRIO PRD v1.0 §4 (D-4: MEASURE ONLY), 8 Aug 2026.
 *
 * WHAT AN A/A RUN IS. The same judge, the same model, the same configuration, asked the SAME
 * question twice. Any disagreement is the judge disagreeing with itself — there is no second
 * condition to attribute it to. `defaultJudge` (lib/lvc.ts:149) runs at temperature 0.1 with no
 * seed and no top_p, and it is the gate on every LVC finding: this file is the instrument that
 * measures how often that gate answers differently on identical input.
 *
 * PURE AND DEPENDENCY-FREE (type-only imports), so it loads under `node --experimental-strip-types`
 * and is unit-tested without a DB, an LLM or a network. It DECIDES NOTHING: no threshold lives here
 * — PRD §4.3 records the 95% decision rule as V's, to be made on the report this produces.
 *
 * PAIRING IS BY REC ID, NEVER BY POSITION. parseJudgeResponse builds its result from the model's
 * own array and back-fills the rest, so run B can return the same verdicts in a different order.
 * Comparing index-to-index would manufacture flips out of ordering noise. A rec present in one run
 * and absent from the other is counted as `unmatched` and never silently dropped.
 */

import type { JudgedRec, Verdict } from './lvc-core';

/** The three verdicts, in a fixed order so the flip matrix's keys are stable across runs. */
export const AA_VERDICTS: Verdict[] = ['applies', 'does_not_apply', 'insufficient_info'];

export interface AaRecComparison {
  recId: string;
  verdictA: Verdict;
  verdictB: Verdict;
  agree: boolean;
  confidenceA: number;
  confidenceB: number;
  /** signed B − A, so a reader can see drift direction as well as magnitude */
  confidenceDelta: number;
}

export interface AaCaseComparison {
  /** the sampled note uid this case came from */
  uid: string;
  /** recs judged in BOTH runs (the comparable set) */
  nRecs: number;
  /** rec ids present in one run only — never silently dropped */
  unmatched: string[];
  /** true iff every comparable rec's verdict matched (the §4.3 headline unit) */
  identicalVerdictSet: boolean;
  nAgree: number;
  nFlips: number;
  /** 'applies→does_not_apply' → count, over flips only (agreements are not in the matrix) */
  flipMatrix: Record<string, number>;
  meanAbsConfidenceDelta: number;
  perRec: AaRecComparison[];
}

export interface AaSummary {
  nCases: number;
  nRecs: number;
  /** % of CASES whose comparable verdict set was identical — 0 when nothing was compared */
  identicalVerdictSetPct: number;
  /** % of RECS whose verdict flipped */
  flipPct: number;
  meanAbsConfidenceDelta: number;
  /** flip matrix summed across every case */
  flipMatrix: Record<string, number>;
  /** cases whose comparable set was EMPTY — they cannot agree or disagree, and are excluded
   *  from identicalVerdictSetPct rather than counted as agreement (which would flatter the judge) */
  nEmptyCases: number;
  nUnmatchedRecs: number;
}

const flipKey = (a: Verdict, b: Verdict): string => `${a}→${b}`;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const pct = (num: number, den: number): number => (den > 0 ? round4((num / den) * 100) : 0);

/** One case: two JudgedRec[] for the SAME rec set, judged twice. */
export function compareJudgedRuns(uid: string, a: JudgedRec[], b: JudgedRec[]): AaCaseComparison {
  const byId = (rs: JudgedRec[]): Map<string, JudgedRec> => {
    const m = new Map<string, JudgedRec>();
    // first occurrence wins — a duplicated id is a parse artefact, not two judgements
    for (const r of rs || []) { const id = String(r?.rec?.id ?? ''); if (id && !m.has(id)) m.set(id, r); }
    return m;
  };
  const A = byId(a), B = byId(b);
  const shared = [...A.keys()].filter((id) => B.has(id)).sort();
  const unmatched = [...new Set([...A.keys()].filter((id) => !B.has(id)).concat([...B.keys()].filter((id) => !A.has(id))))].sort();

  const perRec: AaRecComparison[] = shared.map((id) => {
    const ra = A.get(id) as JudgedRec, rb = B.get(id) as JudgedRec;
    const ca = Number(ra.confidence) || 0, cb = Number(rb.confidence) || 0;
    return {
      recId: id, verdictA: ra.verdict, verdictB: rb.verdict, agree: ra.verdict === rb.verdict,
      confidenceA: ca, confidenceB: cb, confidenceDelta: round4(cb - ca),
    };
  });

  const flips = perRec.filter((r) => !r.agree);
  const flipMatrix: Record<string, number> = {};
  for (const f of flips) { const k = flipKey(f.verdictA, f.verdictB); flipMatrix[k] = (flipMatrix[k] ?? 0) + 1; }
  const meanAbs = perRec.length
    ? round4(perRec.reduce((s, r) => s + Math.abs(r.confidenceDelta), 0) / perRec.length)
    : 0;

  return {
    uid,
    nRecs: perRec.length,
    unmatched,
    // An EMPTY comparable set is not agreement. It is nothing measured, and the summary counts it
    // as such (nEmptyCases) instead of letting it inflate the headline.
    identicalVerdictSet: perRec.length > 0 && flips.length === 0,
    nAgree: perRec.length - flips.length,
    nFlips: flips.length,
    flipMatrix,
    meanAbsConfidenceDelta: meanAbs,
    perRec,
  };
}

/** The run-level summary (§4.2). `identicalVerdictSetPct` is over cases that actually compared. */
export function summarizeAa(cases: AaCaseComparison[]): AaSummary {
  const list = cases || [];
  const compared = list.filter((c) => c.nRecs > 0);
  const nRecs = compared.reduce((s, c) => s + c.nRecs, 0);
  const nFlips = compared.reduce((s, c) => s + c.nFlips, 0);
  const flipMatrix: Record<string, number> = {};
  for (const c of compared) for (const [k, v] of Object.entries(c.flipMatrix)) flipMatrix[k] = (flipMatrix[k] ?? 0) + v;
  const sumAbs = compared.reduce((s, c) => s + c.meanAbsConfidenceDelta * c.nRecs, 0);
  return {
    nCases: list.length,
    nRecs,
    identicalVerdictSetPct: pct(compared.filter((c) => c.identicalVerdictSet).length, compared.length),
    flipPct: pct(nFlips, nRecs),
    meanAbsConfidenceDelta: nRecs ? round4(sumAbs / nRecs) : 0,
    flipMatrix,
    nEmptyCases: list.length - compared.length,
    nUnmatchedRecs: list.reduce((s, c) => s + c.unmatched.length, 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit C — re-run support (LVC JUDGE PINNING PRD v1.0 §4, 10 Aug 2026)
// ─────────────────────────────────────────────────────────────────────────────

/** The tag the r1 baseline was stored under. Unchanged, and still the default. */
export const AA_EXPERIMENT_DEFAULT = 'lvc_judge_aa_r1';

/**
 * The ONLY shape a re-run tag may take (PRD §4). Deliberately narrow: the tag keys the resume
 * skip-set (`doneUids`) AND the lab_analyses rows the report is read off, so a typo would silently
 * start a fresh, empty round rather than resume — and two rounds sharing a tag would be
 * indistinguishable in the analysis. `r0`–`r99`, nothing else.
 */
export const AA_EXPERIMENT_RE = /^lvc_judge_aa_r[0-9]{1,2}$/;

/**
 * Resolve the `experiment` query parameter. ANYTHING that does not match falls back to r1 —
 * including empty, absent and junk — so the route can never write rows under a tag nobody will
 * look for. Whitespace is trimmed; nothing else is coerced (no lower-casing: a tag that differs
 * only in case is a different tag to the DB, and quietly folding it would be the same defect the
 * regex exists to prevent).
 */
export function resolveAaExperiment(raw: string | null | undefined): string {
  const v = String(raw ?? '').trim();
  return AA_EXPERIMENT_RE.test(v) ? v : AA_EXPERIMENT_DEFAULT;
}
