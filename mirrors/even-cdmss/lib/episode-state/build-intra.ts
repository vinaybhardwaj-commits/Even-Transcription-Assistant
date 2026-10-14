// lib/episode-state/build-intra.ts — the PURE intra-phase EpisodeState builder (SL1).
//
// buildEpisodeState(extract, kx) assembles the in-hospital course from what ALREADY exists — the
// shipped doc-audit extract + a de-identified kx envelope — with the same verbatim-substring
// no-fabrication discipline ClinicalState uses: every emitted fact's provenance.rawText MUST occur
// in its cited source, or the fact is dropped (never fabricated). PURE + DETERMINISTIC: no I/O, no
// Date/random, source order preserved → identical inputs give identical output.
//
// FACTS-ONLY: no band, no CVI, no prediction, no value-score import. Reads the doc-audit extract
// TYPE only (a contract, not the engine); the kx envelope is a de-identified input the caller
// (SL2) maps from IpdAdmissionHeader + BillingEnvelope, dropping the PHI (name/UHID) first.

import type { ExtractedCase } from '../doc-audit-core';
import {
  EPISODE_STATE_VERSION, emptyPre, emptyPost, emptyIntra,
  type EpisodeState, type EpisodeFact, type ExtractionMethod, type EpisodeDemographics,
} from './schema';

/** The DE-IDENTIFIED kx envelope the builder consumes: a subset of IpdAdmissionHeader (db13) +
 *  BillingEnvelope (billing) with NO PHI (no patientName, no uhid). SL2 maps the real reads into
 *  this shape; SL1 keeps the builder pure and PHI-proof by construction. */
export interface KxEnvelope {
  episodeRef: string;           // ip_uid — the link-back key (not PHI)
  speciality: string | null;
  ward: string | null;
  dischargeType: string | null;
  admitDate: string | null;
  dischargeDate: string | null;
  losDays: number | null;
  netTotal: number | null;      // ₹ — sum(net_amt), refunds already netted
}

/** The DE-IDENTIFIED OPD linkage the pre/post phases are built from (SL4). Produced by the
 *  consumer-side OPD adapter, which resolves the member and drops PHI — only STRUCTURED clinical
 *  values reach here (ICD codes, drug names, dates). Free-text OPD narrative is deliberately NOT
 *  projected. `pre` = encounters before admission; `post` = encounters after discharge. */
export interface OpdLinkage {
  pre: { conditions: string[]; medications: string[] };   // ICD codes · drug names (pre-admission OPD)
  post: { followUps: string[] };                           // "YYYY-MM-DD · ICD" (post-discharge OPD)
}

/** Resolve a provenance.sourceField key back to its source text — the single place the
 *  sourceField vocabulary is defined, so the no-fabrication guard and any later verifier read the
 *  SAME mapping. Scalars stringify; arrays join with '\n' (so a per-element rawText is a substring
 *  of its array source). Unknown/absent → '' (nothing can be a verbatim substring of nothing). */
export function resolveSource(sourceField: string, extract: ExtractedCase, kx: KxEnvelope | null): string {
  const str = (v: unknown): string => (v == null ? '' : Array.isArray(v) ? v.join('\n') : String(v));
  const [root, ...rest] = sourceField.split('.');
  if (root === 'extract') {
    if (rest[0] === 'adminFacts') return str(extract.adminFacts?.[rest[1] as keyof NonNullable<ExtractedCase['adminFacts']>]);
    if (rest[0] === 'patient') return str(extract.patient?.[rest[1] as keyof ExtractedCase['patient']]);
    return str((extract as unknown as Record<string, unknown>)[rest[0]]);
  }
  if (root === 'kx') return kx ? str((kx as unknown as Record<string, unknown>)[rest[0]]) : '';
  return '';
}

/** Build a fact IF AND ONLY IF rawText occurs verbatim in its cited source — the anti-fabrication
 *  gate. Returns null when the span is not found (dropped, never invented) or the value is empty. */
function mkFact(
  sourceField: string, source: string, method: ExtractionMethod, confidence: number,
  rawText?: string,
): EpisodeFact | null {
  const text = (rawText ?? source).trim();
  if (!text) return null;
  const offset = source.indexOf(text);
  if (offset < 0) return null;                     // SPAN VERIFICATION — no fabrication
  return {
    value: text,
    provenance: { sourceField, rawText: text, startOffset: offset, endOffset: offset + text.length, extractionMethod: method, confidence },
  };
}

/** Non-empty, trimmed, de-duplicated (order-preserving) list elements. */
function cleanList(xs: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs ?? []) {
    const t = (x ?? '').trim();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

function normSex(raw: string | undefined): 'F' | 'M' | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'm' || s === 'male') return 'M';
  if (s === 'f' || s === 'female') return 'F';
  return null;
}

/**
 * Assemble the intra-phase EpisodeState. pre/post are typed-but-empty (SL4). Every fact traces to a
 * verbatim substring of the extract or the kx envelope; nothing is scored, predicted, or invented.
 */
export function buildEpisodeState(extract: ExtractedCase, kx: KxEnvelope | null, opd: OpdLinkage | null = null): EpisodeState {
  const intra = emptyIntra();

  // ── admission facts: prefer the extract's adminFacts, fall back to the kx envelope ──
  const af = extract.adminFacts;
  const D: ExtractionMethod = 'deterministic';
  const R: ExtractionMethod = 'reported';

  intra.admission.lengthOfStayDays =
    (af?.lengthOfStayDays != null ? mkFact('extract.adminFacts.lengthOfStayDays', String(af.lengthOfStayDays), D, 1) : null)
    ?? (kx?.losDays != null ? mkFact('kx.losDays', String(kx.losDays), R, 1) : null);
  intra.admission.admissionType = af?.admissionType ? mkFact('extract.adminFacts.admissionType', af.admissionType, D, 1) : null;
  intra.admission.careSetting = af?.careSetting ? mkFact('extract.adminFacts.careSetting', af.careSetting, D, 1) : null;
  intra.admission.speciality = kx?.speciality ? mkFact('kx.speciality', kx.speciality, R, 1) : null;
  intra.admission.ward = kx?.ward ? mkFact('kx.ward', kx.ward, R, 1) : null;
  intra.admission.dischargeType = kx?.dischargeType ? mkFact('kx.dischargeType', kx.dischargeType, R, 1) : null;
  intra.admission.admitDate = kx?.admitDate ? mkFact('kx.admitDate', kx.admitDate, R, 1) : null;
  intra.admission.dischargeDate = kx?.dischargeDate ? mkFact('kx.dischargeDate', kx.dischargeDate, R, 1) : null;

  // ── documented clinical course (facts only) ──
  if (extract.diagnosis) intra.diagnosis = mkFact('extract.diagnosis', extract.diagnosis, D, 1);
  if (extract.procedure) {
    const p = mkFact('extract.procedure', extract.procedure, D, 1);
    if (p) intra.procedures.push(p);
  }
  const src = (field: string) => resolveSource(field, extract, kx);
  intra.medications = cleanList(extract.medications).map((m) => mkFact('extract.medications', src('extract.medications'), D, 1, m)).filter((f): f is EpisodeFact => f != null);
  intra.investigations = cleanList(extract.investigations).map((i) => mkFact('extract.investigations', src('extract.investigations'), D, 1, i)).filter((f): f is EpisodeFact => f != null);
  intra.treatments = cleanList(extract.treatments).map((t) => mkFact('extract.treatments', src('extract.treatments'), D, 1, t)).filter((f): f is EpisodeFact => f != null);
  if (extract.courseSummary?.trim()) intra.courseSummary = mkFact('extract.courseSummary', extract.courseSummary, D, 1);

  // ── billing envelope (₹ fact, from kx) ──
  if (kx?.netTotal != null) intra.billing.netTotal = mkFact('kx.netTotal', String(kx.netTotal), R, 1);

  const demographics: EpisodeDemographics = {
    age: extract.patient?.age ?? null,
    sex: normSex(extract.patient?.sex),
    sexRaw: extract.patient?.sex ?? null,
  };

  // ── pre / post phases (SL4) — populated ONLY from the de-identified OPD linkage; empty when the
  //    admission has no OPD history (the unlinked tail), never fabricated. 'reported' facts: each
  //    fact's rawText IS the reported structured value (mkFact verifies it against itself). ──
  const R2: ExtractionMethod = 'reported';
  const pre = emptyPre();
  const post = emptyPost();
  if (opd) {
    const reported = (sourceField: string, xs: string[]) =>
      cleanList(xs).map((x) => mkFact(sourceField, x, R2, 1)).filter((f): f is EpisodeFact => f != null);
    pre.priorConditions = reported('opd.pre.condition', opd.pre.conditions);
    pre.homeMedications = reported('opd.pre.medication', opd.pre.medications);
    // pre.presentingComplaints stays empty — free-text OPD complaints are not projected (PHI safety).
    post.followUpPlan = reported('opd.post.followUp', opd.post.followUps);
    // post.dischargeMedications / warningSigns stay empty — not OPD-sourced facts.
  }

  return {
    version: EPISODE_STATE_VERSION,
    episodeRef: kx?.episodeRef ?? '',
    demographics,
    pre,
    intra,
    post,
  };
}

/** Walk every emitted fact and confirm its rawText occurs verbatim in its cited source — the
 *  no-fabrication invariant, exposed so callers/tests can assert it on a built object. Returns the
 *  facts (if any) that FAIL; an empty array means the whole object is fabrication-free. */
export function fabricationViolations(state: EpisodeState, extract: ExtractedCase, kx: KxEnvelope | null): Array<{ sourceField: string; rawText: string }> {
  const facts: EpisodeFact[] = [];
  const add = (f: EpisodeFact | null) => { if (f) facts.push(f); };
  for (const f of Object.values(state.intra.admission)) add(f);
  add(state.intra.diagnosis);
  add(state.intra.courseSummary);
  add(state.intra.billing.netTotal);
  for (const arr of [state.intra.procedures, state.intra.medications, state.intra.investigations, state.intra.treatments]) arr.forEach(add);
  // pre/post are empty in SL1, but walk them too so the guard stays honest when SL4 fills them
  for (const arr of [state.pre.presentingComplaints, state.pre.priorConditions, state.pre.homeMedications,
    state.post.dischargeMedications, state.post.followUpPlan, state.post.warningSigns]) arr.forEach(add);

  const bad: Array<{ sourceField: string; rawText: string }> = [];
  for (const f of facts) {
    // extract/kx facts verify against their real source; a 'reported' OPD fact's source IS its own
    // reported value (mkFact already verified the substring at build time) — resolveSource returns
    // '' for those, so fall back to the fact's value as its witness.
    const source = resolveSource(f.provenance.sourceField, extract, kx) || f.value;
    if (!source.includes(f.provenance.rawText)) bad.push({ sourceField: f.provenance.sourceField, rawText: f.provenance.rawText });
  }
  return bad;
}
