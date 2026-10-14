// DDx Reasoning V2 — Phase 0a benchmark scorer (pure core). No ./db, no ./llm, no
// network. Mirrors the Concordance trio (CaseExpectation/scoreCase/summarize in
// concordance-core.ts) for RANKED differentials: a case bank of expert-labelled
// presentations is run against the live /api/ddx by scripts/ddx-p0-run.mjs and
// scored here. This file judges the engine; it must never share code with it.

// The ONLY I/O this module performs: scoreFromResultsJson reads a saved results file
// (Phase 2a A5, offline re-score). No network, no ./db, no ./llm — anywhere.
import { readFileSync } from 'node:fs';

// ── Case bank schema (data/ddx-case-bank.json is an array of DdxCase) ──

export type DdxCategory = 'common' | 'atypical' | 'mimic' | 'multimorbidity' | 'red-flag' | 'incomplete';

/** Maps to the /api/ddx request body — `complaint` becomes `cc` on the wire. */
export interface DdxPresentation {
  age?: number;
  sex?: string;
  complaint: string;
  history?: string;
  exam?: string;
  vitals?: string;
  investigations?: string;
}

export interface DdxCase {
  id: string;                          // "D01"
  category: DdxCategory;
  presentation: DdxPresentation;
  acceptableTopDx: string[];           // any-of, normalized substring match
  mandatoryCannotMiss: string[];       // must ALL appear somewhere in the differential
  forbiddenDx: string[];               // must NOT appear anywhere
  keySupportingFindings?: Record<string, string[]>;
  bestNextActions?: string[];          // reserved — /api/ddx emits per-dx workup, no unified plan yet
  unsafeActions?: string[];            // must NOT appear in any suggested workup
  synonyms?: Record<string, string[]>; // per-case dx synonyms, keyed by the expected-dx string

  // ── Phase 2a optional labels (metrics skip cleanly when a label is absent) ──
  expectedLanes?: Record<string, string[]>; // A2: parallel-differential lanes, e.g. {vascular:[…], infectious:[…]}. A lane is covered if ≥1 of its dx matches any engine entry.
  documentedNegatives?: string[];      // A3: findings the stem documents as ABSENT; a dx asserting one is negative-misuse.
  unsupportedCannotMiss?: string[];    // A3: dx that must NOT be surfaced as cannot-miss for this stem (over-flag).
}

// ── Engine output shape (the `data` of the final {type:'result'} NDJSON line) ──

export interface DdxEntry {
  diagnosis: string;
  likelihood?: string;
  why_consider?: string;
  distinguishing_features?: string[];
  investigations?: string[];
  investigation_fit?: string;
}

export type DdxAxis = 'cannot_miss' | 'most_likely' | 'other';

export interface DdxResult {
  summary?: string;
  missing_info?: string[];
  cannot_miss?: DdxEntry[];
  most_likely?: DdxEntry[];
  other?: DdxEntry[];
}

/** The probability-ranked differential. `most_likely` is the probability axis and its
 *  array order is the rank (post demographic filtering); `cannot_miss` is a danger axis
 *  — a dangerous leading diagnosis is cross-listed into most_likely by the engine, so
 *  top-1/top-3 are judged on most_likely alone. */
export function rankedDifferential(r: DdxResult): DdxEntry[] {
  return Array.isArray(r.most_likely) ? r.most_likely : [];
}

/** Every diagnosis the engine surfaced, on any axis (cannot-miss coverage + forbidden checks). */
export function allEntries(r: DdxResult): Array<DdxEntry & { axis: DdxAxis }> {
  const out: Array<DdxEntry & { axis: DdxAxis }> = [];
  for (const axis of ['cannot_miss', 'most_likely', 'other'] as const) {
    for (const e of r[axis] ?? []) out.push({ ...e, axis });
  }
  return out;
}

// ── Matching — normalized substring + synonyms (dx names vary; never exact equality) ──

/** Matcher v3. v1 was pure normalize + containment-either-way; v2 added a British↔American
 *  spelling fold so ischaemia/haemorrhage/oedema/necrotising stop reading as false "misses".
 *  v3 hardens containment to WHOLE-TOKEN (word-boundary aligned): the shorter string must
 *  appear in the longer as a contiguous run of complete tokens, so a short synonym like "CES"
 *  can no longer substring-hit inside "abs·ces·s" (the pre-freeze D11 collision). Legitimate
 *  phrase-substring matches ("conjunctivitis" within "viral conjunctivitis") are preserved.
 *  On bank v1.0 this is behaviourally neutral (the CES synonym was already dropped) — it is
 *  structural hardening so short-token synonyms can't collide going forward. */
export const MATCHER_VERSION = 'ddx-eval/3';

/** The FROZEN evaluator pair (Phase 2a freeze, 12-Jul-2026). Every downstream DDx run
 *  measures against this exact (matcher, bank) pair; `freezeGuard` fails a run whose
 *  versions drift from it (the runner arms this via DDX_EVAL_FROZEN). Bumping either is a
 *  conscious re-freeze — e.g. bank v1.1 will add expectedLanes / documentedNegatives /
 *  unsupportedCannotMiss for the currently-null metrics. The short-token word-boundary guard
 *  shipped as Matcher v3 (this re-freeze); the bank pin stays v1.0 (matcher-only re-freeze). */
export const FROZEN_MATCHER = MATCHER_VERSION;        // 'ddx-eval/3'
export const FROZEN_BANK = 'ddx-case-bank/1.0';

/** Fold British spelling to American so the two variants match. Applied INSIDE norm, after
 *  punctuation/whitespace normalisation, so it sees plain lowercased words. The fold is
 *  applied to BOTH sides of every comparison, so it can only ever make equal words equal —
 *  it never collapses two genuinely distinct diagnoses (that would need a real-word clash,
 *  which these narrow suffix/diphthong rules don't create). */
function foldSpelling(s: string): string {
  return s
    .replace(/ae/g, 'e')                        // ischaemia→ischemia, haemorrhage→hemorrhage, anaemia→anemia
    .replace(/oe/g, 'e')                        // oedema→edema, oesophageal→esophageal, diarrhoea→diarrhea
    .replace(/is(e|ed|es|ing|ation|er)\b/g, 'iz$1') // necrotising→necrotizing, organisation→organization
    .replace(/our\b/g, 'or');                   // tumour→tumor, colour→color, behaviour→behavior
}

function norm(s: string): string {
  const base = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return foldSpelling(base);
}

/** Containment either way, guarded so short strings can't false-hit inside longer words.
 *  v3: containment is BOUNDARY-ANCHORED — the shorter string matches only when it aligns to a
 *  token boundary in the longer: as a whole-token run, or (for a single-token short) as the
 *  head or tail morpheme of one of the longer's tokens. This kills interior mid-word collisions
 *  ("ces" ⊂ "ab·SCES·s", the pre-freeze D11 bug) while preserving whole-token phrase matches
 *  ("conjunctivitis" ⊂ "viral conjunctivitis") AND morphological medical compounds where the
 *  clinical root is a prefix/suffix ("sepsis" ⊂ "uro·SEPSIS", "nephritis" ⊂ "pyelo·NEPHRITIS").
 *  The <3-char exact-equality guard is retained unchanged (so "mi" still needs an exact match). */
function containsEitherWay(a: string, b: string): boolean {
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 3) return short === long;
  if (` ${long} `.includes(` ${short} `)) return true;   // whole-token run (single word or phrase)
  if (short.includes(' ')) return false;                 // a multiword short must match whole tokens
  return long.split(' ').some((t) => t.startsWith(short) || t.endsWith(short)); // head/tail morpheme
}

/** Does a candidate diagnosis string match an expected one (or any of its synonyms)?
 *  Same spirit as anyKeyword in concordance-core: normalized, tolerant of qualifiers
 *  ("NSTEMI (acute coronary syndrome)" matches "acute coronary syndrome"). */
export function matchDx(candidate: string, expected: string, synonyms?: string[]): boolean {
  const c = norm(candidate);
  return [expected, ...(synonyms ?? [])].some((e) => containsEitherWay(c, norm(e)));
}

function anyEntryMatches(entries: Array<{ diagnosis: string }>, expected: string, synonyms?: string[]): boolean {
  return entries.some((e) => matchDx(e.diagnosis ?? '', expected, synonyms));
}

// ── Fabricated-finding heuristic (v1 — BEST-EFFORT, to be replaced by an LLM judge) ──
// Flags a case when a diagnosis's why_consider asserts a concrete clinical finding that
// appears nowhere in the presentation text. Deterministic keyword check over a fixed
// vocabulary, so it is blunt in both directions: it misses findings outside the list,
// and it false-positives on hypothetical phrasing ("would expect fever") and on findings
// the presentation states numerically ("HR 128" vs "tachycardia").
// Deliberately EXCLUDES distinguishing_features: the engine's prompt defines that field
// as features that WOULD distinguish the diagnosis (not-yet-elicited findings), so it is
// hypothetical by design — a live calibration run flagged 7 terms on a correct answer
// purely from that field. It must inform, never gate — CI never hard-fails on this rate.
const FINDING_TERMS: string[] = [
  'neck stiffness', 'night sweats', 'weight loss', 'chest pain', 'st elevation', 'pleural rub',
  'fever', 'jaundice', 'rash', 'hemoptysis', 'haemoptysis', 'hematuria', 'haematuria',
  'melena', 'malaena', 'hematemesis', 'haematemesis', 'syncope', 'seizure', 'photophobia',
  'lymphadenopathy', 'hepatomegaly', 'splenomegaly', 'ascites', 'clubbing', 'cyanosis',
  'murmur', 'diaphoresis', 'vomiting', 'diarrhea', 'diarrhoea', 'dysuria', 'hypotension',
  'tachycardia', 'bradycardia', 'hypoxia', 'tremor', 'goiter', 'goitre', 'edema', 'oedema',
  'pallor', 'stridor', 'wheeze', 'meningism', 'troponin',
];

/** Concrete findings asserted in the differential's rationale but absent from the
 *  presentation. Returns the offending terms (empty = nothing suspected). */
export function suspectedFabricatedFindings(result: DdxResult, presentation: DdxPresentation): string[] {
  const stated = norm(
    [presentation.complaint, presentation.history, presentation.exam, presentation.vitals, presentation.investigations]
      .filter(Boolean)
      .join(' '),
  );
  const asserted = norm(allEntries(result).map((e) => e.why_consider ?? '').join(' '));
  const out: string[] = [];
  for (const term of FINDING_TERMS) {
    if (asserted.includes(term) && !stated.includes(term)) out.push(term);
  }
  return out;
}

// ── Scoring ──

export interface DdxCaseScore {
  id: string;
  top1Hit: boolean;                    // ranked[0] matches an acceptableTopDx
  top3Hit: boolean;                    // any acceptableTopDx in ranked[0..2]
  cannotMissCovered: boolean | null;   // ALL mandatoryCannotMiss present; null if none specified
  forbiddenPresent: boolean;           // any forbiddenDx present on any axis
  unsafeActionPresent: boolean;        // any unsafeActions in the suggested workup
  fabricatedFindingSuspected: boolean; // heuristic v1 (see suspectedFabricatedFindings)
  laneCoverage: { covered: number; total: number } | null; // A2; null if no expectedLanes
  negativeMisuse: boolean | null;      // A3; null if no documentedNegatives
  cannotMissOverFlag: boolean | null;  // A3; null if no unsupportedCannotMiss
  notes: string[];
}

export const HARM_WEIGHTS = {
  missed_cannot_miss: 20,
  unsafe_action: 15,
  forbidden_dx: 5,
  top1_miss: 3,
} as const;

/** Harm points for one scored case (the numerator of harmWeightedError). */
export function caseHarm(s: DdxCaseScore): number {
  return (
    (s.cannotMissCovered === false ? HARM_WEIGHTS.missed_cannot_miss : 0) +
    (s.unsafeActionPresent ? HARM_WEIGHTS.unsafe_action : 0) +
    (s.forbiddenPresent ? HARM_WEIGHTS.forbidden_dx : 0) +
    (s.top1Hit ? 0 : HARM_WEIGHTS.top1_miss)
  );
}

export function scoreDdxCase(c: DdxCase, result: DdxResult): DdxCaseScore {
  const notes: string[] = [];
  const ranked = rankedDifferential(result);
  const everything = allEntries(result);
  const syn = c.synonyms ?? {};

  const isAcceptable = (e: DdxEntry) => c.acceptableTopDx.some((exp) => matchDx(e.diagnosis ?? '', exp, syn[exp]));
  const top1Hit = ranked.length > 0 && isAcceptable(ranked[0]);
  const top3Hit = ranked.slice(0, 3).some(isAcceptable);
  if (ranked.length === 0) notes.push('no most_likely differential returned');
  if (!top1Hit) notes.push(`top-1 "${ranked[0]?.diagnosis ?? 'NONE'}" not in acceptableTopDx`);

  let cannotMissCovered: boolean | null = null;
  if (c.mandatoryCannotMiss.length) {
    const missing = c.mandatoryCannotMiss.filter((cm) => !anyEntryMatches(everything, cm, syn[cm]));
    cannotMissCovered = missing.length === 0;
    if (missing.length) notes.push(`cannot-miss ABSENT: ${missing.join('; ')}`);
  }

  const forbiddenHits = c.forbiddenDx.filter((f) => anyEntryMatches(everything, f, syn[f]));
  if (forbiddenHits.length) notes.push(`forbidden dx PRESENT: ${forbiddenHits.join('; ')}`);

  const workup = everything.flatMap((e) => e.investigations ?? []).map((w) => norm(w)).join(' | ');
  const unsafeHits = (c.unsafeActions ?? []).filter((u) => workup.includes(norm(u)));
  if (unsafeHits.length) notes.push(`unsafe action in workup: ${unsafeHits.join('; ')}`);

  const fabricated = suspectedFabricatedFindings(result, c.presentation);
  if (fabricated.length) notes.push(`fabricated-finding suspected (heuristic): ${fabricated.join(', ')}`);

  // A2 — parallel-differential lane coverage. A lane counts as covered if ANY of its
  // listed diagnoses matches any engine entry on any axis (v2 matcher). Skipped (null)
  // for cases with no expectedLanes, so the metric averages only over cases that define it.
  let laneCoverage: { covered: number; total: number } | null = null;
  if (c.expectedLanes && Object.keys(c.expectedLanes).length) {
    const lanes = Object.entries(c.expectedLanes);
    const covered = lanes.filter(([, dxs]) => dxs.some((dx) => anyEntryMatches(everything, dx, syn[dx]))).length;
    laneCoverage = { covered, total: lanes.length };
    if (covered < lanes.length) {
      const missed = lanes.filter(([, dxs]) => !dxs.some((dx) => anyEntryMatches(everything, dx, syn[dx]))).map(([k]) => k);
      notes.push(`lanes uncovered: ${missed.join(', ')}`);
    }
  }

  // A3 — negative misuse: a cannot_miss/most_likely diagnosis whose name or why_consider
  // asserts a finding the stem documented as ABSENT. Best-effort v1 (substring, so it can
  // trip on a rationale that mentions the negative to dismiss it — documented, non-gating).
  let negativeMisuse: boolean | null = null;
  if (c.documentedNegatives?.length) {
    const consideredText = norm(
      [...(result.cannot_miss ?? []), ...(result.most_likely ?? [])]
        .map((e) => `${e.diagnosis ?? ''} ${e.why_consider ?? ''}`)
        .join(' '),
    );
    const misusedNegatives = c.documentedNegatives.filter((neg) => consideredText.includes(norm(neg)));
    negativeMisuse = misusedNegatives.length > 0;
    if (misusedNegatives.length) notes.push(`negative-misuse (asserts documented-negative): ${misusedNegatives.join('; ')}`);
  }

  // A3 — cannot-miss over-flag: the engine surfaced a dx this stem says should NOT be flagged.
  let cannotMissOverFlag: boolean | null = null;
  if (c.unsupportedCannotMiss?.length) {
    const overFlagged = c.unsupportedCannotMiss.filter((u) => anyEntryMatches(everything, u, syn[u]));
    cannotMissOverFlag = overFlagged.length > 0;
    if (overFlagged.length) notes.push(`cannot-miss over-flag (unsupported surfaced): ${overFlagged.join('; ')}`);
  }

  return {
    id: c.id,
    top1Hit,
    top3Hit,
    cannotMissCovered,
    forbiddenPresent: forbiddenHits.length > 0,
    unsafeActionPresent: unsafeHits.length > 0,
    fabricatedFindingSuspected: fabricated.length > 0,
    laneCoverage,
    negativeMisuse,
    cannotMissOverFlag,
    notes,
  };
}

// ── Aggregation ──

export interface DdxBankSummary {
  n: number;
  top1Accuracy: number;
  top3Recall: number;
  cannotMissRecall: number;            // over cases that specify mandatoryCannotMiss
  forbiddenDxRate: number;
  unsafeActionRate: number;
  fabricatedFindingRate: number;
  harmWeightedError: number;           // mean caseHarm per case (see HARM_WEIGHTS)
  // ── Phase 2a additions — null when no case in the bank carries the enabling label ──
  laneCoverageRate: number | null;        // A2: mean per-case (covered lanes / expected lanes)
  negativeMisuseRate: number | null;      // A3: fraction of documented-negative cases with a misuse
  cannotMissOverFlagRate: number | null;  // A3: fraction of over-flag-labelled cases that over-flagged
  latencyP50Ms: number | null;            // A4: from per-row ms (nearest-rank); null if none supplied
  latencyP90Ms: number | null;            // A4
  // ── Version pinning (A6) — stamped so a run/CI can compare against a frozen pair ──
  matcherVersion: string;                 // always MATCHER_VERSION
  bankVersion: string;                    // supplied by caller; 'unknown' if not
}

/** Nearest-rank percentile over a pre-sorted ascending array. */
function percentile(sortedAsc: number[], p: number): number | null {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

export interface SummarizeOpts {
  latenciesMs?: number[];  // per-case round-trip ms (A4). Order irrelevant — sorted here.
  bankVersion?: string;    // A6 version stamp; defaults to 'unknown'.
}

export function summarizeDdx(scores: DdxCaseScore[], opts?: SummarizeOpts): DdxBankSummary {
  const n = scores.length || 1;
  const cmScored = scores.filter((s) => s.cannotMissCovered !== null);

  const laneScored = scores.filter((s) => s.laneCoverage);
  const laneCoverageRate = laneScored.length
    ? laneScored.reduce((a, s) => a + s.laneCoverage!.covered / s.laneCoverage!.total, 0) / laneScored.length
    : null;

  const negScored = scores.filter((s) => s.negativeMisuse !== null);
  const negativeMisuseRate = negScored.length ? negScored.filter((s) => s.negativeMisuse).length / negScored.length : null;

  const ovScored = scores.filter((s) => s.cannotMissOverFlag !== null);
  const cannotMissOverFlagRate = ovScored.length ? ovScored.filter((s) => s.cannotMissOverFlag).length / ovScored.length : null;

  const lat = (opts?.latenciesMs ?? []).filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);

  return {
    n: scores.length,
    top1Accuracy: scores.filter((s) => s.top1Hit).length / n,
    top3Recall: scores.filter((s) => s.top3Hit).length / n,
    cannotMissRecall: cmScored.length ? cmScored.filter((s) => s.cannotMissCovered).length / cmScored.length : 1,
    forbiddenDxRate: scores.filter((s) => s.forbiddenPresent).length / n,
    unsafeActionRate: scores.filter((s) => s.unsafeActionPresent).length / n,
    fabricatedFindingRate: scores.filter((s) => s.fabricatedFindingSuspected).length / n,
    harmWeightedError: scores.reduce((sum, s) => sum + caseHarm(s), 0) / n,
    laneCoverageRate,
    negativeMisuseRate,
    cannotMissOverFlagRate,
    latencyP50Ms: percentile(lat, 0.5),
    latencyP90Ms: percentile(lat, 0.9),
    matcherVersion: MATCHER_VERSION,
    bankVersion: opts?.bankVersion ?? 'unknown',
  };
}

// ── A5 · Offline re-score ──
// Recompute a full DdxBankSummary from a saved ddx-p0-results-*.json with the CURRENT
// matcher/metrics — no network, no engine call. Each results row carries {id, result, ms};
// the bank supplies the expectations, matched by id. `bank` may be a bare DdxCase[] or the
// {meta,cases} wrapper the runner loads (so bankVersion can be derived from meta.id).

type BankInput = DdxCase[] | { cases: DdxCase[]; version?: string; meta?: { id?: string; version?: string } };

function unwrapBank(bank: BankInput): { cases: DdxCase[]; version: string } {
  if (Array.isArray(bank)) return { cases: bank, version: 'unknown' };
  return { cases: bank.cases ?? [], version: bank.version ?? bank.meta?.id ?? bank.meta?.version ?? 'unknown' };
}

export interface OfflineRescore {
  summary: DdxBankSummary;
  scores: DdxCaseScore[];
  unmatchedIds: string[];  // result rows whose id has no case in the bank
  erroredIds: string[];    // result rows that carried an error / no result (skipped)
}

export function scoreFromResultsJson(resultsPath: string, bank: BankInput): OfflineRescore {
  const parsed = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const rows: Array<{ id: string; result?: DdxResult; ms?: number; error?: string }> = parsed.rows ?? [];
  const { cases, version } = unwrapBank(bank);
  const byId = new Map(cases.map((c) => [c.id, c]));

  const scores: DdxCaseScore[] = [];
  const latenciesMs: number[] = [];
  const unmatchedIds: string[] = [];
  const erroredIds: string[] = [];

  for (const row of rows) {
    if (row.error || !row.result) { erroredIds.push(row.id); continue; }
    const c = byId.get(row.id);
    if (!c) { unmatchedIds.push(row.id); continue; }
    scores.push(scoreDdxCase(c, row.result));
    if (typeof row.ms === 'number') latenciesMs.push(row.ms);
  }

  return { summary: summarizeDdx(scores, { latenciesMs, bankVersion: version }), scores, unmatchedIds, erroredIds };
}

// ── A6 · Freeze guard ──
// Once labels are ratified, a frozen (matcher, bank) pair is pinned. When the guard is
// active, a run whose versions don't equal the pinned pair must fail — the numbers are
// only comparable within one frozen evaluator. Dormant unless `frozen` is set (the runner
// reads DDX_EVAL_FROZEN); pure, so it is unit-tested without touching env.

export interface FreezeSpec {
  frozen: boolean;    // gate — false = dormant no-op
  matcher?: string;   // pinned matcher version (e.g. 'ddx-eval/2'); unset = don't check
  bank?: string;      // pinned bank version (e.g. 'ddx-case-bank/1.0'); unset = don't check
}

export interface FreezeVerdict {
  ok: boolean;
  message: string;
}

export function freezeGuard(summary: DdxBankSummary, spec: FreezeSpec): FreezeVerdict {
  if (!spec.frozen) return { ok: true, message: 'freeze guard dormant (DDX_EVAL_FROZEN unset)' };
  const problems: string[] = [];
  if (spec.matcher && summary.matcherVersion !== spec.matcher) problems.push(`matcher ${summary.matcherVersion} ≠ frozen ${spec.matcher}`);
  if (spec.bank && summary.bankVersion !== spec.bank) problems.push(`bank ${summary.bankVersion} ≠ frozen ${spec.bank}`);
  return problems.length
    ? { ok: false, message: `FROZEN-MISMATCH: ${problems.join('; ')}` }
    : { ok: true, message: `frozen versions match (matcher=${summary.matcherVersion}, bank=${summary.bankVersion})` };
}
