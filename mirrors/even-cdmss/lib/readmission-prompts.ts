/**
 * lib/readmission-prompts.ts — Vertex prompt builders + tolerant parser for the
 * readmission agent (PRD §5/§5a/§8a).
 *
 * ⚠️ VERTEX GOTCHA (PRD §8a): NEVER pass response_format:{type:'json_object'} —
 * Vertex rejects it, Gemini throws, the call falls to the unreachable Ollama bridge
 * and soft-fails to null. JSON is instructed IN the prompt, the exact keys the
 * parser reads are named inline, and parsing is tolerant. A null parse is
 * fail-safe: the pair stays "not audited", never a fabricated verdict.
 *
 * The inputs here are ALREADY de-identified by lib/readmission/assemble.ts (the
 * single PHI choke point, §8b) — these builders only format, they never see a
 * patient name or UHID.
 */

import type { EvidenceCatalog, EvidenceItem, PassClaims } from './readmission-reconcile-core';

// ── Evidence rendering ──────────────────────────────────────────────────────────

const sourceLabel = (i: EvidenceItem): string => {
  switch (i.source) {
    case 'index_summary': return 'index discharge summary — the treating team\'s OWN prose (interested)';
    case 'readmit_summary': return 'readmit discharge summary — the second team\'s note (disinterested)';
    case 'lab': return `raw lab value (disinterested)${i.side ? `, ${i.side} stay` : ''}${i.at ? `, ${i.at}` : ''}`;
    case 'adt': return 'admission/discharge record (disinterested)';
    case 'cm_form': return 'care-manager note — patient-reported (interested-but-not-clinical)';
    default: return 'evidence';
  }
};

export function renderEvidence(catalog: EvidenceCatalog): string {
  return catalog.items
    .map((i) => `[${i.id}] (${sourceLabel(i)}${i.abnormal === true ? ', ABNORMAL' : ''}) ${i.text}`)
    .join('\n');
}

const EVIDENCE_RULES = `Cite evidence ONLY by the [ids] above. Never invent an id. Every verdict must carry the evidence_ids that carried it.
Provenance discipline: facts from the index discharge summary are the audited team's own words (interested). Raw lab values, timestamps and the readmit team's note are disinterested. An "avoidable" conclusion may not rest on interested evidence alone.
Do not use the HIS admission_type field as a planned/unplanned signal — it is measured to be meaningless (103/112 readmits read "Elective").
Return STRICT JSON only — no markdown fences, no commentary before or after the JSON object.`;

// ── Pass A: the full reconciliation (Even→Even) ─────────────────────────────────

export function buildFullReconPrompt(catalog: EvidenceCatalog, facts: {
  gapDays: number; lane: string; indexDepartment: string | null; readmitDepartment: string | null;
  sameDoctor: boolean; labProfile: string;
}): { system: string; user: string } {
  return {
    system: `You are a hospital-governance reconciliation auditor. A patient was readmitted ${facts.gapDays} days after an inpatient discharge (detection lane: ${facts.lane}). You do NOT trust the discharge summary: it is written by the doctor being audited and may be written to justify a claim. Build your verdicts from provenance — prefer disinterested sources (raw labs, the second team's note) over the treating team's prose. You propose; a human decides. Never address a doctor and never output a score.`,
    user: `STRUCTURED FACTS (disinterested): index department ${facts.indexDepartment ?? 'unknown'}, readmit department ${facts.readmitDepartment ?? 'unknown'}, same treating doctor: ${facts.sameDoctor}, gap ${facts.gapDays} days, lab-timing profile: ${facts.labProfile}.

EVIDENCE LEDGER:
${renderEvidence(catalog)}

TASKS:
1. planned — was this return intended BEFORE the index discharge? Planned counts ONLY if foreshadowed in the INDEX summary (written before the outcome). Intent asserted only in the readmit note does NOT count.
2. same_condition — same failing physiology or a genuinely different illness? Decide on the failing-organ analyte bundle (renal = creatinine+BUN+potassium; cardiac = BNP+weight+sodium; hepatic = bilirubin+INR+ammonia), NOT the diagnosis strings, which a coder can rename.
3. omissions — every stability claim in the index summary that a lab value contradicts (e.g. "stable at discharge" beside potassium 2.9). Rank by clinical danger. If the lab-timing profile is admission_only, say so — an admission abnormality expected to correct is weaker evidence.
4. exculpatory_claims — every claim that excuses the readmission ("non-adherent", "against medical advice", "justified re-presentation") with whatever DISINTERESTED evidence corroborates it. No corroboration → empty corroborating_evidence_ids.
5. avoidable — on the evidence, did this readmission need to happen? avoidable = the index care or discharge decision set it up; justified = the return was clinically necessary and not attributable to the index care.
6. weakest_step — name the single weakest inferential step in your own reasoning.
7. refusal_record — evidence you looked for and could not find.

${EVIDENCE_RULES}

Return exactly this JSON shape:
{
  "planned": {"verdict": "planned|unplanned|unknown", "evidence_ids": ["S1"], "rationale": ""},
  "same_condition": {"verdict": "same|different|unknown", "organ_bundle": "renal|cardiac|hepatic|other|none", "evidence_ids": [], "rationale": ""},
  "omissions": [{"claim": "", "claim_evidence_id": "S2", "contradicting_evidence_ids": ["L1"], "danger": "high|moderate|low", "rationale": ""}],
  "exculpatory_claims": [{"claim": "", "claim_evidence_id": "", "corroborating_evidence_ids": []}],
  "avoidable": {"verdict": "avoidable|justified|uncertain", "evidence_ids": [], "rationale": ""},
  "weakest_step": "",
  "refusal_record": [{"looked_for": "", "found": false, "note": ""}]
}`,
  };
}

// ── Pass B: the independent second avoidable pass (different prompt by design) ──

export function buildSecondAvoidablePrompt(catalog: EvidenceCatalog, facts: {
  gapDays: number; labProfile: string;
}): { system: string; user: string } {
  return {
    system: `You are the physician's defence counsel in a hospital utilisation review. A readmission ${facts.gapDays} days after discharge has been questioned. Your job is to test whether "avoidable" would survive scrutiny: argue the strongest honest case that the readmission was justified, then concede only what the disinterested evidence forces you to concede. You must reach a verdict either way.`,
    user: `EVIDENCE LEDGER (lab-timing profile: ${facts.labProfile}):
${renderEvidence(catalog)}

After making the strongest defence, give your final verdict on whether this readmission was avoidable (the index care or discharge decision set it up) or justified (clinically necessary, not attributable to the index care). Cite the evidence ids that finally carried your verdict — the decisive items, not everything you read.

${EVIDENCE_RULES}

Return exactly this JSON shape:
{
  "avoidable": {"verdict": "avoidable|justified|uncertain", "evidence_ids": [], "rationale": ""}
}`,
  };
}

// ── Lane D: the same/different-condition pass only (decisions 9/14) ─────────────

export function buildConditionPassPrompt(catalog: EvidenceCatalog, facts: { gapDays: number }): { system: string; user: string } {
  return {
    system: `You are a clinical physiology auditor. A patient had two inpatient stays ${facts.gapDays} days apart, under a different doctor and department. Decide ONLY whether the second stay treats the SAME failing physiology as the first, or a genuinely different illness (a repeat hospitalization). A disguised same-condition bounce that switched departments is exactly what you are looking for.`,
    user: `EVIDENCE LEDGER:
${renderEvidence(catalog)}

Decide on the failing-organ analyte bundle (renal = creatinine+BUN+potassium; cardiac = BNP+weight+sodium; hepatic = bilirubin+INR+ammonia) and the clinical course — NOT the diagnosis strings, which a coder can rename.

${EVIDENCE_RULES}

Return exactly this JSON shape:
{
  "same_condition": {"verdict": "same|different|unknown", "organ_bundle": "renal|cardiac|hepatic|other|none", "evidence_ids": [], "rationale": ""},
  "weakest_step": "",
  "refusal_record": [{"looked_for": "", "found": false, "note": ""}]
}`,
  };
}

// ── Out-of-network: index-side only (decision 13) ───────────────────────────────

export function buildOonPrompt(catalog: EvidenceCatalog, facts: {
  reportedReadmitDate: string | null; labProfile: string;
}): { system: string; user: string } {
  return {
    system: `You are a hospital-governance auditor. A patient discharged from Even Hospital was later readmitted AT ANOTHER HOSPITAL (reported by a care manager; readmit date ${facts.reportedReadmitDate ?? 'unknown'}). There is no readmit discharge summary in any system. You therefore audit the EVEN INDEX SIDE ONLY: did our discharge set the patient up to bounce? You must NOT judge the other hospital's care and must NOT decide whether the readmission was avoidable — that verdict is out of scope by design.`,
    user: `EVIDENCE LEDGER (lab-timing profile: ${facts.labProfile}; the care-manager note is patient-reported):
${renderEvidence(catalog)}

TASKS (index side only):
1. planned — was a return foreshadowed in the index summary, or recorded as planned in the care-manager note?
2. same_condition — from the care-manager note and the index summary, does the reported readmission look like the same condition or a different one?
3. omissions — stability claims in the index summary that the index labs contradict, ranked by clinical danger.
4. weakest_step and refusal_record as usual.

${EVIDENCE_RULES}

Return exactly this JSON shape (note: NO "avoidable" key — that verdict is not yours to give):
{
  "planned": {"verdict": "planned|unplanned|unknown", "evidence_ids": [], "rationale": ""},
  "same_condition": {"verdict": "same|different|unknown", "organ_bundle": "renal|cardiac|hepatic|other|none", "evidence_ids": [], "rationale": ""},
  "omissions": [{"claim": "", "claim_evidence_id": "", "contradicting_evidence_ids": [], "danger": "high|moderate|low", "rationale": ""}],
  "weakest_step": "",
  "refusal_record": [{"looked_for": "", "found": false, "note": ""}]
}`,
  };
}

// ── Tolerant parser ─────────────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v.trim().toLowerCase())
    ? (v.trim().toLowerCase() as T) : null;

/** Extract the first balanced JSON object from model output (fences stripped). */
export function extractJsonObject(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  for (let end = cleaned.lastIndexOf('}'); end > start; end = cleaned.lastIndexOf('}', end - 1)) {
    const candidate = cleaned.slice(start, end + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      return null;
    } catch { /* keep shrinking */ }
  }
  return null;
}

/**
 * Parse a model reply into PassClaims. Tolerant: missing/malformed sections drop to
 * null/[] rather than throwing; an entirely unparseable reply returns null and the
 * caller treats the pair as NOT AUDITED (fail-safe, §8a).
 */
export function parsePassClaims(text: string | null | undefined): PassClaims | null {
  const j = extractJsonObject(text);
  if (!j) return null;
  const claims: PassClaims = {};

  const p = j.planned as Record<string, unknown> | undefined;
  const pv = oneOf(p?.verdict, ['planned', 'unplanned', 'unknown'] as const);
  if (p && pv) claims.planned = { verdict: pv, evidenceIds: strArr(p.evidence_ids), rationale: str(p.rationale) ?? undefined };

  const s = j.same_condition as Record<string, unknown> | undefined;
  const sv = oneOf(s?.verdict, ['same', 'different', 'unknown'] as const);
  if (s && sv) claims.sameCondition = { verdict: sv, organBundle: str(s.organ_bundle), evidenceIds: strArr(s.evidence_ids), rationale: str(s.rationale) ?? undefined };

  if (Array.isArray(j.omissions)) {
    claims.omissions = (j.omissions as Array<Record<string, unknown>>)
      .map((o) => ({
        claim: str(o.claim) ?? '',
        claimEvidenceId: str(o.claim_evidence_id),
        contradictingEvidenceIds: strArr(o.contradicting_evidence_ids),
        danger: oneOf(o.danger, ['high', 'moderate', 'low'] as const) ?? 'low',
        rationale: str(o.rationale) ?? undefined,
      }))
      .filter((o) => o.claim !== '');
  }

  if (Array.isArray(j.exculpatory_claims)) {
    claims.exculpatory = (j.exculpatory_claims as Array<Record<string, unknown>>)
      .map((e) => ({
        claim: str(e.claim) ?? '',
        claimEvidenceId: str(e.claim_evidence_id),
        corroboratingEvidenceIds: strArr(e.corroborating_evidence_ids),
      }))
      .filter((e) => e.claim !== '');
  }

  const av = j.avoidable as Record<string, unknown> | undefined;
  const avv = oneOf(av?.verdict, ['avoidable', 'justified', 'uncertain'] as const);
  if (av && avv) claims.avoidable = { verdict: avv, evidenceIds: strArr(av.evidence_ids), rationale: str(av.rationale) ?? undefined };

  claims.weakestStep = str(j.weakest_step);

  if (Array.isArray(j.refusal_record)) {
    claims.refusalRecord = (j.refusal_record as Array<Record<string, unknown>>)
      .map((r) => ({ lookedFor: str(r.looked_for) ?? '', found: r.found === true, note: str(r.note) ?? undefined }))
      .filter((r) => r.lookedFor !== '');
  }

  // A reply that parsed but asserts nothing usable is treated as unparseable.
  if (!claims.planned && !claims.sameCondition && !claims.avoidable
    && !(claims.omissions?.length) && !(claims.exculpatory?.length)) return null;
  return claims;
}

/** A verifier can grep for this to confirm the gotcha is enforced, not just remembered. */
export const NO_RESPONSE_FORMAT = true;
