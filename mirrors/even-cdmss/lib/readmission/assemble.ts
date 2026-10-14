/**
 * lib/readmission/assemble.ts — the SINGLE de-identification choke point (PRD §8b,
 * decision 15) + model-input assembly for the readmission agent.
 *
 * HARD REQUIREMENT: PHI flows to Vertex under the BAA + Tokyo residency, but the
 * model sees only DE-IDENTIFIED content. Patient name and UHID are stripped HERE,
 * before anything reaches a prompt builder. The UHID/encounter id stays on the
 * finding ROW (Phase-2 surface join-back) but is never in the evidence catalog.
 * Doctor names are staff data and may be retained.
 *
 * Everything in this file is pure string/structure work (no DB, no model) so the
 * PHI scrub is inspectable; run.ts wires the fetches around it.
 */

import type {
  EvidenceCatalog, EvidenceItem, LabTimingProfile, LabTier, LabSourceProvenance,
} from '../readmission-reconcile-core';
import { labTimingProfile, labAbnormal, canonicalAnalyte, canonicalAnalyteFor, refRangeDisplay, resolveLabTier } from '../readmission-reconcile-core';
import type { SummaryRecord, LabRow, StructuredLabRow } from './db13';
import type { ExtractedCase } from '../doc-audit-core';

// ── de-identification ───────────────────────────────────────────────────────────

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Scrub every known identity token (patient full name, its parts ≥3 chars, UHIDs)
 * from a text. Case-insensitive. Never touches doctor names (staff data, §8b).
 */
export function deidText(text: string, identity: { names?: Array<string | null | undefined>; uhids?: Array<string | null | undefined> }): string {
  let out = text;
  const nameTokens = new Set<string>();
  for (const n of identity.names ?? []) {
    if (!n) continue;
    const full = n.trim();
    if (full.length >= 3) nameTokens.add(full);
    for (const part of full.split(/\s+/)) if (part.length >= 3) nameTokens.add(part);
  }
  // Longest first so the full name is replaced before its parts fragment it.
  for (const t of Array.from(nameTokens).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRe(t), 'gi'), '[PATIENT]');
  }
  for (const u of identity.uhids ?? []) {
    if (u && u.trim().length >= 3) out = out.replace(new RegExp(escapeRe(u.trim()), 'gi'), '[UHID]');
  }
  return out;
}

// ── summary-text assembly (tolerant of the unvalidated column shape) ────────────

/** Keys that must NEVER contribute text to a prompt — identity/contact fields. */
const PHI_KEY_RE = /(patient_name|^name$|uhid|mobile|phone|contact|address|email|dob|date_of_birth|birth|aadhaar|aadhar|pan_|passport|mrn|guardian|relative|kin)/i;

/** Preferred clinical-content columns, tried FIRST (all INFERRED — see build report). */
const SUMMARY_TEXT_CANDIDATES = [
  'discharge_summary', 'summary', 'clinical_summary', 'summary_text', 'discharge_summary_text',
  'course_in_hospital', 'hospital_course', 'diagnosis', 'final_diagnosis', 'chief_complaints',
  'history_of_present_illness', 'investigations', 'treatment_given', 'condition_at_discharge',
  'discharge_advice', 'discharge_medications', 'follow_up_advice', 'procedure_details',
];

const stripHtml = (t: string) => t.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Build the de-identified summary text from a SELECT * row. Preferred columns are
 * concatenated when present; otherwise any long text field whose KEY is not
 * identity-shaped contributes (labelled), so a wrongly-guessed column name costs
 * nothing. Returns null when no clinical text is found → the pair is NOT AUDITED.
 */
export function buildSummaryText(rec: SummaryRecord, identity: { names: Array<string | null | undefined>; uhids: Array<string | null | undefined> }): string | null {
  const parts: string[] = [];
  const used = new Set<string>();
  for (const key of SUMMARY_TEXT_CANDIDATES) {
    const v = rec.raw[key];
    if (typeof v === 'string' && v.trim().length > 0) {
      parts.push(`${key.replace(/_/g, ' ')}: ${stripHtml(v)}`);
      used.add(key);
    }
  }
  if (!parts.length) {
    for (const [key, v] of Object.entries(rec.raw)) {
      if (used.has(key) || PHI_KEY_RE.test(key)) continue;
      if (typeof v === 'string' && stripHtml(v).length >= 80) {
        parts.push(`${key.replace(/_/g, ' ')}: ${stripHtml(v)}`);
      }
    }
  }
  if (!parts.length) return null;
  return deidText(parts.join('\n'), identity);
}

/** Split a de-identified summary into citable sentences (caps keep prompts bounded). */
export function splitSentences(text: string, maxSentences = 120, maxLen = 400): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9(])/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 8)
    .slice(0, maxSentences)
    .map((x) => (x.length > maxLen ? `${x.slice(0, maxLen)}…` : x));
}

// ── evidence-catalog assembly ───────────────────────────────────────────────────

export interface AssembledInputs {
  catalog: EvidenceCatalog;
  labProfile: LabTimingProfile;
  indexSentenceCount: number;
  readmitSentenceCount: number;
}

const H = 3_600_000;
const parseTs = (x: string | null | undefined): number | null => {
  if (!x) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(x) ? x.replace(' ', 'T') : x);
  return Number.isFinite(t) ? t : null;
};

function labItems(labs: LabRow[], side: 'index' | 'readmit', prefix: string, filter: (t: number | null) => boolean): EvidenceItem[] {
  return labs
    .filter((l) => filter(parseTs(l.at)))
    .slice(0, 80)
    .map((l, i) => ({
      id: `${prefix}${i + 1}`,
      source: 'lab' as const,
      side,
      at: l.at,
      analyte: l.analyte,
      abnormal: l.abnormal,
      text: `${l.testName}: ${l.valueText ?? l.value ?? '?'}${l.unit ? ` ${l.unit}` : ''}${l.refRange ? ` (ref ${l.refRange})` : ''}${l.at ? ` @ ${l.at}` : ''}`,
    }));
}

/**
 * Assemble the de-identified evidence catalog for one pair (or one out-of-network
 * index side, where readmit inputs are absent). Inputs per PRD §5: index trailing
 * labs = final 48h before discharge, readmit early labs = first 24h after admit;
 * labs outside those windows still inform the timing profile and bundle signal, so
 * they are kept, timing-marked, rather than silently dropped.
 */
export function assembleInputs(args: {
  indexSummaryText: string;
  readmitSummaryText?: string | null;
  indexLabs: LabRow[];
  readmitLabs?: LabRow[];
  indexAdmitAt: string | null;
  indexDischargeAt: string | null;
  readmitAdmitAt?: string | null;
  cmNote?: string | null;
  structuredFacts?: string[];
  identity: { names: Array<string | null | undefined>; uhids: Array<string | null | undefined> };
}): AssembledInputs {
  const items: EvidenceItem[] = [];

  const idxSentences = splitSentences(args.indexSummaryText);
  idxSentences.forEach((t, i) => items.push({ id: `S${i + 1}`, source: 'index_summary', side: 'index', text: t }));

  const rdSentences = args.readmitSummaryText ? splitSentences(args.readmitSummaryText) : [];
  rdSentences.forEach((t, i) => items.push({ id: `R${i + 1}`, source: 'readmit_summary', side: 'readmit', text: t }));

  const disch = parseTs(args.indexDischargeAt);
  const rdAdmit = parseTs(args.readmitAdmitAt);
  // Index labs: prefer the trailing 48h; keep the rest (timing profile needs them all).
  items.push(...labItems(args.indexLabs, 'index', 'L',
    (t) => disch == null || t == null || (t <= disch && t >= disch - 48 * H)));
  const trailingIds = new Set(items.filter((i) => i.source === 'lab' && i.side === 'index').map((i) => i.id));
  if (trailingIds.size < Math.min(args.indexLabs.length, 80)) {
    items.push(...labItems(args.indexLabs, 'index', 'LX',
      (t) => !(disch == null || t == null || (t <= disch && t >= disch - 48 * H))));
  }
  if (args.readmitLabs?.length) {
    items.push(...labItems(args.readmitLabs, 'readmit', 'M',
      (t) => rdAdmit == null || t == null || (t >= rdAdmit && t <= rdAdmit + 24 * H)));
  }

  (args.structuredFacts ?? []).forEach((t, i) => items.push({ id: `T${i + 1}`, source: 'adt', text: t }));

  if (args.cmNote && args.cmNote.trim()) {
    items.push({ id: 'F1', source: 'cm_form', text: deidText(args.cmNote.trim().slice(0, 1200), args.identity) });
  }

  const labProfile = labTimingProfile(args.indexLabs, args.indexAdmitAt, args.indexDischargeAt);
  return { catalog: { items }, labProfile, indexSentenceCount: idxSentences.length, readmitSentenceCount: rdSentences.length };
}

// ═══ Phase 1.5 — the three-source substrate (addendum §2/§3) ═══════════════════
//
// Source 1: the index ExtractedCase (the discharge PDF, read by lib/doc-audit).
// Source 2: the readmit ExtractedCase — a DIFFERENT author's account of what happened
//           after the index discharge. Absent for out-of-network pairs (decision 13).
// Source 3: structured LOINC-coded lab values for the patient, windowed to the index
//           stay. The genuinely disinterested numeric source.
//
// This function remains the SINGLE PHI choke point. The ExtractedCase is already
// de-identified by construction (the extractor never emits name or UHID, and rawNotes
// is de-identified), but every string that leaves here is put through deidText anyway:
// a second scrub costs nothing and means the guarantee does not depend on the
// extractor's prompt continuing to behave.

/** How each case reached us — carried onto the finding for the reviewer. */
export type CaseSource = 'store' | 'fresh_extract' | null;

/** The de-identified narrative lines an ExtractedCase contributes, in reading order. */
export function extractedCaseLines(ec: ExtractedCase): string[] {
  const lines: string[] = [];
  const add = (label: string, v: string | null | undefined) => {
    if (v && String(v).trim()) lines.push(`${label}: ${String(v).trim()}`);
  };
  const addList = (label: string, xs: string[] | undefined) => {
    const clean = (xs ?? []).map((x) => String(x).trim()).filter(Boolean);
    if (clean.length) lines.push(`${label}: ${clean.join('; ')}`);
  };
  add('diagnosis', ec.diagnosis);
  add('indication', ec.indication);
  add('procedure', ec.procedure);
  addList('investigations', ec.investigations);
  addList('treatments', ec.treatments);
  addList('medications', ec.medications);
  addList('risk factors', ec.riskFactors);
  add('course in hospital', ec.courseSummary);
  add('condition at discharge', ec.disposition);
  add('follow up', ec.followUp);
  addList('aftercare instructions', ec.aftercare?.instructions);
  addList('warning signs given', ec.aftercare?.warning_signs);
  add('follow-up detail', ec.aftercare?.follow_up_detail);
  if (ec.adminFacts?.lengthOfStayDays != null) lines.push(`length of stay: ${ec.adminFacts.lengthOfStayDays} days`);
  if (ec.adminFacts?.careSetting) lines.push(`care setting: ${ec.adminFacts.careSetting}`);
  return lines;
}

/** Citable, de-identified sentences from one ExtractedCase. */
export function extractedCaseSentences(
  ec: ExtractedCase,
  identity: { names: Array<string | null | undefined>; uhids: Array<string | null | undefined> },
): string[] {
  const lines = extractedCaseLines(ec);
  if (!lines.length) return [];
  return splitSentences(deidText(lines.join('\n'), identity));
}

/**
 * Tier-2 labs: the investigations the DOCTOR wrote, parsed for a number and a range
 * where one is written inline ("Potassium 2.9 (3.5-5.1)"). Tolerant by design — an
 * unparseable line still contributes its text as evidence, it just carries no number.
 */
export function caseLabItems(
  ec: ExtractedCase | null,
  side: 'index' | 'readmit',
  prefix: string,
  identity: { names: Array<string | null | undefined>; uhids: Array<string | null | undefined> },
): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  for (const [i, raw] of (ec?.investigations ?? []).slice(0, 60).entries()) {
    const text = deidText(String(raw).trim(), identity);
    if (!text) continue;
    const name = text.split(/[:=]/)[0]?.trim() ?? text;
    const numMatch = text.match(/(-?\d+(?:\.\d+)?)/);
    const value = numMatch ? Number(numMatch[1]) : null;
    const rangeMatch = text.match(/(-?\d+(?:\.\d+)?\s*(?:-|–|to)\s*-?\d+(?:\.\d+)?)/g);
    // The FIRST number is the result; a range needs two numbers, so a lone value never
    // becomes its own reference range.
    const refRange = rangeMatch && rangeMatch.length ? rangeMatch[rangeMatch.length - 1] : null;
    out.push({
      id: `${prefix}${i + 1}`,
      source: 'lab',
      side,
      text,
      analyte: canonicalAnalyte(name),
      value: Number.isFinite(value as number) ? value : null,
      refRange,
      abnormal: labAbnormal(Number.isFinite(value as number) ? value : null, null, refRange),
      labProvenance: 'extracted_case',
      at: null,
    });
  }
  return out;
}

/**
 * Structured labs → evidence. Abnormality comes from the value vs its OWN range, read
 * out of the {h, l, t, s} object db13 stores (parseRefRange). The analyte is resolved
 * NAME-first: loinc_id is effectively absent in db13 (validated live 6 Aug 2026).
 */
export function structuredLabItems(labs: StructuredLabRow[], identity: { names: Array<string | null | undefined>; uhids: Array<string | null | undefined> }): EvidenceItem[] {
  return labs.slice(0, 120).map((l) => ({
    id: l.id,
    source: 'lab' as const,
    side: 'index' as const,
    at: l.at,
    analyte: canonicalAnalyteFor(l.loincId, l.name),
    // normalised_data_value is CARRIED but never decides: its semantics are not
    // documented anywhere we can check, and an abnormality flag guessed from an
    // unknown scale is exactly the kind of wrong number this audit must not invent.
    abnormal: labAbnormal(l.value, null, l.refRange),
    value: l.value,
    refRange: l.refRange,
    labProvenance: 'structured' as const,
    text: deidText(
      `${l.name ?? l.loincId ?? 'analyte'}: ${l.valueText ?? l.value ?? '?'}${l.unit ? ` ${l.unit}` : ''}`
      // The lab's OWN wording of the range (the object's `t`), not our reconstruction of
      // it — `t` carries units and qualifiers that bare bounds would drop.
      + `${refRangeDisplay(l.refRange) ? ` (ref ${refRangeDisplay(l.refRange)})` : ''}`
      + `${l.loincId ? ` [LOINC ${l.loincId}]` : ''}${l.at ? ` @ ${l.at}` : ''}`,
      identity,
    ),
  }));
}

export interface ThreeSourceInputs {
  catalog: EvidenceCatalog;
  labProfile: LabTimingProfile;
  labTier: LabTier;
  labSourceProvenance: LabSourceProvenance;
  notAuditableReason?: string;
  indexSentenceCount: number;
  readmitSentenceCount: number;
}

/**
 * Assemble one pair's de-identified evidence catalog from the three sources and decide
 * its coverage tier. Tier 3 (no index case) is returned with its reason rather than
 * thrown — the caller writes 'not_auditable' and stops.
 */
export function assembleThreeSource(args: {
  indexCase: ExtractedCase | null;
  readmitCase: ExtractedCase | null;
  structuredLabs: StructuredLabRow[];
  indexAdmitAt: string | null;
  indexDischargeAt: string | null;
  readmitAdmitAt?: string | null;
  cmNote?: string | null;
  structuredFacts?: string[];
  identity: { names: Array<string | null | undefined>; uhids: Array<string | null | undefined> };
  labWindow: { from: string; to: string } | null;
  windowStartInferred?: boolean;
  caseSources: { index: CaseSource; readmit: CaseSource };
  documentIds: { index: string | null; readmit: string | null };
  extractionVersion: string;
}): ThreeSourceInputs {
  const items: EvidenceItem[] = [];

  const idxSentences = args.indexCase ? extractedCaseSentences(args.indexCase, args.identity) : [];
  idxSentences.forEach((t, i) => items.push({ id: `S${i + 1}`, source: 'index_summary', side: 'index', text: t }));

  const rdSentences = args.readmitCase ? extractedCaseSentences(args.readmitCase, args.identity) : [];
  rdSentences.forEach((t, i) => items.push({ id: `R${i + 1}`, source: 'readmit_summary', side: 'readmit', text: t }));

  // Source 3 first — a structured value outranks the doctor's transcription of one.
  const structured = structuredLabItems(args.structuredLabs, args.identity);
  items.push(...structured);

  const { tier, notAuditableReason } = resolveLabTier({
    hasIndexCase: !!args.indexCase,
    structuredLabsInWindow: structured.length,
  });

  // Tier 2 substrate: the labs as written, on BOTH sides — the readmit side is what
  // makes the same-condition bundle test possible without structured values.
  const caseLabs = tier === 'tier2'
    ? [...caseLabItems(args.indexCase, 'index', 'IX', args.identity),
       ...caseLabItems(args.readmitCase, 'readmit', 'RX', args.identity)]
    : [];
  items.push(...caseLabs);

  (args.structuredFacts ?? []).forEach((t, i) => items.push({ id: `T${i + 1}`, source: 'adt', text: t }));
  if (args.cmNote && args.cmNote.trim()) {
    items.push({ id: 'F1', source: 'cm_form', text: deidText(args.cmNote.trim().slice(0, 1200), args.identity) });
  }

  // The §8c.3 timing profile is a fact about the STRUCTURED values: case labs carry no
  // timestamp, so including them would silently turn "admission only" into "no labs".
  const labProfile = labTimingProfile(
    args.structuredLabs.map((l) => ({ at: l.at })), args.indexAdmitAt, args.indexDischargeAt,
  );

  return {
    catalog: { items },
    labProfile,
    labTier: tier,
    ...(notAuditableReason ? { notAuditableReason } : {}),
    labSourceProvenance: {
      tier,
      structuredLabCount: structured.length,
      window: args.labWindow,
      ...(args.windowStartInferred ? { windowStartInferred: true } : {}),
      caseLabCount: caseLabs.length,
      indexCase: args.caseSources.index,
      readmitCase: args.caseSources.readmit,
      extractionVersion: args.extractionVersion,
      indexDocumentId: args.documentIds.index,
      readmitDocumentId: args.documentIds.readmit,
    },
    indexSentenceCount: idxSentences.length,
    readmitSentenceCount: rdSentences.length,
  };
}
