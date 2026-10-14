/**
 * lib/preop-suggest-core.ts — B8b, THE SUGGESTION RAIL. No DB, no fetch, no clock, NO MODEL.
 *
 * WHAT CHANGED FROM B5, AND WHY. B5 built an extraction rail that PROPOSED INPUTS and, above
 * the confidence floor, SCORED them. B7 measured it and found the two defects that decided
 * B8 (validation pack §5): 40% self-disagreement on identical text, and a medication read as
 * a diagnosis that moved a 75-year-old from AMBER to RED.
 *
 * B8's ruling is not "kill it" and not "ship it". It is: **demote the model from assertor to
 * suggester**, and give it a promotion path back that runs through evidence rather than
 * through confidence.
 *
 *   · A SUGGESTION NEVER TOUCHES A SCORE. Not above a floor, not on unanimity, not ever.
 *     The only thing that can turn a suggestion into an input is a named human pressing
 *     Confirm on the case page, and that input then carries HUMAN provenance, not the
 *     model's.
 *   · THREE READS, NOT ONE. The same document is read three times at temperature 0.
 *     Unanimous ⇒ a high-confidence suggestion. Two of three ⇒ low. A three-way split is
 *     recorded and suggested at low confidence, because a reader who can see the span is
 *     better placed than a vote. The reads are cheap because the source-fingerprint rail
 *     means they happen once per content change, ever — not once per sweep.
 *   · THE BANNED INFERENCE IS FILTERED BEFORE SUGGESTION, not after. A span that names a
 *     drug may not suggest a diagnosis, full stop — B8a's dictionary already owns every
 *     legitimate drug-derived fact, and it owns them deterministically.
 *
 * THE MODE, not a boolean. `PREOP_EXTRACT_MODE` is off | suggest | score. The boolean it
 * replaces was never set in any environment, so there is nothing to migrate.
 */

import { diseaseHits, RX_DEFINITIONAL_INPUTS, RX_RULES } from './preop-harvest-core';
import type { Observation, PreopInputId } from './preop-assemble-core';
import {
  EXTRACT_TARGETS, NEVER_EXTRACTABLE, sourceFieldLabel, targetLabel,
  type ExtractedInput, type VerifyResult,
} from './preop-extract-core';

export const PREOP_SUGGEST_RULE_VERSION = 'preop-suggest/1';

// ── the mode ────────────────────────────────────────────────────────────────────

export const PREOP_EXTRACT_MODES = ['off', 'suggest', 'score'] as const;
export type PreopExtractMode = (typeof PREOP_EXTRACT_MODES)[number];

/** Anything unrecognised — including the empty string and the old boolean's "1" — is OFF.
 *  A clinical rail must never be switched on by a typo. */
export function parseExtractMode(raw: string | undefined | null): PreopExtractMode {
  const v = String(raw ?? '').trim().toLowerCase();
  return (PREOP_EXTRACT_MODES as readonly string[]).includes(v) ? (v as PreopExtractMode) : 'off';
}

/**
 * B8d · THE PROMOTION GATE. A field class reaches `score` mode — auto-accepted, scoring
 * without a human — only after ALL of: 3-read stability 100% on the golden set · zero false
 * tier-moves · at least two weeks of suggest-mode decisions with precision ≥ 95% on that
 * class · V ratifies THAT CLASS by name.
 *
 * The list is empty and will stay empty until that evidence exists. It is a constant,
 * changed by pull request, deliberately with no UI: a promotion is a clinical decision with
 * a paper trail, not a toggle somebody can find at 2am.
 */
export const PROMOTED_CLASSES: readonly PreopInputId[] = [];

/** True only when SOME class has been promoted. While it is false, `score` mode behaves
 *  exactly as `suggest` — configured, reachable in code, and inert in production. */
export function scoreModeReachable(): boolean { return PROMOTED_CLASSES.length > 0; }

export function autoAcceptable(mode: PreopExtractMode, inputId: PreopInputId): boolean {
  return mode === 'score' && PROMOTED_CLASSES.includes(inputId);
}

// ── the narrowed target set ─────────────────────────────────────────────────────

/**
 * What the model is asked about now. Three things, per the B8 kickoff:
 *   · functional status — the mFI-5 ripening input, the rail's one measured win (B7 §5.3:
 *     8 of the 9 UNKNOWNs it resolved were this), and unreachable by any table because it
 *     lives in prose like "good effort tolerance" and "not ambulating since 15 days";
 *   · explicit disease mentions the deterministic matcher missed — spellings, phrasings and
 *     abbreviations outside the curated list;
 *   · explicit insulin statements ("on insulin"), for the RCRI factor.
 *
 * DELIBERATELY REMOVED from what B5 asked about: hypertension_on_medication,
 * diabetes_mellitus and diabetes_uncomplicated. B8a's drug dictionary owns all three
 * deterministically, and asking a model for a fact a table already has is how the rabeprazole
 * reading happened.
 */
export const SUGGEST_EXCLUDED: ReadonlySet<PreopInputId> = new Set<PreopInputId>([
  'hypertension_on_medication', 'diabetes_mellitus', 'diabetes_uncomplicated',
]);

export const SUGGEST_TARGETS = EXTRACT_TARGETS.filter(
  (t) => !SUGGEST_EXCLUDED.has(t.id) && !NEVER_EXTRACTABLE.has(t.id),
);

export const SUGGEST_TARGET_IDS: ReadonlySet<string> = new Set(SUGGEST_TARGETS.map((t) => t.id));

// ── the banned inference, filtered BEFORE suggestion ────────────────────────────

const DRUG_NAMES: readonly string[] = RX_RULES.flatMap((r) => r.names);

/**
 * ⚠️ THE DICTIONARY IS NOT ENOUGH, and finding that out is why this function exists.
 *
 * The first version of this filter asked "does the span name a drug the RX dictionary
 * knows?" — and RABEPRAZOLE, the exact drug that caused B8, is deliberately NOT in that
 * dictionary, because it maps to nothing. So the filter let the rabeprazole→peptic-ulcer
 * suggestion straight through. Caught by the B8b test table before it shipped.
 *
 * A medication line is recognised by its SHAPE, not by a list of names anyone has to keep
 * up to date: a dosage form, a strength, a frequency code, or a pharmacological suffix.
 * That generalises to every drug nobody has written down yet, which is the only property
 * worth having here.
 */
const DOSAGE_FORM = /\b(?:tab|tabs?|tablet|cap|caps?|capsule|inj|injection|syp|syrup|susp|oint|inh|inhaler|nebul\w*|drops?|patch|pessary|supp)\b/i;
const STRENGTH = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|ml|iu|units?)\b/i;
const FREQUENCY = /(?:\b(?:od|bd|bid|tds|tid|qid|hs|sos|stat|prn)\b|\b\d-\d-\d\b)/i;
const DOSE_THEN_FREQUENCY = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu)?\s*(?:od|bd|bid|tds|tid|qid|hs|sos|prn)\b|\b\d+(?:\.\d+)?\s+\d-\d-\d\b/i;
/** Pharmacological suffixes. Deliberately conservative — every one of these is a drug stem
 *  that essentially never appears as an English word in a clinical note. */
const DRUG_SUFFIX = /\b[a-z]{3,}(?:prazole|sartan|olol|dipine|pril|statin|floxacin|cillin|mycin|azepam|azole|tidine|glitazone|gliptin|gliflozin|formin|glinide|parin|xaban|gatran|semide|thiazide|caine|profen|codone|tinib|mab)\b/i;

/** The drug name the dictionary knows, when it knows one. Kept for the report's detail. */
export function spanNamesADrug(span: string): string | null {
  const t = String(span ?? '').toLowerCase();
  for (const n of DRUG_NAMES) {
    if (new RegExp(`(^|[^a-z])${n}([^a-z]|$)`, 'i').test(t)) return n;
  }
  return null;
}

/**
 * True when THIS span names the drug class whose definition IS this input. A span naming an
 * oral hypoglycaemic is definitional for `diabetes_mellitus`; it is NOT definitional for
 * `insulin_treated_diabetes`, in either direction.
 */
export function definitionalFor(span: string, inputId: PreopInputId): boolean {
  if (!RX_DEFINITIONAL_INPUTS.has(inputId)) return false;
  const t = String(span ?? '').toLowerCase();
  return RX_RULES.some((r) =>
    r.present.includes(inputId)
    && r.names.some((n) => new RegExp(`(^|[^a-z])${n}([^a-z]|$)`, 'i').test(t)));
}

/**
 * The gate. A span is medication-ONLY when it reads as a pharmacy line AND names no disease
 * — because the prompt's rule is "if the only evidence you can copy is a drug name, return
 * nothing for that item". A span that says "IHD, on TAB ECOSPRIN 75" carries a disease name,
 * and the disease name is the evidence; dropping it would lose a legitimate reading.
 */
export function spanIsMedicationOnly(span: string): string | null {
  const t = String(span ?? '');
  if (!t.trim()) return null;
  if (diseaseHits(t).some((h) => !h.negated && h.rule.inputs.length)) return null;
  const known = spanNamesADrug(t);
  if (known) return known;
  if (DOSAGE_FORM.test(t)) return 'dosage form';
  if (DRUG_SUFFIX.test(t)) return 'drug-name suffix';
  if (STRENGTH.test(t) && FREQUENCY.test(t)) return 'strength + frequency';
  if (STRENGTH.test(t)) return 'strength';
  // "ECOSPRIN 75 OD" — a brand, a bare dose and a frequency code, with no form token and no
  // unit. The commonest shape in this cohort's PAC medication lines, and invisible to every
  // rule above it.
  if (DOSE_THEN_FREQUENCY.test(t)) return 'dose + frequency';
  return null;
}

export type SuggestDropReason =
  | 'medication_inference' | 'not_a_target' | 'never_extractable' | 'no_agreement';

export interface DroppedSuggestion {
  inputId: string;
  span: string;
  reason: SuggestDropReason;
  detail?: string;
}

// ── the three reads ─────────────────────────────────────────────────────────────

export type SuggestAgreement = 'unanimous' | 'majority' | 'split';
export type SuggestConfidence = 'high' | 'low';

export interface PreopSuggestion {
  inputId: PreopInputId;
  status: 'present' | 'absent';
  /** which of the three reads said what — null where a read did not mention the input */
  reads: Array<'present' | 'absent' | null>;
  agreement: SuggestAgreement;
  confidence: SuggestConfidence;
  /** the verbatim span, from the read that the winning status came from */
  span: string;
  field: string;
  fieldLabel: string;
  label: string;
  /** the model's own numeric confidence, averaged over the agreeing reads — DISPLAYED, and
   *  used for nothing: three reads at temperature 0 are a better signal than a self-report */
  modelConfidence: number;
  polaritySuspect: boolean;
}

/**
 * Reconcile three independent reads of the same document into suggestions.
 *
 * A read that does not mention an input is a `null` vote, not an absence: the model was
 * asked what the text says, and silence means it said nothing. Two present + one silent is
 * therefore a MAJORITY, not a split — and it is suggested at low confidence, which is the
 * whole point of having a human look.
 */
export function reconcileReads(reads: VerifyResult[]): { suggestions: PreopSuggestion[]; dropped: DroppedSuggestion[] } {
  const dropped: DroppedSuggestion[] = [];
  const byInput = new Map<PreopInputId, Array<ExtractedInput | null>>();

  const ids = new Set<PreopInputId>();
  for (const r of reads) for (const a of r.accepted) ids.add(a.inputId);

  for (const id of ids) {
    byInput.set(id, reads.map((r) => r.accepted.find((a) => a.inputId === id) ?? null));
  }

  const suggestions: PreopSuggestion[] = [];
  for (const [inputId, votes] of byInput) {
    const seen = votes.filter((v): v is ExtractedInput => v != null);
    const first = seen[0];
    if (!first) continue;

    // GATE — the banned inference, applied before anything else. A span that reads as a
    // pharmacy line may only support an input whose definition IS *that* drug class.
    //
    // ⚠️ AND "that" IS DOING REAL WORK. The first cut allowed any input in
    // RX_DEFINITIONAL_INPUTS through, which let three suggestions of
    // insulin_treated_diabetes ABSENT survive on spans naming ORAL agents — "TAB GLYCOMET
    // GP1", "TAB METFORMIN 500MG 1-0-1", "TAB GLIMIPRIDE + METFORMIN". That is precisely
    // the inference B8a refuses to make deterministically (a type-2 diabetic on metformin
    // plus basal insulin is an ordinary patient, and a list may be incomplete), and a
    // human confirming it would collapse an RCRI range on the reasoning B7 got wrong.
    // Found on the 48-episode golden set, not reasoned about in advance.
    const drug = spanIsMedicationOnly(first.rawText);
    if (drug && !definitionalFor(first.rawText, inputId)) {
      dropped.push({ inputId, span: first.rawText, reason: 'medication_inference', detail: drug });
      continue;
    }
    if (NEVER_EXTRACTABLE.has(inputId)) {
      dropped.push({ inputId, span: first.rawText, reason: 'never_extractable' });
      continue;
    }
    if (!SUGGEST_TARGET_IDS.has(inputId)) {
      dropped.push({ inputId, span: first.rawText, reason: 'not_a_target' });
      continue;
    }

    const statuses = votes.map((v) => v?.status ?? null);
    const present = statuses.filter((s) => s === 'present').length;
    const absent = statuses.filter((s) => s === 'absent').length;
    const status: 'present' | 'absent' = present >= absent ? 'present' : 'absent';
    const agreeing = seen.filter((v) => v.status === status);
    const n = agreeing.length;
    const agreement: SuggestAgreement =
      n === reads.length ? 'unanimous'
        : present > 0 && absent > 0 && Math.abs(present - absent) <= 0 ? 'split'
          : n >= 2 ? 'majority' : 'split';

    const winner = agreeing[0];
    suggestions.push({
      inputId, status, reads: statuses, agreement,
      confidence: agreement === 'unanimous' ? 'high' : 'low',
      span: winner.rawText,
      field: winner.field,
      fieldLabel: sourceFieldLabel(winner.field),
      label: targetLabel(inputId),
      modelConfidence: Number((agreeing.reduce((t, v) => t + v.confidence, 0) / n).toFixed(2)),
      polaritySuspect: agreeing.some((v) => v.polaritySuspect === true),
    });
  }
  suggestions.sort((a, b) => a.inputId.localeCompare(b.inputId));
  dropped.sort((a, b) => a.inputId.localeCompare(b.inputId));
  return { suggestions, dropped };
}

// ── the stored record ───────────────────────────────────────────────────────────

export interface PreopSuggestionRecord {
  version: string;
  /** fnv1a over the SOURCE TEXT — the anti-flap key, unchanged from B5 */
  sourceFingerprint: string;
  generatedAt: string;
  /** DERIVED from the calls, never typed. One label; a mixed set is a fault, not a record. */
  model: string | null;
  provider: string | null;
  traceIds: string[];
  readCount: number;
  suggestions: PreopSuggestion[];
  dropped: DroppedSuggestion[];
  fieldsSeen: string[];
}

/** Per-field-class 3-read stability, for the B8d evidence table. */
export function stabilityByClass(records: Array<PreopSuggestionRecord | null>): Record<string, { unanimous: number; majority: number; split: number; total: number; stability: number }> {
  const out: Record<string, { unanimous: number; majority: number; split: number; total: number; stability: number }> = {};
  for (const rec of records) {
    for (const s of rec?.suggestions ?? []) {
      const row = out[s.inputId] ?? { unanimous: 0, majority: 0, split: 0, total: 0, stability: 0 };
      row[s.agreement]++;
      row.total++;
      out[s.inputId] = row;
    }
  }
  for (const k of Object.keys(out)) {
    out[k].stability = out[k].total ? Number((out[k].unanimous / out[k].total).toFixed(3)) : 0;
  }
  return out;
}

// ── decisions: the only path from suggestion to score ───────────────────────────

export const PREOP_DECISIONS = ['confirm', 'dismiss'] as const;
export type PreopDecisionKind = (typeof PREOP_DECISIONS)[number];

export interface PreopDecision {
  episodeKey: string;
  inputId: PreopInputId;
  status: 'present' | 'absent';
  span: string;
  field: string;
  decision: PreopDecisionKind;
  decidedBy: string;
  decidedAt: string;
  /** the SOURCE fingerprint the suggestion was made against */
  sourceFingerprint: string;
}

/**
 * Confirmed decisions → observations, source HUMAN.
 *
 * A decision is bound to the SOURCE FINGERPRINT it was made against. If the anaesthetist
 * later edits the note, the fingerprint moves, the old confirmation stops applying and the
 * input reverts to whatever the record says — because what the clinician confirmed was a
 * reading of a specific piece of text, and that text no longer exists. Silently carrying it
 * forward would be inventing a confirmation nobody gave.
 */
export function decisionObservations(
  decisions: readonly PreopDecision[],
  currentFingerprint: string | null,
): Observation[] {
  if (!currentFingerprint) return [];
  return decisions
    .filter((d) => d.decision === 'confirm' && d.sourceFingerprint === currentFingerprint)
    .map((d) => ({
      inputId: d.inputId,
      status: d.status,
      detail: `${targetLabel(d.inputId)} — confirmed by ${d.decidedBy} from ${sourceFieldLabel(d.field)}`,
      value: null,
      source: 'HUMAN' as const,
      provenanceRef: d.field,
      observedAt: d.decidedAt,
      sourceSpan: d.span,
    }));
}

/**
 * Suggestions the case page should still offer.
 *
 * Three things are filtered out, and the third was found on the live board rather than
 * reasoned about in advance:
 *
 *   1 · anything already confirmed or dismissed against this same source text;
 *   2 · (by construction, upstream) anything a gate refused;
 *   3 · ⚠️ ANYTHING THAT AGREES WITH WHAT THE RECORD ALREADY SAYS. Measured 27 Aug on a
 *       Preview probe: one misspelt span — "no comorbities" — produced NINETEEN unanimous
 *       ABSENT suggestions on a single episode, every one of which the booking form's
 *       closed world had already settled the same way. Confirming them would move nothing
 *       and dismissing them is nineteen clicks. A panel that asks a clinician to adjudicate
 *       what the record already answered will simply not be used, and a suggestion nobody
 *       reads is worse than no suggestion at all.
 *
 * So the panel offers only what would CHANGE something: a reading that differs from the
 * current resolved status, or one on an input still UNKNOWN. The rest are counted, not
 * shown — `redundantSuggestions` is what the footer reports.
 */
export function openSuggestions(
  rec: PreopSuggestionRecord | null,
  decisions: readonly PreopDecision[],
  resolved: Readonly<Record<string, string>> = {},
): PreopSuggestion[] {
  if (!rec) return [];
  const settled = new Set(
    decisions.filter((d) => d.sourceFingerprint === rec.sourceFingerprint).map((d) => d.inputId),
  );
  // `?? []` is not defensive noise: a record written by the B5 rail (preop-extract/1) has
  // no `suggestions` at all, and a reader must degrade to "nothing to offer" rather than
  // throw on a clinical page. suggestOne() re-reads such a record on the next sweep.
  return (rec.suggestions ?? []).filter((s) => !settled.has(s.inputId) && resolved[s.inputId] !== s.status);
}

/** How many suggestions agreed with the record and were therefore not shown. Reported so
 *  the rail's yield is never mistaken for the rail's output. */
export function redundantSuggestions(
  rec: PreopSuggestionRecord | null,
  resolved: Readonly<Record<string, string>> = {},
): number {
  return (rec?.suggestions ?? []).filter((s) => resolved[s.inputId] === s.status).length;
}
