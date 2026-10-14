/**
 * lib/doc-audit-core.ts — Case Audit CORE (DA.1).
 *
 * PURE, dependency-free (no db/llm/json-import). Importable by BOTH the server
 * passes (lib/doc-audit.ts, lib/gemini-multimodal.ts) and the client renderer
 * (components/CaseAuditReport.tsx), and unit-testable with `node --experimental-strip-types`.
 * See CDMSS-CASE-AUDIT-PRD-v1.0.md.
 *
 * The rubric (data/nabh-rubric.json) is loaded by the WIRED layer and passed IN as
 * RubricField[] so this core never imports JSON (keeps it strip-types testable).
 *
 * Posture: advisory, NON-DIRECTIVE, and NOT a judgment of the clinician. Evidence
 * (cited) is kept separate from estimates (labeled). PHI: the extractor must not
 * echo identifiers; nothing here persists anything.
 */

import type { TariffRef } from './lvc-value-core';
import type { SkeletonStage } from './pathway-core';
import type { Source, CiteHit } from './citations-core';
import type { ValueDomain, ValueScorecard } from './value-score-core';
import type { PrognosisReport } from './prognosis-core';
export type { PrognosisReport } from './prognosis-core';
export type { TariffRef } from './lvc-value-core';
export type { Source } from './citations-core';
export type { ValueDomain, ValueScorecard } from './value-score-core';

// Inlined value-domain normaliser (mirrors the enum in value-score-core). Inlined for the
// same strip-types reason as validateCitationIds: doc-audit-core has an in-repo node --test,
// so a runtime import from a sibling .ts would need an extension the Next build omits.
const VALUE_DOMAIN_SET = new Set(['appropriateness', 'efficiency', 'safety', 'cost', 'documentation', 'patient_centred']);
function normValueDomain(v: unknown): ValueDomain | undefined {
  const s = String(v ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (s === 'patient_centered' || s === 'patientcentred') return 'patient_centred';
  if (s === 'intensity' || s === 'efficient') return 'efficiency';
  if (s === 'appropriate' || s === 'appropriateness_of_care') return 'appropriateness';
  return VALUE_DOMAIN_SET.has(s) ? (s as ValueDomain) : undefined;
}

// Inlined (mirrors lib/citations-core.validateCitationIds) — see the same note in
// pathway-core: doc-audit-core has an in-repo strip-types test, so a runtime value
// import would need a `.ts` extension the Next build doesn't use. Keep in sync.
function validateCitationIds(ids: unknown, max: number, cap = 8): number[] {
  if (!Array.isArray(ids) || max < 1) return [];
  const out: number[] = [];
  for (const x of ids) {
    const n = Math.round(Number(x));
    if (Number.isFinite(n) && n >= 1 && n <= max && !out.includes(n)) out.push(n);
    if (out.length >= cap) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DocType = 'discharge_summary' | 'ot_note' | 'opd_rx';
export type FieldStatus = 'present' | 'partial' | 'missing' | 'na';
export type NetValue = 'high-value' | 'context-dependent' | 'low-value' | 'uncertain';

export interface RubricField {
  key: string;
  label: string;
  section: string;
  ref: string;        // NABH clause or 'clinical'
  mandatory: boolean;
  na: boolean;        // may be marked N/A with reason
  cond?: string;      // only applicable when this holds (e.g. 'implant_used=true')
}

/** Raw per-field documentation status, judged against the DOCUMENT (status-only, no values). */
export interface RawStatus { key: string; status: FieldStatus; note: string }

/**
 * Non-identifying administrative / temporal facts, used for value reasoning
 * (over-stay, level-of-care, antibiotic duration). DELIBERATELY contains NO dates —
 * a stay LENGTH (a duration) is not a HIPAA identifier; admission/discharge DATES are,
 * so the extractor reports the day-count only, never the calendar dates.
 */
export interface AdminFacts {
  lengthOfStayDays: number | null;
  admissionType: string | null;   // elective | emergency | …
  careSetting: string | null;     // day_care | ward | room | icu | …
}

/** PX (prognosis pass): the plan's actual aftercare text, captured verbatim-ish so the
 *  safety-net audit judges real text, not a paraphrase. De-identified like everything else. */
export interface AftercarePlan {
  instructions: string[];        // aftercare/wound-care/activity instructions as documented
  warning_signs: string[];       // "when to obtain urgent care" items as documented
  follow_up_detail: string | null; // follow-up line incl. any symptom triggers
}

/**
 * R10-A (CDMSS-READMISSIONS-R10-RECORD-REACH PRD §3.1, decision R10-D1/R10-D10) — the printed
 * clinical blocks the extractor COPIES rather than summarises.
 *
 * WHY THE CONTRACT NEEDED A NEW FIELD AT ALL. Every existing field on ExtractedCase is a
 * *summary* of something the document says (`procedure`, `courseSummary`, `treatments`). None of
 * them can carry an operative block as printed, so a discharge summary that prints the whole OT
 * note in its body reached the readmission agent as a one-line `procedure` string — and the agent,
 * finding no structured OT row in db13 either, told a care manager the operative text did not
 * exist. That is the defect Dr. Zaki reported on 26 Aug (UHID-26415) and it is a defect of
 * OMISSION, not of judgement.
 *
 * DE-IDENTIFIED LIKE EVERYTHING ELSE. `verbatim` means "the document's own clinical wording",
 * never "the document's own identifiers": the extractor's CRITICAL PRIVACY RULE applies to this
 * field exactly as it applies to `raw_notes`, and lib/readmission/assemble.ts puts every string
 * through `deidText` again afterwards, so the guarantee does not rest on the prompt behaving.
 */
export interface VerbatimSection {
  /** The heading as printed ("OPERATIVE NOTES", "Procedure Details", "Course in Hospital"). */
  heading: string;
  /** The block's text, copied not summarised, capped at VERBATIM_SECTION_MAX_CHARS. */
  text: string;
}

/** At most this many verbatim sections survive a parse (PRD kickoff: 6 × 4,000). */
export const VERBATIM_SECTION_MAX = 6;
/** Per-section character cap, applied at PARSE time so no stored row can exceed it. */
export const VERBATIM_SECTION_MAX_CHARS = 4_000;

export interface ExtractedCase {
  docType: DocType;
  detectedDocType: DocType;
  confidence: number;            // 0..1 — extractor's confidence in the doc-type + read
  patient: { age?: number; sex?: string };
  diagnosis: string | null;
  indication: string | null;     // OPD/OT indication when distinct from a diagnosis
  procedure: string | null;      // OT
  investigations: string[];
  treatments: string[];
  medications: string[];
  courseSummary: string;
  disposition: string | null;
  followUp: string | null;
  rawNotes: string;              // DE-IDENTIFIED extractor notes (no name/UHID)
  // Completeness is judged HERE, in the pass that actually sees the document, so the
  // downstream (de-identified) analyze pass never has to guess whether a header/sign-off
  // field is present. Status-only — never carries the field's value (PHI-safe).
  completeness?: RawStatus[];
  adminFacts?: AdminFacts;
  // PX additions (PRD v1.0 §6.3) — BOTH OPTIONAL; absent on pre-PX extractions.
  riskFactors?: string[];        // stated comorbidities/allergies/risk-relevant facts (facts only, de-identified)
  aftercare?: AftercarePlan;
  /** R10-A: clinically substantive printed blocks, COPIED. Absent on pre-R10 extractions —
   *  every reader must treat `undefined` and `[]` as the same "the document showed none". */
  verbatimSections?: VerbatimSection[];
}

export interface CompletenessItem {
  key: string; label: string; section: string; ref: string;
  status: FieldStatus; mandatory: boolean; note?: string;
}
export interface CompletenessReport {
  items: CompletenessItem[];
  coverage: number;          // 0..1 over applicable mandatory fields
  mandatoryTotal: number;
  mandatoryMet: number;      // present=1, na=1, partial=0.5
  missingMandatory: string[];
}

export interface AuditFinding {
  subject: string;
  verdict: NetValue;
  confidence: number;
  rationale: string;
  order?: string;            // concrete orderable → deterministic tariff match
  evidence: string[];
  estimates: string[];
  citation_ids: number[];    // [n] of the surfaced Source[] that back this finding's evidence
  tariffs?: TariffRef[];     // set deterministically by the server, not the LLM
  domain?: ValueDomain;      // which Care-Value axis this finding scores against (LLM-tagged)
}

export interface DiffItem { kind: 'overuse' | 'gap'; text: string; ref?: string }
export interface Suggestion { priority: number; text: string; ref?: string }

export interface AuditReport {
  completeness: CompletenessReport;
  findings: AuditFinding[];
  idealisedSummary: string;
  idealisedStages?: Pick<SkeletonStage, 'id' | 'kind' | 'title' | 'action' | 'flag'>[];
  diff: DiffItem[];
  suggestions: Suggestion[];
  sources: Source[];         // corpus citations surfaced for this audit (findings cite by [n])
  adminFacts?: AdminFacts;   // non-identifying stay facts (LOS/level-of-care) — context for the value findings
  valueScore?: ValueScorecard;  // deterministic Care-Value Scorecard (computed server-side from the findings)
  prognosis?: PrognosisReport;  // PX pass (PRD v1.0) — absent on old runs / when PROGNOSIS_AUDIT is off / on soft-fail
  disclaimer: string;
}

export const CASE_AUDIT_DISCLAIMER =
  'Retrospective, advisory audit grounded in retrieved guidance and NABH standards. Evidence-cited points are kept separate from model estimates. It is not a judgment of the clinician, not a substitute for the medical record or peer review, and never a denial-of-care justification.';

// ─────────────────────────────────────────────────────────────────────────────
// Normalisers + helpers
// ─────────────────────────────────────────────────────────────────────────────

const DOC_TYPES = new Set<DocType>(['discharge_summary', 'ot_note', 'opd_rx']);
const FIELD_STATUS = new Set<FieldStatus>(['present', 'partial', 'missing', 'na']);
const NET_VALUES = new Set<NetValue>(['high-value', 'context-dependent', 'low-value', 'uncertain']);

export function normDocType(v: unknown): DocType {
  const s = String(v ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (s === 'discharge_summary' || s === 'discharge' || s === 'dischargesummary' || s === 'ds') return 'discharge_summary';
  if (s === 'ot_note' || s === 'ot' || s === 'operative_note' || s === 'operativenote' || s === 'operation_note' || s === 'surgery') return 'ot_note';
  if (s === 'opd_rx' || s === 'opd' || s === 'prescription' || s === 'rx' || s === 'opd_prescription') return 'opd_rx';
  return DOC_TYPES.has(s as DocType) ? (s as DocType) : 'discharge_summary';
}

export function normFieldStatus(v: unknown): FieldStatus {
  const s = String(v ?? '').toLowerCase().trim();
  if (s === 'n/a' || s === 'not applicable' || s === 'na') return 'na';
  if (s === 'absent' || s === 'not documented' || s === 'not_documented') return 'missing';
  if (s === 'incomplete') return 'partial';
  return FIELD_STATUS.has(s as FieldStatus) ? (s as FieldStatus) : 'missing';
}

export function normNetValue(v: unknown): NetValue {
  const s = String(v ?? '').toLowerCase().trim().replace(/\s+/g, '-');
  if (NET_VALUES.has(s as NetValue)) return s as NetValue;
  // Right-Care fixes PRD Fix A: the fallback stays (contract unchanged) but is now VISIBLE —
  // an unparseable verdict is a parse hiccup, and it must not silently masquerade as the
  // clinical judgment 'uncertain'.
  console.warn(`[doc-audit-core] normNetValue: unparseable verdict ${JSON.stringify(v)} → 'uncertain' (parse fallback, not a clinical judgment)`);
  return 'uncertain';
}

function asStr(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }
function asStrOrNull(v: unknown): string | null { const s = asStr(v); return s ? s : null; }
function asStrArray(v: unknown, cap = 20): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x.trim() : (x && typeof x === 'object' ? asStr((x as Record<string, unknown>).name ?? (x as Record<string, unknown>).text) : ''))).filter(Boolean).slice(0, cap);
}
function asNum01(v: unknown): number { let n = Number(v); if (!Number.isFinite(n)) n = 0; return Math.max(0, Math.min(1, n)); }

/** Parse a `[{key,status,note}]` documentation-status list (used by both extract + analyze). */
export function parseStatusList(v: unknown): RawStatus[] {
  if (!Array.isArray(v)) return [];
  const out: RawStatus[] = [];
  for (const c of v) {
    const co = (c && typeof c === 'object') ? c as Record<string, unknown> : {};
    const key = asStr(co.key);
    if (!key) continue;
    out.push({ key, status: normFieldStatus(co.status), note: asStr(co.note) });
  }
  return out;
}

/** Parse non-identifying admin facts. Discards anything date-shaped; keeps only a day-count + labels. */
export function normAdminFacts(v: unknown): AdminFacts | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const losN = Math.round(Number(o.length_of_stay_days ?? o.lengthOfStayDays));
  const los = Number.isFinite(losN) && losN >= 0 && losN < 3650 ? losN : null;
  const at = asStr(o.admission_type ?? o.admissionType);
  const cs = asStr(o.care_setting ?? o.careSetting);
  if (los === null && !at && !cs) return undefined;
  return { lengthOfStayDays: los, admissionType: at || null, careSetting: cs || null };
}

export function extractJsonObject(text: string): unknown {
  let t = (text || '').trim();
  if (!t) return null;
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACT pass (Gemini multimodal) — prompt + parse
// ─────────────────────────────────────────────────────────────────────────────

export const EXTRACT_SYSTEM = `You are a careful clinical-records reader. You are given a scanned or digital clinical document (a discharge summary, an OT/operative note, or an OPD prescription) and must return a STRUCTURED, DE-IDENTIFIED extraction of what it says — the actual course of care — PLUS a documentation-completeness check.

CRITICAL PRIVACY RULE: do NOT include the patient's name, UHID/hospital number, address, phone, or any direct identifier anywhere in your output. Keep age and sex only. If you transcribe notes, redact identifiers. EXCEPTION: in the "completeness" check you may mark an identifier field "present" — that reports only WHETHER it is documented, never its value (e.g. mark patient_name "present" but never write the name).

Read faithfully — extract only what the document actually contains; do not infer or add care that isn't documented (gaps are the point of the downstream audit). When a treatment has a duration (e.g. IV antibiotics given across several days), capture it (e.g. "IV Augmentin ~7 days") — durations matter for the value audit.

COMPLETENESS CHECK: you are given a list of documentation FIELDS to check (key + where it belongs). For EACH field key decide, by reading the WHOLE document (header/letterhead, body tables, and the sign-off/footer), one status: "present" (clearly documented) | "partial" (present but incomplete, e.g. a drug with no dose/route/duration) | "missing" (not documented) | "na" (genuinely not applicable, only where allowed). Judge presence from the document itself — a header field like the admission/discharge date or treating-doctor name counts as "present" even though it is an identifier. For a signature/sign-off field, "present" means a clinician name + signature/credential actually appears. Add a SHORT note for partial/missing — and never put an identifier value in the note.

ADMIN FACTS (non-identifying): set length_of_stay_days = whole days between admission and discharge when BOTH are documented, else null — output ONLY the day count, NEVER the actual dates. Set admission_type (elective/emergency/…) and care_setting (day_care/ward/room/icu/…) when stated.

RISK FACTORS & AFTERCARE (both may be empty; facts only, never inferred; same NO-IDENTIFIER rule): risk_factors = comorbidities, allergies (including any allergy noted or breached during the stay), and other risk-relevant facts the document states (e.g. "known allergy to Diclofenac Sodium", "diabetic", "smoker"). aftercare = the plan's ACTUAL text, verbatim or closely paraphrased: instructions = aftercare/wound-care/activity/diet instructions given; warning_signs = the "when to obtain urgent care"-type items exactly as listed; follow_up_detail = the follow-up line including any symptom triggers it names.

VERBATIM SECTIONS (R10-A) — COPY, DO NOT SUMMARISE. Some documents print a whole clinical block inside the body: an operative / OT note, an intra-operative findings block, a procedure-details block, an anaesthesia record, a course-in-hospital block. For EACH such clinically substantive printed block, return one entry in "verbatim_sections" with the heading exactly as printed and the block's text REPRODUCED WORD FOR WORD from the document — do not paraphrase it, do not shorten it, do not tidy the wording. At most 6 sections; if a block runs longer than about 4,000 characters, copy its first 4,000 characters rather than summarising it. Return an empty list when the document prints no such block. The NO-IDENTIFIER rule above applies here unchanged: copy the clinical wording, never the patient's name, UHID, hospital number, address or phone — redact those as you copy.

Return ONLY JSON, no prose:
{"detected_doc_type":"discharge_summary|ot_note|opd_rx","confidence":0.0-1.0,"patient":{"age":<number or null>,"sex":"<m/f or null>"},"diagnosis":"… or null","indication":"… or null","procedure":"… or null (OT only)","investigations":["…"],"treatments":["…"],"medications":["…"],"course_summary":"<concise de-identified summary of the documented course>","disposition":"… or null","follow_up":"… or null","admin_facts":{"length_of_stay_days":<integer or null>,"admission_type":"… or null","care_setting":"… or null"},"risk_factors":["…"],"aftercare":{"instructions":["…"],"warning_signs":["…"],"follow_up_detail":"… or null"},"verbatim_sections":[{"heading":"<heading exactly as printed>","text":"<the block copied word for word, no identifiers>"}],"completeness":[{"key":"<field key>","status":"present|partial|missing|na","note":"<short, NO identifier values>"}],"raw_notes":"<short de-identified notes on legibility/structure, NO identifiers>"}`;

export function buildExtractUser(docTypeHint: DocType | 'auto', rubricFields: RubricField[], context?: string): string {
  const hint = docTypeHint === 'auto'
    ? 'Document type: auto-detect (set detected_doc_type).'
    : `Document type (clinician-stated): ${docTypeHint}. Confirm or correct it in detected_doc_type.`;
  const ctx = context && context.trim() ? `\nClinician context: ${context.trim()}` : '';
  const rubric = rubricFields.length
    ? `\n\nDOCUMENTATION FIELDS TO CHECK (status only — never echo a field's value):\n${rubricFields.map((f) => `- ${f.key} [${f.ref}${f.cond ? `, only if ${f.cond}` : ''}${f.na ? ', N/A allowed' : ''}] ${f.label}`).join('\n')}`
    : '';
  return `${hint}${ctx}${rubric}\n\nRead the attached document and return the structured de-identified extraction, the admin facts, the verbatim sections (copied, not summarised), and the completeness check.`;
}

export function parseExtraction(raw: string, docTypeHint: DocType | 'auto'): ExtractedCase | null {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const detected = normDocType(o.detected_doc_type ?? o.detectedDocType);
  const docType: DocType = docTypeHint === 'auto' ? detected : docTypeHint;
  const p = (o.patient && typeof o.patient === 'object') ? o.patient as Record<string, unknown> : {};
  const ageN = Number(p.age);
  const sexRaw = asStr(p.sex).toLowerCase();
  const sex = sexRaw.startsWith('m') ? 'male' : sexRaw.startsWith('f') ? 'female' : (sexRaw || undefined);
  const courseSummary = asStr(o.course_summary ?? o.courseSummary);
  // Require at least *some* signal that a document was read.
  if (!courseSummary && !asStr(o.diagnosis) && asStrArray(o.medications).length === 0 && !asStr(o.procedure)) return null;
  return {
    docType,
    detectedDocType: detected,
    confidence: asNum01(o.confidence),
    patient: { age: Number.isFinite(ageN) && ageN > 0 && ageN < 130 ? Math.round(ageN) : undefined, sex },
    diagnosis: asStrOrNull(o.diagnosis),
    indication: asStrOrNull(o.indication),
    procedure: asStrOrNull(o.procedure),
    investigations: asStrArray(o.investigations),
    treatments: asStrArray(o.treatments),
    medications: asStrArray(o.medications),
    courseSummary,
    disposition: asStrOrNull(o.disposition),
    followUp: asStrOrNull(o.follow_up ?? o.followUp),
    rawNotes: asStr(o.raw_notes ?? o.rawNotes),
    completeness: parseStatusList(o.completeness),
    adminFacts: normAdminFacts(o.admin_facts ?? o.adminFacts),
    riskFactors: asStrArray(o.risk_factors ?? o.riskFactors, 12),
    aftercare: parseAftercare(o.aftercare),
    verbatimSections: parseVerbatimSections(o.verbatim_sections ?? o.verbatimSections),
  };
}

/**
 * R10-A §3.1: parse the optional verbatim-section list. Absent / malformed / all-empty →
 * `undefined`, which is exactly what a pre-R10 stored extraction reads as, so every consumer has
 * ONE absent shape to handle rather than two.
 *
 * A section survives only when it carries TEXT. A heading with no body is a heading the extractor
 * saw and could not copy — recording it would let a downstream reader count a section that carries
 * nothing, and "there is an operative section" is precisely the claim R10 exists to make truthful.
 * A missing heading is tolerated (the text is the evidence) and labelled.
 */
export function parseVerbatimSections(v: unknown): VerbatimSection[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: VerbatimSection[] = [];
  for (const el of v) {
    if (out.length >= VERBATIM_SECTION_MAX) break;
    const o = (el && typeof el === 'object') ? el as Record<string, unknown> : {};
    const text = asStr(o.text ?? o.body ?? o.content);
    if (!text) continue;
    const heading = asStr(o.heading ?? o.title ?? o.section) || 'section';
    out.push({
      heading: heading.slice(0, 200),
      text: text.length > VERBATIM_SECTION_MAX_CHARS ? `${text.slice(0, VERBATIM_SECTION_MAX_CHARS)}…` : text,
    });
  }
  return out.length ? out : undefined;
}

/** PX §6.3: parse the optional aftercare block. Absent/malformed → undefined (old-shape safe). */
export function parseAftercare(v: unknown): AftercarePlan | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const instructions = asStrArray(o.instructions, 20);
  const warning_signs = asStrArray(o.warning_signs ?? o.warningSigns, 20);
  const follow_up_detail = asStrOrNull(o.follow_up_detail ?? o.followUpDetail);
  if (instructions.length === 0 && warning_signs.length === 0 && !follow_up_detail) return undefined;
  return { instructions, warning_signs, follow_up_detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// ANALYZE pass (Pro, grounded) — prompt + parse
// ─────────────────────────────────────────────────────────────────────────────

export const ANALYZE_SYSTEM = `You are a clinical quality auditor for a NABH-accredited hospital. You are given (1) a DE-IDENTIFIED extracted case from a clinical document (including non-identifying STAY FACTS — length of stay in days, admission type, care setting) and (2) NUMBERED EVIDENCE EXCERPTS [1], [2], … from a medical corpus. Produce a retrospective, advisory audit. NON-DIRECTIVE and NOT a judgment of the clinician. (Documentation completeness is checked separately — do NOT assess it here.)

Do three things:
1. APPROPRIATENESS / LOW-VALUE — review the investigations, treatments, drugs, and procedure for over-use / low-value / questionable decisions for this case. Consider the VALUE OF CARE INTENSITY too, using the stay facts: an inpatient admission or a multi-day length of stay for a procedure usually done as day-care, or a prolonged course of IV antibiotics for a clean/low-risk procedure, are over-use signals worth a finding. Each finding: subject, verdict (high-value | context-dependent | low-value | uncertain), confidence, rationale, the single concrete "order" name if it maps to an orderable test/procedure/drug (so a tariff can be attached), a "domain" tag (see below), and "citation_ids": the [n] of the excerpts that actually support this finding's evidence. Ground clinical claims in the EXCERPTS — put grounded points (with citations) in "evidence" and your own figures/inferences or general-knowledge claims the excerpts don't cover in "estimates" (every figure marked "est."). Do NOT cite an excerpt that doesn't support the claim. Do NOT flag the absence of a step the document may simply not mention as if it were a care failure — frame uncertain reads as documentation gaps, not errors. Flag DIAGNOSTIC ANCHORING and base-rate neglect: a diagnosis or confirmatory test that rests mainly on a low-utility / low-specificity result (e.g. a positive Widal test) against a low pre-test probability, when the dominant clinical syndrome points elsewhere, is a low-value / over-use signal worth a finding.
   DOMAIN tag — classify each finding into the value axis it concerns: "appropriateness" (right test/treatment/procedure choice), "efficiency" (right care intensity: setting, length of stay, IV-vs-oral route, treatment duration), "safety" (a safety hazard or antimicrobial-stewardship concern), or "patient_centred" (continuity / instructions / shared decision). Default to "appropriateness" if unsure.
   VERDICT DISCIPLINE — "verdict" MUST be exactly one of high-value | context-dependent | low-value | uncertain; never any other word (not "caveat", "safety", "informational" — a safety concern is a finding with domain "safety" and one of the four verdicts). Use "uncertain" ONLY for genuine clinical equipoise where the evidence is mixed FOR THIS case. Standard, guideline-concordant care (routine safety labs, standard prophylaxis/supplementation, standard peri-operative steps) is "high-value" — state it confidently, do not hedge to "uncertain". An advisory caveat about care that was itself appropriate is "high-value" (or omit it); a counselling / monitoring / documentation reminder that does not assess the value of an order belongs in "suggestions", NOT in "findings". If a finding isn't worth raising, omit it rather than marking it "uncertain".
2. IDEALISED COURSE — a concise narrative of how the idealised hospital course / operation / OPD encounter should have gone for this case, then a DIFF: items "done — not needed" (kind:"overuse") and "ideal — but missing" (kind:"gap").
3. SUGGESTIONS — prioritised, concrete improvements (compliance + safety + value), priority 1 = highest.

Rules: advisory only; never phrase as blocking/denying care or blaming the clinician. Separate cited EVIDENCE from ESTIMATES. Do not invent citations or identifiers.

Return ONLY JSON, no prose:
{"findings":[{"subject":"…","verdict":"high-value|context-dependent|low-value|uncertain","confidence":0.0-1.0,"rationale":"…","order":"… (optional)","domain":"appropriateness|efficiency|safety|patient_centred","evidence":["…"],"estimates":["…"],"citation_ids":[1,2]}],"idealised_summary":"…","diff":[{"kind":"overuse|gap","text":"…","ref":"… (optional)"}],"suggestions":[{"priority":1,"text":"…","ref":"… (optional)"}]}`;

// Slice 2 (Right Care × ClinicalState): `clinicalStateText` is the pre-composed PATIENT
// PICTURE block. OPTIONAL and additive — omitted/empty → byte-identical to the ungrounded
// Slice-1 prompt (unit-asserted). Near-redundant here (the case is already structured);
// wired for cross-mode consistency behind the same flag.
export function buildAnalyzeUser(ctx: ExtractedCase, citedContext: string, standardLabel: string, clinicalStateText?: string): string {
  const pt = (ctx.patient.age != null || ctx.patient.sex)
    ? `Patient: ${ctx.patient.age != null ? `${ctx.patient.age}y` : 'age unknown'}${ctx.patient.sex ? `, ${ctx.patient.sex}` : ''}\n`
    : '';
  const lines: string[] = [];
  if (ctx.diagnosis) lines.push(`Diagnosis: ${ctx.diagnosis}`);
  if (ctx.indication) lines.push(`Indication: ${ctx.indication}`);
  if (ctx.procedure) lines.push(`Procedure: ${ctx.procedure}`);
  // PX §6.3 follow-through (found in G2): the extractor now files allergies/comorbidities
  // under risk_factors instead of prose — the analyze pass MUST see them or it loses
  // safety findings (e.g. a drug given against a documented allergy).
  if (ctx.riskFactors?.length) lines.push(`Stated risk factors / allergies: ${ctx.riskFactors.join('; ')}`);
  if (ctx.investigations.length) lines.push(`Investigations: ${ctx.investigations.join('; ')}`);
  if (ctx.treatments.length) lines.push(`Treatments: ${ctx.treatments.join('; ')}`);
  if (ctx.medications.length) lines.push(`Medications: ${ctx.medications.join('; ')}`);
  if (ctx.disposition) lines.push(`Disposition: ${ctx.disposition}`);
  if (ctx.followUp) lines.push(`Follow-up: ${ctx.followUp}`);
  const sf = adminFactsLine(ctx.adminFacts);
  if (sf) lines.push(sf);
  lines.push(`Course: ${ctx.courseSummary}`);
  const ev = citedContext.trim() ? citedContext.trim() : '(no excerpts retrieved — leave citation_ids empty; put clinical reasoning in estimates, not evidence)';
  const picture = clinicalStateText && clinicalStateText.trim() ? `\n\n${clinicalStateText.trim()}` : '';
  return `Document type: ${ctx.docType} (${standardLabel})\n${pt}EXTRACTED CASE:\n${lines.join('\n')}${picture}\n\nNUMBERED EVIDENCE EXCERPTS:\n${ev}`;
}

/** One-line render of the non-identifying stay facts (or '' if none). Shared by analyze + critique. */
export function adminFactsLine(a?: AdminFacts): string {
  if (!a) return '';
  const parts: string[] = [];
  if (a.lengthOfStayDays != null) parts.push(`length of stay ${a.lengthOfStayDays} day${a.lengthOfStayDays === 1 ? '' : 's'}`);
  if (a.admissionType) parts.push(a.admissionType);
  if (a.careSetting) parts.push(a.careSetting);
  return parts.length ? `Stay: ${parts.join('; ')}` : '';
}

export interface ParsedAnalysis {
  findings: AuditFinding[];
  idealisedSummary: string;
  diff: DiffItem[];
  suggestions: Suggestion[];
}

/**
 * A04 instrumentation (Reasoning Observability Stage 1, DA04=a): count the finding verdicts
 * the model emitted OUTSIDE the enum — the ones normNetValue launders to 'uncertain'. Pure
 * counter over the raw analyze output; mirrors parseAnalysis's normalisation exactly and
 * changes nothing about parsing. 0 on unparseable output (that's a parse failure, not a
 * verdict-discipline signal).
 */
export function countNonEnumVerdicts(raw: string): number {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== 'object') return 0;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.findings)) return 0;
  let n = 0;
  for (const f of o.findings as unknown[]) {
    const fo = (f && typeof f === 'object') ? f as Record<string, unknown> : {};
    if (!asStr(fo.subject)) continue;   // parseAnalysis skips subject-less findings — mirror it
    const s = String(fo.verdict ?? '').toLowerCase().trim().replace(/\s+/g, '-');
    if (!NET_VALUES.has(s as NetValue)) n++;
  }
  return n;
}

export function parseAnalysis(raw: string, sourceCount = 0): ParsedAnalysis | null {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  const findings: AuditFinding[] = [];
  if (Array.isArray(o.findings)) {
    for (const f of o.findings as unknown[]) {
      const fo = (f && typeof f === 'object') ? f as Record<string, unknown> : {};
      const subject = asStr(fo.subject);
      if (!subject) continue;
      findings.push({
        subject,
        verdict: normNetValue(fo.verdict),
        confidence: asNum01(fo.confidence),
        rationale: asStr(fo.rationale),
        order: asStr(fo.order) || undefined,
        evidence: asStrArray(fo.evidence, 8),
        estimates: asStrArray(fo.estimates, 8),
        citation_ids: validateCitationIds(fo.citation_ids, sourceCount),
        domain: normValueDomain(fo.domain),
      });
      if (findings.length >= 12) break;
    }
  }

  const diff: DiffItem[] = [];
  if (Array.isArray(o.diff)) {
    for (const d of o.diff as unknown[]) {
      const dobj = (d && typeof d === 'object') ? d as Record<string, unknown> : {};
      const text = asStr(dobj.text);
      if (!text) continue;
      const k = String(dobj.kind ?? '').toLowerCase();
      const kind: 'overuse' | 'gap' = (k.includes('gap') || k.includes('miss')) ? 'gap' : 'overuse';
      diff.push({ kind, text, ref: asStr(dobj.ref) || undefined });
      if (diff.length >= 12) break;
    }
  }

  const suggestions: Suggestion[] = [];
  if (Array.isArray(o.suggestions)) {
    let i = 0;
    for (const s of o.suggestions as unknown[]) {
      const so = (s && typeof s === 'object') ? s as Record<string, unknown> : {};
      const text = asStr(so.text);
      i += 1;
      if (!text) continue;
      let pr = Number(so.priority);
      if (!Number.isFinite(pr) || pr < 1) pr = i;
      suggestions.push({ priority: Math.round(pr), text, ref: asStr(so.ref) || undefined });
      if (suggestions.length >= 12) break;
    }
    suggestions.sort((a, b) => a.priority - b.priority);
  }

  const idealisedSummary = asStr(o.idealised_summary ?? o.idealisedSummary);
  if (findings.length === 0 && suggestions.length === 0 && !idealisedSummary) return null;
  return { findings, idealisedSummary, diff, suggestions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Citation self-critique + revise (mirrors the Ask surface / value / pathway modes)
// ─────────────────────────────────────────────────────────────────────────────

export const AUDIT_CRITIQUE_SYSTEM = `You are a clinical citation + accuracy auditor reviewing a retrospective case-audit produced by an AI tool. You are given the extracted case, the NUMBERED evidence excerpts [1..n], and the draft audit JSON.

Find problems IN THE FINDINGS and SUGGESTIONS: "evidence" points NOT supported by their citation_ids; citation_ids that don't match the claim; figures/general-knowledge assertions mis-filed as evidence instead of estimates; an important low-value/over-use issue or safety caveat a physician would expect that the audit missed (e.g. a multi-day stay or prolonged IV antibiotics for a day-care-eligible procedure). The draft has no completeness list — documentation completeness is checked elsewhere, so do not look for it.

Output ONLY JSON:
{"unsupported_evidence":["…"],"wrong_or_missing_citations":["…"],"misfiled_estimates":["…"],"missing_caveats":["…"],"needs_revision":true|false,"severity":"none|minor|moderate|major"}

Empty arrays are fine. needs_revision=true if any array is non-empty.`;

export const AUDIT_REVISE_SYSTEM = `You are revising your own case-audit based on a citation auditor's critique. You receive the extracted case, the NUMBERED excerpts [1..n], your earlier draft JSON, and the critique JSON.

The NUMBERED excerpts may now be BROADER than the draft was written against — evidence was retrieved per finding, so an excerpt that truly backs a claim may appear here even if the draft never cited it. Re-cite every finding against THIS full excerpt set.

CITATION DISCIPLINE (decisive): a finding may cite an excerpt ONLY when that excerpt's text actually supports the claim carrying the citation. If NO excerpt supports a claim, leave that finding's "citation_ids" EMPTY and move the unsupported point into "estimates" (marked "est.") — never attach a merely same-topic or adjacent excerpt to make a claim look grounded. An empty citation_ids with the reasoning in estimates is the CORRECT output for a claim the corpus does not cover.

Rewrite to fix every issue: move unsupported claims out of finding "evidence" (into "estimates" if still worth saying, else drop), correct each finding's citation_ids so it cites only excerpts that truly support it, add any missing low-value/safety finding or caveat. Keep the EXACT same JSON schema as the draft (completeness, findings with citation_ids, idealised_summary, diff, suggestions). Output ONLY the corrected JSON, no prose.`;

export function buildAuditCritiqueUser(caseSummary: string, citedContext: string, draftJson: string): string {
  return `Extracted case:\n${caseSummary.trim()}\n\nNUMBERED EVIDENCE EXCERPTS:\n${citedContext.trim() || '(none)'}\n\nDraft audit JSON to audit:\n${draftJson}\n\nOutput the JSON critique now.`;
}

export function buildAuditReviseUser(caseSummary: string, citedContext: string, draftJson: string, critiqueJson: string): string {
  return `Extracted case:\n${caseSummary.trim()}\n\nNUMBERED EVIDENCE EXCERPTS:\n${citedContext.trim() || '(none)'}\n\nEarlier draft JSON:\n${draftJson}\n\nAuditor critique JSON:\n${critiqueJson}\n\nOutput the corrected audit JSON now.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-finding evidence enrichment (IPD citation fix, PRD CDMSS-IPD-CITATION-FIX)
//
// The analyze pass runs ONE pooled document-level retrieval; on a multi-problem discharge
// summary those 8 hits are a centroid smear that can't back every finding (measured: IPD
// citation-support 0.05 vs OPD 0.74 — the defect scales with document breadth). These PURE
// helpers let the orchestrator retrieve PER FINDING and fold the hits into ONE shared
// numbering space so the re-cite pass has the right evidence to attach. Retrieval itself is
// done by the wired layer (local, reranker-off) — this core only builds queries and unions.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the enrichment retrieval query for one finding: its subject + its grounded evidence
 * points + its rationale (the claim text), joined and length-bounded. Pure string assembly.
 */
export function enrichQueryForFinding(f: Pick<AuditFinding, 'subject' | 'evidence' | 'rationale'>): string {
  return [f.subject, ...(Array.isArray(f.evidence) ? f.evidence : []), f.rationale ?? '']
    .map((s) => String(s ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('. ')
    .slice(0, 500);
}

/**
 * Fold per-finding enrichment hits into the document-level pool as ONE numbering space.
 *
 * The base pool is kept as an IDENTITY PREFIX — base[i] stays at index i — so a draft citation
 * [1..base.length] still points to the SAME chunk after enrichment and needs no remap; enrichment
 * only APPENDS previously-unseen chunks. Dedupe is by chunk id across base + every enrichment group.
 * Deterministic: base order first, then the enrichment groups in the order given. Caps total at `cap`
 * (base is always retained in full; the cap bounds only how many net-new chunks are appended).
 */
export function unionEnrichedHits(base: CiteHit[], enrichment: CiteHit[][], cap = 20): CiteHit[] {
  const out: CiteHit[] = [];
  const seen = new Set<string>();
  // Key by String(id): the DB layer (Neon) returns bigint chunk ids as STRINGS, not numbers, so a
  // `typeof id === 'number'` guard would reject every hit and empty the pool. Accept number|string.
  const add = (h: CiteHit | undefined): boolean => {
    if (h == null) return false;
    const key = String(h.id ?? '');
    if (!key || seen.has(key)) return false;
    seen.add(key); out.push(h); return true;
  };
  for (const h of base) add(h);                       // identity prefix — always kept
  for (const group of enrichment) {
    if (!Array.isArray(group)) continue;
    for (const h of group) { if (out.length >= cap) return out; add(h); }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-engine citation gate (Brainstem PR5, dark behind DOC_AUDIT_CITE_GATE)
//
// The wired layer verifies each (finding, cited source) with the PR0 Flash critic and passes the
// (findingIndex, citationId) pairs that the critic judged UNsupported (not_supported / contradicts).
// This PURE function applies the gate: strip those citation ids, and when a finding loses ALL of its
// citations, relabel its now-ungrounded `evidence` into `estimates` (cite-or-label — an evidence
// point with no surviving citation is a model assertion, not corpus-grounded). direct/partial/
// not_assessable are kept upstream, so this only ever removes ids the critic actively rejected.
// ─────────────────────────────────────────────────────────────────────────────

export function applyCitationGate(
  findings: AuditFinding[],
  dropPairs: Array<[number, number]>,
): { findings: AuditFinding[]; nDropped: number; nRelabeled: number } {
  const dropsByFinding = new Map<number, Set<number>>();
  for (const [fi, cid] of dropPairs) {
    if (!dropsByFinding.has(fi)) dropsByFinding.set(fi, new Set());
    dropsByFinding.get(fi)!.add(cid);
  }
  let nDropped = 0, nRelabeled = 0;
  const out = findings.map((f, fi) => {
    const drops = dropsByFinding.get(fi);
    if (!drops || !drops.size) return f;
    const kept = f.citation_ids.filter((c) => !drops.has(c));
    const removed = f.citation_ids.length - kept.length;
    if (removed === 0) return f;
    nDropped += removed;
    // All citations rejected AND the finding had grounded evidence → its evidence is no longer
    // corpus-backed: move it to estimates (verbatim), empty citations. A PARTIAL drop keeps the
    // evidence with its surviving citations (citation_ids are finding-level, not per-evidence-point).
    if (kept.length === 0 && f.citation_ids.length > 0 && f.evidence.length > 0) {
      nRelabeled++;
      return { ...f, citation_ids: [], evidence: [], estimates: [...f.estimates, ...f.evidence] };
    }
    return { ...f, citation_ids: kept };
  });
  return { findings: out, nDropped, nRelabeled };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic completeness scoring (merge LLM statuses with the rubric)
// ─────────────────────────────────────────────────────────────────────────────

export function assembleCompleteness(
  rawStatuses: { key: string; status: FieldStatus; note: string }[],
  fields: RubricField[],
): CompletenessReport {
  const byKey = new Map<string, { status: FieldStatus; note: string }>();
  for (const r of rawStatuses) byKey.set(r.key, { status: r.status, note: r.note });

  const items: CompletenessItem[] = fields.map((f) => {
    const r = byKey.get(f.key);
    const status: FieldStatus = r ? r.status : 'missing';
    return { key: f.key, label: f.label, section: f.section, ref: f.ref, status, mandatory: f.mandatory, note: r?.note || undefined };
  });

  // Denominator: mandatory, non-conditional fields. (Conditional fields only count if the
  // model judged them applicable, i.e. present/partial.)
  const counted = fields.filter((f) => f.mandatory && !f.cond);
  const mandatoryTotal = counted.length;
  let mandatoryMet = 0;
  const missingMandatory: string[] = [];
  for (const f of counted) {
    const st = byKey.get(f.key)?.status ?? 'missing';
    if (st === 'present' || st === 'na') mandatoryMet += 1;
    else if (st === 'partial') mandatoryMet += 0.5;
    else missingMandatory.push(f.label);
  }
  // Conditional mandatory fields the model marked present/partial also count (both num + denom).
  let condTotal = 0, condMet = 0;
  for (const f of fields.filter((f) => f.mandatory && f.cond)) {
    const st = byKey.get(f.key)?.status;
    if (st === 'present' || st === 'partial' || st === 'missing') {
      condTotal += 1;
      if (st === 'present') condMet += 1; else if (st === 'partial') condMet += 0.5; else missingMandatory.push(f.label);
    }
  }
  const total = mandatoryTotal + condTotal;
  const met = mandatoryMet + condMet;
  const coverage = total > 0 ? Math.round((met / total) * 100) / 100 : 0;
  return { items, coverage, mandatoryTotal: total, mandatoryMet: Math.round(met * 10) / 10, missingMandatory };
}
