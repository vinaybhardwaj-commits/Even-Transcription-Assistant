// lib/clinical-state/extraction-eval-core.ts — Platform B2: the free-text → ClinicalState
// EXTRACTION-QUALITY referee. PURE: no ./db, no ./llm, no I/O, no network — the LLM-judge
// call is INJECTED (same pattern as extract.ts's ChatFn) so this module stays unit-testable
// with a fake and never drifts the engine. MEASUREMENT ONLY: consumes ClinicalState + the
// case bank; changes no extractor, prompt, route, or retrieval.
//
// It answers "how good is the extraction?" along three trust tiers, kept strictly separate:
//   1. GUARDS (H2) — deterministic, external-truth-free, ALWAYS trusted: every finding's
//      rawText must be a verbatim substring of its named source field (no-fabrication),
//      status must be a valid enum, offsets (when present) must point at rawText.
//   2. JUDGE (H3) — an LLM grades recall/status/no-fab/provenance. PROVISIONAL: never
//      trusted until calibrated against the gold seed (H4). `calibrated:false` says so.
//   3. GOLD (H4) — the hand-labelled, clinician-signed trust anchor. Calibrates BOTH the
//      extractor and the judge; runs once data/ddx-eval/ddx-extraction-gold-seed-v1.json lands.

import type { ClinicalState, ClinicalFinding, FindingStatus } from './schema';
import { FROZEN_BANK } from '../ddx-eval-core';

export const EXTRACTION_EVAL_VERSION = 'clinical-state-extraction-eval/2' as const;
/** The bank these stems come from — pinned to the same frozen bank the DDx referee uses. */
export const EXTRACTION_BANK = FROZEN_BANK; // 'ddx-case-bank/1.0'

export type ExtractionPath = 'deterministic' | 'llm';
export type SourceFields = Record<string, string | undefined>;

/** The checklist sentinel a deterministic 'unknown' carries — NOT a fabrication. */
export const CHECKLIST_SENTINEL = '(not mentioned)';
const VALID_STATUSES: ReadonlySet<string> = new Set<FindingStatus>([
  'present', 'absent', 'unknown', 'historical', 'resolved',
]);
/** Findings that ASSERT something about the patient (subject to the verbatim/no-fab guard). */
const ASSERTED: ReadonlySet<string> = new Set<FindingStatus>(['present', 'absent', 'historical', 'resolved']);

function normConcept(s: string): string {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Canonical vital-sign key for a concept, or null if it is not a PURE quantitative vital.
 *  eval/2: folds the abbreviation-vs-name + value + BP-split granularity mismatch between the
 *  extractor (canonical names, BP split into systolic/diastolic — "heart rate", "systolic bp")
 *  and the gold labels (abbreviation+value, BP combined — "HR 98", "BP 150/92") to one key, so
 *  the recall matcher compares vitals like-for-like. Deliberately CONSERVATIVE: only a concept
 *  that reduces to a bare vital name after stripping the numeric value + units maps — a concept
 *  carrying a qualitative descriptor ("HR 128 irregular", "irregularly irregular pulse",
 *  "mild tachycardia (HR 108)") is NOT folded and is left to substring matching, unchanged. */
const VITAL_KEYS: ReadonlyArray<readonly [string, ReadonlySet<string>]> = [
  ['heart rate', new Set(['hr', 'heart rate', 'pulse', 'pulse rate'])],
  ['blood pressure', new Set(['bp', 'blood pressure', 'systolic bp', 'diastolic bp', 'systolic blood pressure', 'diastolic blood pressure', 'systolic', 'diastolic'])],
  ['oxygen saturation', new Set(['spo2', 'sao2', 'o2 sat', 'o2 saturation', 'oxygen saturation', 'sats', 'saturation'])],
  ['respiratory rate', new Set(['rr', 'resp rate', 'respiratory rate', 'respiration rate'])],
  ['temperature', new Set(['temp', 'temperature'])],
];
function canonicalVital(concept: string): string | null {
  const stripped = normConcept(concept)
    .replace(/\b\d+(\.\d+)?\b/g, ' ')                                        // drop values: "hr 98" → "hr"
    .replace(/\b(mmhg|bpm|kpa|c|f|celsius|fahrenheit|percent|pct)\b/g, ' ')  // drop units
    .replace(/\s+/g, ' ').trim();
  if (!stripped) return null;
  for (const [key, names] of VITAL_KEYS) if (names.has(stripped)) return key;
  return null;
}

/** Two normalized concepts "match" when either is a token-safe substring of the other
 *  (mirrors the DDx matcher's any-of substring rule; deliberately lenient for recall). */
function conceptsMatch(a: string, b: string): boolean {
  const x = normConcept(a); const y = normConcept(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Vitals granularity fold (eval/2, ADDITIVE — only ever ADDS a match, never removes one):
  // "HR 98" ↔ "heart rate", "BP 150/92" ↔ "systolic bp"/"diastolic bp". Compared like-for-like.
  const va = canonicalVital(a);
  if (va && va === canonicalVital(b)) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // word-boundary guard so 'ces' does not hit 'abscess' (the D11 lesson).
  return new RegExp(`(?:^|\\s)${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(long);
}

// ── H2 · Round-trip + provenance guards (deterministic, always-on) ──────────────

export interface FindingGuard {
  id: string;
  concept: string;
  status: FindingStatus;
  sourceField: string;
  extractionMethod: string;
  rawText: string;
  asserted: boolean;        // positives/negatives/historical/resolved (vs. checklist unknown)
  sentinel: boolean;        // rawText === CHECKLIST_SENTINEL — an unknown, exempt from verbatim
  verbatim: boolean;        // rawText occurs in the named source field (asserted findings only)
  statusValid: boolean;
  offsetValid: boolean | null; // start/endOffset (when present) delimit rawText in the field; null when absent
  sourceFieldMissing: boolean; // sourceField not among the provided fields (e.g. 'investigations')
}

export interface CaseGuardResult {
  caseId: string;
  path: ExtractionPath;
  nFindings: number;
  nAsserted: number;
  nUnknowns: number;
  nVerbatim: number;            // asserted findings whose rawText is verbatim in source
  fabricated: FindingGuard[];   // asserted findings whose rawText is NOT verbatim — the no-fab violations
  nStatusInvalid: number;
  nOffsetInvalid: number;
  rejectedSpans: number;        // spans the LLM pass proposed but the extractor rejected (fed in)
  noFabRate: number;            // nVerbatim / nAsserted (1.0 when nAsserted === 0)
  provenanceValidRate: number;  // (nAsserted − nOffsetInvalid) / nAsserted among findings carrying offsets
}

function guardOneFinding(f: ClinicalFinding, fields: SourceFields): FindingGuard {
  const sourceField = f.provenance.sourceField;
  const rawText = f.provenance.rawText ?? '';
  const sentinel = rawText === CHECKLIST_SENTINEL;
  const asserted = ASSERTED.has(f.status) && !sentinel;
  const fieldText = fields[sourceField];
  const sourceFieldMissing = fieldText == null;
  // Verbatim: asserted rawText must appear in its named field. Fall back to the union of
  // all fields when the sourceField is not a provided input (e.g. composed investigation rows).
  const haystack = fieldText ?? Object.values(fields).filter(Boolean).join('\n');
  const verbatim = sentinel ? true : haystack.includes(rawText);
  const startOk = f.provenance.startOffset != null && f.provenance.endOffset != null;
  const offsetValid = !startOk ? null
    : (fieldText != null && fieldText.slice(f.provenance.startOffset!, f.provenance.endOffset!) === rawText);
  return {
    id: f.id, concept: f.concept, status: f.status, sourceField,
    extractionMethod: f.provenance.extractionMethod, rawText,
    asserted, sentinel, verbatim,
    statusValid: VALID_STATUSES.has(f.status),
    offsetValid, sourceFieldMissing,
  };
}

/** H2 — run the deterministic guards over one extracted state. */
export function runGuards(
  caseId: string, path: ExtractionPath, fields: SourceFields, state: ClinicalState, rejectedSpans = 0,
): CaseGuardResult {
  const all = [...state.positives, ...state.negatives, ...state.unknowns].map((f) => guardOneFinding(f, fields));
  const asserted = all.filter((g) => g.asserted);
  const unknowns = all.filter((g) => !g.asserted);
  const verbatim = asserted.filter((g) => g.verbatim);
  const fabricated = asserted.filter((g) => !g.verbatim);
  const statusInvalid = all.filter((g) => !g.statusValid);
  const withOffsets = asserted.filter((g) => g.offsetValid !== null);
  const offsetInvalid = withOffsets.filter((g) => g.offsetValid === false);
  return {
    caseId, path,
    nFindings: all.length,
    nAsserted: asserted.length,
    nUnknowns: unknowns.length,
    nVerbatim: verbatim.length,
    fabricated,
    nStatusInvalid: statusInvalid.length,
    nOffsetInvalid: offsetInvalid.length,
    rejectedSpans,
    noFabRate: asserted.length ? verbatim.length / asserted.length : 1,
    provenanceValidRate: withOffsets.length ? (withOffsets.length - offsetInvalid.length) / withOffsets.length : 1,
  };
}

// ── H3 · LLM-judge — pure prompt builders + parser (the call is injected) ────────

export const JUDGE_SYSTEM = `You are a meticulous clinical-informatics referee. You are given (A) a clinical presentation as named fields and (B) a machine-extracted ClinicalState (a list of findings, each present/absent/unknown with the source substring it rests on).

Grade the extraction on FOUR dimensions, each a 0.0–1.0 score:
1. "recall": did it capture the findings, stated negatives, and expected not-mentioned items the presentation actually contains? Missing a clearly-stated finding lowers this.
2. "statusAccuracy": are present/absent/unknown correct? A stated negative marked present, or an asserted finding marked absent, lowers this.
3. "noFabrication": did it AVOID inventing findings not supported by the text? Any finding not grounded in the presentation lowers this. (unknown/not-mentioned checklist items are NOT fabrications.)
4. "provenanceAccuracy": does each finding's source substring actually support the stated concept and status?

Also return, per finding you were given, a verdict, and list clearly-stated findings the extraction MISSED.

Return ONLY JSON:
{"dimensions":{"recall":0.0,"statusAccuracy":0.0,"noFabrication":0.0,"provenanceAccuracy":0.0},
 "findings":[{"concept":"…","status":"present|absent|unknown","verdict":"ok|wrong-status|fabricated|imprecise-span","note":"…"}],
 "missed":["<clearly-stated finding the extraction failed to capture>"]}`;

/** Compact, judge-facing view of a state (concept/status/rawText only — no ids/offsets). */
export function judgeStateView(state: ClinicalState): Array<{ concept: string; status: string; rawText: string; field: string }> {
  return [...state.positives, ...state.negatives, ...state.unknowns].map((f) => ({
    concept: f.concept, status: f.status, rawText: f.provenance.rawText, field: f.provenance.sourceField,
  }));
}

export function buildJudgeUser(fields: SourceFields, state: ClinicalState): string {
  const pres = Object.entries(fields).filter(([, v]) => v && v.trim()).map(([k, v]) => `${k}: ${v}`).join('\n');
  const findings = JSON.stringify(judgeStateView(state));
  return `PRESENTATION:\n${pres}\n\nEXTRACTED FINDINGS:\n${findings}`;
}

export interface JudgeDimensionScores {
  recall: number; statusAccuracy: number; noFabrication: number; provenanceAccuracy: number;
}
export type FindingVerdict = 'ok' | 'wrong-status' | 'fabricated' | 'imprecise-span';
export interface JudgeFindingVerdict { concept: string; status: string; verdict: FindingVerdict; note?: string }
export interface JudgeResult {
  dimensions: JudgeDimensionScores;
  findings: JudgeFindingVerdict[];
  missed: string[];
}

function parseLooseJson(s: string): unknown {
  let t = (s || '').trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}
const clamp01 = (x: unknown): number => {
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
};
const VERDICTS: ReadonlySet<string> = new Set<FindingVerdict>(['ok', 'wrong-status', 'fabricated', 'imprecise-span']);

/** Parse a judge response defensively — clamp scores to [0,1], drop malformed rows. Throws
 *  only when the payload has no recoverable dimensions object (the caller decides fail policy). */
export function parseJudgeResponse(raw: string): JudgeResult {
  const o = parseLooseJson(raw) as Record<string, unknown>;
  const d = (o.dimensions ?? {}) as Record<string, unknown>;
  const findings: JudgeFindingVerdict[] = Array.isArray(o.findings)
    ? (o.findings as Record<string, unknown>[]).filter((f) => f && typeof f === 'object').map((f) => ({
        concept: String(f.concept ?? ''),
        status: String(f.status ?? ''),
        verdict: (VERDICTS.has(String(f.verdict)) ? String(f.verdict) : 'ok') as FindingVerdict,
        note: typeof f.note === 'string' ? f.note : undefined,
      }))
    : [];
  const missed = Array.isArray(o.missed) ? (o.missed as unknown[]).map((m) => String(m)).filter(Boolean) : [];
  return {
    dimensions: {
      recall: clamp01(d.recall), statusAccuracy: clamp01(d.statusAccuracy),
      noFabrication: clamp01(d.noFabrication), provenanceAccuracy: clamp01(d.provenanceAccuracy),
    },
    findings, missed,
  };
}

// ── H5 · Scorecard aggregation (per path + head-to-head + promotion proposal) ────

export interface PathScorecard {
  path: ExtractionPath;
  n: number;
  guard: {
    noFabRate: number;           // mean over cases (trusted)
    provenanceValidRate: number; // mean over cases with offsets (trusted)
    statusValidRate: number;     // 1 − (invalid statuses / total findings)
    meanRejectedSpans: number;
    totalFabricated: number;
    casesWithFabrication: number;
  };
  judge: (JudgeDimensionScores & { calibrated: boolean }) | null;
  meanFindings: number;
  meanAsserted: number;
  meanUnknowns: number;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function summarizePath(
  path: ExtractionPath, guards: CaseGuardResult[], judges?: JudgeResult[],
): PathScorecard {
  const totalFindings = guards.reduce((a, g) => a + g.nFindings, 0);
  const totalStatusInvalid = guards.reduce((a, g) => a + g.nStatusInvalid, 0);
  return {
    path, n: guards.length,
    guard: {
      noFabRate: mean(guards.map((g) => g.noFabRate)),
      provenanceValidRate: mean(guards.map((g) => g.provenanceValidRate)),
      statusValidRate: totalFindings ? (totalFindings - totalStatusInvalid) / totalFindings : 1,
      meanRejectedSpans: mean(guards.map((g) => g.rejectedSpans)),
      totalFabricated: guards.reduce((a, g) => a + g.fabricated.length, 0),
      casesWithFabrication: guards.filter((g) => g.fabricated.length > 0).length,
    },
    judge: judges && judges.length ? {
      recall: mean(judges.map((j) => j.dimensions.recall)),
      statusAccuracy: mean(judges.map((j) => j.dimensions.statusAccuracy)),
      noFabrication: mean(judges.map((j) => j.dimensions.noFabrication)),
      provenanceAccuracy: mean(judges.map((j) => j.dimensions.provenanceAccuracy)),
      calibrated: false, // NEVER trusted until H4 flips this via the gold seed
    } : null,
    meanFindings: mean(guards.map((g) => g.nFindings)),
    meanAsserted: mean(guards.map((g) => g.nAsserted)),
    meanUnknowns: mean(guards.map((g) => g.nUnknowns)),
  };
}

export interface HeadToHead {
  deltaJudgeRecall: number | null;
  deltaJudgeStatusAccuracy: number | null;
  deltaJudgeNoFabrication: number | null;
  deltaJudgeProvenance: number | null;
  deltaGuardNoFabRate: number;
  deltaMeanAsserted: number;   // does the LLM path surface MORE grounded findings?
  deltaMeanUnknowns: number;   // ...at the cost of fewer not-mentioned?
}

export function headToHead(det: PathScorecard, llm: PathScorecard): HeadToHead {
  const jd = (k: keyof JudgeDimensionScores): number | null =>
    det.judge && llm.judge ? llm.judge[k] - det.judge[k] : null;
  return {
    deltaJudgeRecall: jd('recall'),
    deltaJudgeStatusAccuracy: jd('statusAccuracy'),
    deltaJudgeNoFabrication: jd('noFabrication'),
    deltaJudgeProvenance: jd('provenanceAccuracy'),
    deltaGuardNoFabRate: llm.guard.noFabRate - det.guard.noFabRate,
    deltaMeanAsserted: llm.meanAsserted - det.meanAsserted,
    deltaMeanUnknowns: llm.meanUnknowns - det.meanUnknowns,
  };
}

export interface PromotionProposal {
  armed: false;                 // ALWAYS false — B2 proposes, it does not enforce (D4)
  gateMetric: 'judge.recall';
  detBaseline: number | null;
  llmBaseline: number | null;
  noiseMargin: number;
  proposedFloor: number | null;
  rationale: string;
}

/** Propose (never enforce) an LLM-promotion floor: promote the LLM path only if its
 *  judge recall clears the deterministic baseline by more than run-to-run noise. */
export function proposePromotionThreshold(det: PathScorecard, llm: PathScorecard, noiseMargin = 0.03): PromotionProposal {
  const detR = det.judge ? det.judge.recall : null;
  const llmR = llm.judge ? llm.judge.recall : null;
  const proposedFloor = detR != null ? Math.round((detR + noiseMargin) * 100) / 100 : null;
  const rationale = detR == null || llmR == null
    ? 'Judge dimensions absent — run H3 to populate; threshold uncomputable until then. Uncalibrated regardless until the gold seed lands (H4).'
    : `Promote LLM path only when judge recall ≥ det baseline (${detR.toFixed(2)}) + noise margin (${noiseMargin.toFixed(2)}) = ${proposedFloor}. Current LLM recall ${llmR.toFixed(2)} ⇒ ${llmR >= (proposedFloor ?? 1) ? 'would clear' : 'would NOT clear'}. NOT ENFORCED (D4); numbers are judge-provisional until calibrated (H4).`;
  return { armed: false, gateMetric: 'judge.recall', detBaseline: detR, llmBaseline: llmR, noiseMargin, proposedFloor, rationale };
}

// ── H4 · Calibration vs the gold seed (the trust anchor) ─────────────────────────

export interface GoldFinding { concept: string; status: FindingStatus; sourceField?: string; rawText?: string }
export interface GoldCase { caseId: string; findings: GoldFinding[]; notes?: string }
export interface GoldSeed { version: string; signedBy?: string; cases: GoldCase[] }

/** Adapt the delivered gold seed (ddx-extraction-gold-seed/1.0: present/absent/unknown lanes
 *  + a riskFactors/exposures/medications/investigations rubric) into the internal GoldSeed.
 *  Only the clinical-finding lanes (present/absent/unknown) feed finding-recall — the extractor
 *  does not target the riskFactor/exposure/medication/investigation lanes as findings in this
 *  build, so scoring recall against them would penalise an out-of-scope gap (documented). */
export function adaptGoldSeed(rawSeed: unknown): GoldSeed {
  const raw = (rawSeed ?? {}) as { meta?: { id?: string; labelled_by?: string }; cases?: unknown[] };
  const conceptOf = (x: unknown): string =>
    typeof x === 'string' ? x : String((x as { concept?: unknown })?.concept ?? '');
  const provOf = (x: unknown): string | undefined =>
    typeof x === 'object' && x ? (x as { provenance?: string }).provenance : undefined;
  const cases: GoldCase[] = (raw.cases ?? []).map((cRaw) => {
    const c = cRaw as { id: string; present?: unknown[]; absent?: unknown[]; unknown?: unknown[]; notes?: string };
    const findings: GoldFinding[] = [];
    for (const p of c.present ?? []) findings.push({ concept: conceptOf(p), status: 'present', sourceField: provOf(p) });
    for (const a of c.absent ?? []) findings.push({ concept: conceptOf(a), status: 'absent', sourceField: provOf(a) });
    for (const u of c.unknown ?? []) findings.push({ concept: conceptOf(u), status: 'unknown' });
    return { caseId: c.id, findings: findings.filter((f) => f.concept), notes: c.notes };
  });
  return { version: raw.meta?.id ?? 'gold', signedBy: raw.meta?.labelled_by, cases };
}

export interface ExtractorVsGold {
  path: ExtractionPath;
  recall: number;          // gold findings matched by an extracted finding of the right status
  statusAccuracy: number;  // among matched concepts, fraction with the correct status
  noFabRate: number;       // extracted asserted findings that a gold finding supports
  nGold: number;
  nMatched: number;
}

/** Compare one extractor's output against the gold labels for the seed cases. */
export function scoreExtractorVsGold(
  path: ExtractionPath, states: Map<string, ClinicalState>, gold: GoldSeed,
): ExtractorVsGold {
  let goldTotal = 0, matched = 0, statusOk = 0, assertedTotal = 0, assertedSupported = 0;
  for (const gc of gold.cases) {
    const st = states.get(gc.caseId);
    if (!st) continue;
    const extracted = [...st.positives, ...st.negatives, ...st.unknowns];
    for (const gf of gc.findings) {
      goldTotal++;
      const hit = extracted.find((e) => conceptsMatch(e.concept, gf.concept));
      if (hit) { matched++; if (hit.status === gf.status) statusOk++; }
    }
    for (const e of extracted) {
      if (!ASSERTED.has(e.status) || e.provenance.rawText === CHECKLIST_SENTINEL) continue;
      assertedTotal++;
      if (gc.findings.some((gf) => conceptsMatch(e.concept, gf.concept))) assertedSupported++;
    }
  }
  return {
    path,
    recall: goldTotal ? matched / goldTotal : 0,
    statusAccuracy: matched ? statusOk / matched : 0,
    noFabRate: assertedTotal ? assertedSupported / assertedTotal : 1,
    nGold: goldTotal, nMatched: matched,
  };
}

export interface JudgeVsGold {
  nSeedCases: number;
  dimensionMae: JudgeDimensionScores;   // mean |judge − goldDerived| per dimension (lower = better)
  overallMae: number;
  agreement: number;                    // 1 − overallMae, as a friendly "agreement" figure
  verdict: 'trustworthy' | 'retune-judge';
  threshold: number;                    // agreement floor to call the judge trustworthy
}

/** H4 — calibrate the JUDGE against gold-derived truth on the seed cases. The gold-derived
 *  truth per dimension comes from `scoreExtractorVsGold` (recall/status/no-fab) plus a
 *  provenance proxy; the judge is trustworthy when its mean absolute error is small. */
export function calibrateJudge(
  seedJudgeByCase: Map<string, JudgeResult>, goldTruthByCase: Map<string, JudgeDimensionScores>, threshold = 0.85,
): JudgeVsGold {
  const dims: (keyof JudgeDimensionScores)[] = ['recall', 'statusAccuracy', 'noFabrication', 'provenanceAccuracy'];
  const errs: Record<keyof JudgeDimensionScores, number[]> = { recall: [], statusAccuracy: [], noFabrication: [], provenanceAccuracy: [] };
  let nCases = 0;
  for (const [caseId, truth] of goldTruthByCase) {
    const j = seedJudgeByCase.get(caseId);
    if (!j) continue;
    nCases++;
    for (const d of dims) errs[d].push(Math.abs(j.dimensions[d] - truth[d]));
  }
  const dimensionMae = {
    recall: mean(errs.recall), statusAccuracy: mean(errs.statusAccuracy),
    noFabrication: mean(errs.noFabrication), provenanceAccuracy: mean(errs.provenanceAccuracy),
  };
  const overallMae = mean(dims.map((d) => dimensionMae[d]));
  const agreement = 1 - overallMae;
  return {
    nSeedCases: nCases, dimensionMae, overallMae, agreement,
    verdict: agreement >= threshold ? 'trustworthy' : 'retune-judge',
    threshold,
  };
}

// ── Top-level scorecard shape (what the runner persists) ─────────────────────────

export interface ExtractionScorecard {
  version: typeof EXTRACTION_EVAL_VERSION;
  bank: string;
  generated: string | null;         // stamped by the runner (Date not available in some sandboxes)
  judgeModel: string | null;
  n: number;
  paths: { deterministic: PathScorecard; llm: PathScorecard };
  headToHead: HeadToHead;
  contradictionPreservation: 'N/A — corpus contains no contradiction cases';
  promotion: PromotionProposal;
  calibration: {
    status: 'pending-gold-seed' | 'complete';
    goldSeedPath: string;
    extractorVsGold?: ExtractorVsGold[];
    judgeVsGold?: JudgeVsGold;
  };
  notes: string[];
}
