/**
 * lib/prognosis-core.ts — PX: Prognosis & Safety-Netting CORE (PRD v1.0 §6.4).
 *
 * PURE, dependency-free (no db/llm/json-import) — importable by the server
 * orchestrator (lib/doc-audit.ts) and the client renderer, and unit-testable
 * with `node --experimental-strip-types`.
 *
 * The third analytical pass of the Case Audit: models what is foreseeably going
 * to happen to THIS patient after THIS episode, and audits whether the document's
 * plan anticipates it. Three blocks: anticipated complications (cited incidence),
 * expected benefit (with a concrete failure signature), and the safety-net audit
 * (each major risk matched against the documented plan → mitigated / partially /
 * UNMITIGATED / not_assessable).
 *
 * CARDINAL FRAMING (PRD §2): this is a FORESEEABILITY AUDIT, never "prediction"
 * or a risk score. Cite-or-label discipline throughout; disclaimer baked in.
 * PHI: consumes only the de-identified extract; must never echo identifiers.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types (PRD §6.4)
// ─────────────────────────────────────────────────────────────────────────────

export type PxLikelihood = 'common' | 'uncommon' | 'rare';
export type PxSeverity = 'minor' | 'moderate' | 'serious';
export type PxNetStatus = 'mitigated' | 'partially_mitigated' | 'unmitigated' | 'not_assessable';
export type PxExpectationSetting = 'present' | 'partial' | 'absent';

export interface PxModifier { factor: string; direction: 'raises' | 'lowers' }

export interface AnticipatedComplication {
  complication: string;
  likelihood: PxLikelihood;
  incidence_note?: string;      // cited figure or explicitly "est."
  horizon?: string;             // e.g. "days 3–14"
  severity: PxSeverity;
  modifiers: PxModifier[];      // patient-specific factors present in THIS case
  evidence: string[];
  estimates: string[];
  citation_ids: number[];
}

export interface ExpectedBenefit {
  intended_benefit: string;
  time_to_benefit?: string;
  success_rate_note?: string;   // cited or est.; include recurrence where covered
  failure_signature: string;    // concrete: "what, by when, means this didn't work"
  documented_expectation_setting: PxExpectationSetting;
  evidence: string[];
  estimates: string[];
  citation_ids: number[];
}

export interface SafetyNetRow {
  risk: string;
  expected_mitigation: string;
  found_in_document: string | null;
  status: PxNetStatus;
  note?: string;
}

export interface PrognosisReport {
  version: string;              // PX_ENGINE_VERSION
  complications: AnticipatedComplication[];  // cap 8
  benefit: ExpectedBenefit | null;
  safetyNet: SafetyNetRow[];    // cap 10
  summary: string;              // one-line rollup for the section header
  n_unmitigated: number;
  n_partial: number;
  disclaimer: string;
}

export const PX_ENGINE_VERSION = 'prognosis/0.1';

export const PX_DISCLAIMER =
  'Foreseeability audit grounded in retrieved evidence — an advisory review of whether foreseeable outcomes were anticipated and safety-netted in the documented plan. Not a prediction, not a personalised risk score, and not a judgment of the clinician.';

// ─────────────────────────────────────────────────────────────────────────────
// Normalisers
// ─────────────────────────────────────────────────────────────────────────────

const LIKELIHOODS = new Set<PxLikelihood>(['common', 'uncommon', 'rare']);
const SEVERITIES = new Set<PxSeverity>(['minor', 'moderate', 'serious']);
const NET_STATUSES = new Set<PxNetStatus>(['mitigated', 'partially_mitigated', 'unmitigated', 'not_assessable']);
const EXPECT_SET = new Set<PxExpectationSetting>(['present', 'partial', 'absent']);

export function normLikelihood(v: unknown): PxLikelihood {
  const s = String(v ?? '').toLowerCase().trim();
  if (s === 'very common' || s === 'frequent' || s === 'high') return 'common';
  if (s === 'occasional' || s === 'moderate' || s === 'infrequent') return 'uncommon';
  if (s === 'very rare' || s === 'low') return 'rare';
  return LIKELIHOODS.has(s as PxLikelihood) ? (s as PxLikelihood) : 'uncommon';
}

export function normSeverity(v: unknown): PxSeverity {
  const s = String(v ?? '').toLowerCase().trim();
  if (s === 'severe' || s === 'major' || s === 'critical' || s === 'life-threatening') return 'serious';
  if (s === 'mild' || s === 'trivial') return 'minor';
  return SEVERITIES.has(s as PxSeverity) ? (s as PxSeverity) : 'moderate';
}

export function normNetStatus(v: unknown): PxNetStatus {
  const s = String(v ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (s === 'partial' || s === 'partially') return 'partially_mitigated';
  if (s === 'unaddressed' || s === 'missing' || s === 'not_mitigated' || s === 'none') return 'unmitigated';
  if (s === 'na' || s === 'n_a' || s === 'not_applicable' || s === 'not_assessible') return 'not_assessable';
  if (s === 'addressed' || s === 'covered' || s === 'present') return 'mitigated';
  return NET_STATUSES.has(s as PxNetStatus) ? (s as PxNetStatus) : 'not_assessable';
}

export function normExpectationSetting(v: unknown): PxExpectationSetting {
  const s = String(v ?? '').toLowerCase().trim();
  if (s === 'missing' || s === 'not documented' || s === 'none') return 'absent';
  if (s === 'incomplete') return 'partial';
  return EXPECT_SET.has(s as PxExpectationSetting) ? (s as PxExpectationSetting) : 'absent';
}

// Small local helpers (inlined per the repo's strip-types test convention).
function asStr(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }
function asStrArray(v: unknown, cap = 8): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).slice(0, cap);
}
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
function extractJsonObject(text: string): unknown {
  let t = (text || '').trim();
  if (!t) return null;
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

/** Per-doc-type forward lens (PRD §5.4). */
export const PX_LENS: Record<string, string> = {
  discharge_summary: `LENS (discharge summary): what can foreseeably go wrong — or fail to improve — for this patient AFTER this admission, over days to months? The safety-net surface is the discharge advice: aftercare instructions, warning signs, follow-up timing and its symptom triggers, and expectation-setting for recovery. A warning-signs list only mitigates a risk if its items actually match that risk — a generic checklist does not cover a procedure-specific complication.`,
  ot_note: `LENS (OT/operative note): what peri-operative and post-operative complications does THIS procedure with THIS intra-operative course foreseeably carry? The safety-net surface is the post-operative orders and monitoring instructions — is each anticipated complication being watched for? Patient-education items an OT note never carries must be marked not_assessable, not unmitigated.`,
  opd_rx: `LENS (OPD prescription): is THIS treatment plan plausibly going to deliver for THIS presentation, and what is the escalation path if it fails? The safety-net surface is the advice/plan lines, red-flag warnings, and the follow-up type and interval judged against the condition's natural history (e.g. failure of empirical therapy, red flags requiring earlier review).`,
};

export const PX_SYSTEM = `You are a clinical foreseeability auditor for a NABH-accredited hospital. You are given (1) a DE-IDENTIFIED extracted case from a clinical document — including the patient's stated risk factors and the plan's actual aftercare/warning-sign text — and (2) NUMBERED EVIDENCE EXCERPTS [1..n] from a medical corpus, retrieved for PROGNOSIS (complications, incidence, expected recovery, recurrence, post-procedure care).

Your job is FORWARD-LOOKING, in three parts. This is a foreseeability audit — NOT a prediction and NOT a risk score. Advisory, non-directive, never a judgment of the clinician.

1. ANTICIPATED COMPLICATIONS — the recognised, foreseeable adverse outcomes of THIS diagnosis/procedure/treatment for THIS patient (cap 8, ranked by likelihood × severity). For each: complication; likelihood ("common|uncommon|rare"); incidence_note (a CITED figure when an excerpt provides one, otherwise your estimate explicitly marked "est."); horizon (when it typically shows, e.g. "days 3–14"); severity ("minor|moderate|serious"); modifiers = patient-specific factors FROM THE EXTRACT that raise or lower this risk (facts only — never invent); evidence (grounded points, with citation_ids of supporting excerpts) vs estimates (your reasoning the excerpts don't cover). Do NOT cite an excerpt that doesn't support the claim.

2. EXPECTED BENEFIT — what this intervention exists to deliver for this patient: intended_benefit; time_to_benefit; success_rate_note (cited or est.; include recurrence rates where the excerpts cover them); failure_signature = the CONCRETE picture of non-delivery ("what, by when, means this didn't work" — e.g. persistent severe pain beyond N weeks, recurrence of prolapse); documented_expectation_setting = does the DOCUMENT set this trajectory for the patient ("present|partial|absent")?

3. SAFETY-NET AUDIT — one row per major anticipated complication (moderate/serious severity, or common likelihood) PLUS one row for the failure signature. For each: risk; expected_mitigation = what a fit plan contains for this specific risk (instruction / warning sign / follow-up trigger / prophylactic measure); found_in_document = what the document ACTUALLY says that addresses it (quote or closely paraphrase the aftercare/warning-sign text; null if nothing); status = "mitigated" (specific, matching mitigation present) | "partially_mitigated" (something relevant but incomplete or non-specific) | "unmitigated" (nothing matching) | "not_assessable" (this document type cannot be expected to carry it); note (short).
   SPECIFICITY RULE (cardinal): a mitigation counts only if it addresses the NAMED risk. A generic urgent-care checklist mitigates a specific risk only when its items match that risk. Judge fitness, not presence. Apply it fairly in both directions — a generic risk (e.g. fever) IS mitigated by a matching generic warning.
   OPERATIVE-WOUND RULE: when the episode involves a surgical/procedural wound, infection mitigation requires BOTH systemic warning signs (fever/chills) AND local wound guidance (wound care/dressing instructions and local warning signs — discharge/pus, worsening local pain or swelling). A fever warning alone is "partially_mitigated", never "mitigated".

Also produce "summary": ONE sentence for the section header (risks count, unmitigated count, benefit expectation state).

Rules: ground clinical claims in the excerpts; separate cited EVIDENCE from ESTIMATES (every uncited figure marked "est."); never phrase as blame or as denial-of-care; do not echo any identifier; if the excerpts are silent on this procedure, say so in estimates rather than inventing incidence figures.

Return ONLY JSON, no prose:
{"complications":[{"complication":"…","likelihood":"common|uncommon|rare","incidence_note":"…","horizon":"…","severity":"minor|moderate|serious","modifiers":[{"factor":"…","direction":"raises|lowers"}],"evidence":["…"],"estimates":["…"],"citation_ids":[1]}],"benefit":{"intended_benefit":"…","time_to_benefit":"…","success_rate_note":"…","failure_signature":"…","documented_expectation_setting":"present|partial|absent","evidence":["…"],"estimates":["…"],"citation_ids":[2]},"safety_net":[{"risk":"…","expected_mitigation":"…","found_in_document":"… or null","status":"mitigated|partially_mitigated|unmitigated|not_assessable","note":"…"}],"summary":"…"}`;

export interface PxCaseInput {
  docType: string;
  patientLine: string;          // "38y, male" (de-identified)
  diagnosis: string | null;
  indication: string | null;
  procedure: string | null;
  investigations: string[];
  treatments: string[];
  medications: string[];
  riskFactors: string[];
  courseSummary: string;
  disposition: string | null;
  followUp: string | null;
  aftercareInstructions: string[];
  warningSigns: string[];
  followUpDetail: string | null;
  adminFactsLine: string;       // "Stay: length of stay 1 day; elective; room" or ''
}

export function buildPxUser(c: PxCaseInput, citedContext: string): string {
  const lens = PX_LENS[c.docType] || PX_LENS.discharge_summary;
  const lines: string[] = [];
  if (c.patientLine) lines.push(`Patient: ${c.patientLine}`);
  if (c.diagnosis) lines.push(`Diagnosis: ${c.diagnosis}`);
  if (c.indication) lines.push(`Indication: ${c.indication}`);
  if (c.procedure) lines.push(`Procedure: ${c.procedure}`);
  if (c.riskFactors.length) lines.push(`Stated risk factors: ${c.riskFactors.join('; ')}`);
  if (c.investigations.length) lines.push(`Investigations: ${c.investigations.join('; ')}`);
  if (c.treatments.length) lines.push(`Treatments: ${c.treatments.join('; ')}`);
  if (c.medications.length) lines.push(`Medications: ${c.medications.join('; ')}`);
  if (c.adminFactsLine) lines.push(c.adminFactsLine);
  if (c.disposition) lines.push(`Disposition: ${c.disposition}`);
  lines.push(`Course: ${c.courseSummary}`);
  const plan: string[] = [];
  if (c.aftercareInstructions.length) plan.push(`Aftercare instructions: ${c.aftercareInstructions.join(' · ')}`);
  if (c.warningSigns.length) plan.push(`Documented warning signs ("when to obtain urgent care"): ${c.warningSigns.join(' · ')}`);
  if (c.followUpDetail || c.followUp) plan.push(`Follow-up: ${c.followUpDetail || c.followUp}`);
  if (plan.length === 0) plan.push('(no aftercare instructions, warning signs, or follow-up detail documented)');
  const ev = citedContext.trim() ? citedContext.trim() : '(no excerpts retrieved — leave citation_ids empty; put reasoning in estimates and mark every figure "est.")';
  return `Document type: ${c.docType}\n${lens}\n\nEXTRACTED CASE:\n${lines.join('\n')}\n\nTHE DOCUMENTED PLAN (the safety-net surface to audit):\n${plan.join('\n')}\n\nNUMBERED EVIDENCE EXCERPTS (prognosis retrieval):\n${ev}`;
}

// ── Critique (hunts a MISSED well-known complication + cite-or-label violations) ──

export const PX_CRITIQUE_SYSTEM = `You are auditing a clinical FORESEEABILITY report produced by an AI tool (anticipated complications, expected benefit, safety-net audit). You are given the extracted case, the NUMBERED prognosis excerpts [1..n], and the draft JSON.

Find: (a) a WELL-KNOWN complication of this diagnosis/procedure that is MISSING from the list (the single most important check — e.g. surgical-site infection after an operation, urinary retention after spinal anaesthesia + anorectal surgery); (b) "evidence" points not supported by their citation_ids; (c) uncited figures not marked "est."; (d) safety-net rows whose status contradicts the documented plan text (e.g. "mitigated" citing a generic checklist for a specific risk — the specificity rule); (e) a failure_signature that is vague (no concrete what-by-when).

Output ONLY JSON:
{"missing_complications":["…"],"unsupported_evidence":["…"],"unmarked_estimates":["…"],"wrong_net_status":["…"],"vague_failure_signature":["…"],"needs_revision":true|false,"severity":"none|minor|moderate|major"}
Empty arrays are fine. needs_revision=true if any array is non-empty.`;

export const PX_REVISE_SYSTEM = `You are revising your own foreseeability report using an auditor's critique. You receive the extracted case, the NUMBERED excerpts, your draft JSON, and the critique JSON. Fix every issue: add any missing well-known complication (with honest cite-or-label incidence), move unsupported claims to estimates, mark uncited figures "est.", correct safety-net statuses per the specificity rule, make the failure_signature concrete. Keep the EXACT same JSON schema. Output ONLY the corrected JSON, no prose.`;

export interface PxCritique {
  missing_complications: string[];
  unsupported_evidence: string[];
  unmarked_estimates: string[];
  wrong_net_status: string[];
  vague_failure_signature: string[];
  needs_revision: boolean;
  severity: 'none' | 'minor' | 'moderate' | 'major';
}

/** Parse the PX critique. Its keys differ from the LVC critique — do NOT reuse parseCritique
 *  (it drops the PX-specific arrays, which would silently defang the revision loop). */
export function parsePxCritique(text: string): PxCritique {
  const obj = extractJsonObject(text);
  const o = (obj && typeof obj === 'object') ? obj as Record<string, unknown> : {};
  const arr = (v: unknown) => asStrArray(v, 10);
  const mc = arr(o.missing_complications), ue = arr(o.unsupported_evidence),
    um = arr(o.unmarked_estimates), wn = arr(o.wrong_net_status), vf = arr(o.vague_failure_signature);
  const total = mc.length + ue.length + um.length + wn.length + vf.length;
  const sevRaw = String(o.severity ?? '').toLowerCase().trim();
  const severity = (['none', 'minor', 'moderate', 'major'].includes(sevRaw) ? sevRaw : (total > 0 ? 'minor' : 'none')) as PxCritique['severity'];
  const needs = typeof o.needs_revision === 'boolean' ? o.needs_revision : total > 0;
  return { missing_complications: mc, unsupported_evidence: ue, unmarked_estimates: um, wrong_net_status: wn, vague_failure_signature: vf, needs_revision: needs, severity };
}

export function buildPxCritiqueUser(caseSummary: string, citedContext: string, draftJson: string): string {
  return `Extracted case:\n${caseSummary.trim()}\n\nNUMBERED PROGNOSIS EXCERPTS:\n${citedContext.trim() || '(none)'}\n\nDraft foreseeability JSON to audit:\n${draftJson}\n\nOutput the JSON critique now.`;
}
export function buildPxReviseUser(caseSummary: string, citedContext: string, draftJson: string, critiqueJson: string): string {
  return `Extracted case:\n${caseSummary.trim()}\n\nNUMBERED PROGNOSIS EXCERPTS:\n${citedContext.trim() || '(none)'}\n\nEarlier draft JSON:\n${draftJson}\n\nAuditor critique JSON:\n${critiqueJson}\n\nOutput the corrected foreseeability JSON now.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse + assemble
// ─────────────────────────────────────────────────────────────────────────────

const RANK_L: Record<PxLikelihood, number> = { common: 3, uncommon: 2, rare: 1 };
const RANK_S: Record<PxSeverity, number> = { serious: 3, moderate: 2, minor: 1 };

/**
 * Parse the PX model output into a PrognosisReport.
 * `sourceCount` bounds citation ids (the SHARED numbering space — PX sources are
 * appended after the analyze sources, so ids here may reference either block).
 * `citationOffset` is subtracted-validated only in the sense that ids must be
 * ≤ sourceCount; the offset math itself lives in the orchestrator.
 */
export function parsePrognosis(raw: string, sourceCount = 0): PrognosisReport | null {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  const complications: AnticipatedComplication[] = [];
  if (Array.isArray(o.complications)) {
    for (const c of o.complications as unknown[]) {
      const co = (c && typeof c === 'object') ? c as Record<string, unknown> : {};
      const name = asStr(co.complication ?? co.name);
      if (!name) continue;
      const modifiers: PxModifier[] = [];
      if (Array.isArray(co.modifiers)) {
        for (const m of co.modifiers as unknown[]) {
          const mo = (m && typeof m === 'object') ? m as Record<string, unknown> : {};
          const factor = asStr(mo.factor ?? mo.text);
          if (!factor) continue;
          const dir = String(mo.direction ?? '').toLowerCase().startsWith('lower') ? 'lowers' : 'raises';
          modifiers.push({ factor, direction: dir });
          if (modifiers.length >= 6) break;
        }
      }
      complications.push({
        complication: name,
        likelihood: normLikelihood(co.likelihood),
        incidence_note: asStr(co.incidence_note) || undefined,
        horizon: asStr(co.horizon) || undefined,
        severity: normSeverity(co.severity),
        modifiers,
        evidence: asStrArray(co.evidence),
        estimates: asStrArray(co.estimates),
        citation_ids: validateCitationIds(co.citation_ids, sourceCount),
      });
      if (complications.length >= 8) break;
    }
  }
  complications.sort((a, b) => (RANK_L[b.likelihood] * RANK_S[b.severity]) - (RANK_L[a.likelihood] * RANK_S[a.severity]));

  let benefit: ExpectedBenefit | null = null;
  if (o.benefit && typeof o.benefit === 'object') {
    const b = o.benefit as Record<string, unknown>;
    const intended = asStr(b.intended_benefit);
    const failure = asStr(b.failure_signature);
    if (intended || failure) {
      benefit = {
        intended_benefit: intended,
        time_to_benefit: asStr(b.time_to_benefit) || undefined,
        success_rate_note: asStr(b.success_rate_note) || undefined,
        failure_signature: failure,
        documented_expectation_setting: normExpectationSetting(b.documented_expectation_setting),
        evidence: asStrArray(b.evidence),
        estimates: asStrArray(b.estimates),
        citation_ids: validateCitationIds(b.citation_ids, sourceCount),
      };
    }
  }

  const safetyNet: SafetyNetRow[] = [];
  const rawNet = o.safety_net ?? o.safetyNet;
  if (Array.isArray(rawNet)) {
    for (const r of rawNet as unknown[]) {
      const ro = (r && typeof r === 'object') ? r as Record<string, unknown> : {};
      const risk = asStr(ro.risk);
      if (!risk) continue;
      const found = asStr(ro.found_in_document ?? ro.foundInDocument);
      safetyNet.push({
        risk,
        expected_mitigation: asStr(ro.expected_mitigation ?? ro.expectedMitigation),
        found_in_document: found || null,
        status: normNetStatus(ro.status),
        note: asStr(ro.note) || undefined,
      });
      if (safetyNet.length >= 10) break;
    }
  }

  if (complications.length === 0 && !benefit && safetyNet.length === 0) return null;

  const n_unmitigated = safetyNet.filter((r) => r.status === 'unmitigated').length;
  const n_partial = safetyNet.filter((r) => r.status === 'partially_mitigated').length;
  const summary = asStr(o.summary) || buildPxSummary(complications.length, n_unmitigated, benefit);

  return {
    version: PX_ENGINE_VERSION,
    complications, benefit, safetyNet,
    summary, n_unmitigated, n_partial,
    disclaimer: PX_DISCLAIMER,
  };
}

/**
 * R5 — shared citation numbering: the PX model cites [1..pxN] against ITS OWN excerpt
 * block; the report's Sources panel appends PX sources AFTER the analyze sources, so
 * every PX citation id must shift by the analyze-source count. Pure, in-place-safe copy.
 */
export function offsetPrognosisCitations(report: PrognosisReport, offset: number): PrognosisReport {
  if (offset <= 0) return report;
  const shift = (ids: number[]) => ids.map((n) => n + offset);
  return {
    ...report,
    complications: report.complications.map((c) => ({ ...c, citation_ids: shift(c.citation_ids) })),
    benefit: report.benefit ? { ...report.benefit, citation_ids: shift(report.benefit.citation_ids) } : null,
  };
}

export function buildPxSummary(nRisks: number, nUnmitigated: number, benefit: ExpectedBenefit | null): string {
  const parts: string[] = [];
  parts.push(`${nRisks} foreseeable risk${nRisks === 1 ? '' : 's'} identified`);
  parts.push(nUnmitigated > 0 ? `${nUnmitigated} unmitigated` : 'all safety-netted or assess-limited');
  if (benefit) {
    parts.push(benefit.documented_expectation_setting === 'present'
      ? 'recovery expectations documented'
      : benefit.documented_expectation_setting === 'partial'
        ? 'recovery expectations partially documented'
        : 'recovery expectations not documented');
  }
  return parts.join(' · ') + '.';
}
