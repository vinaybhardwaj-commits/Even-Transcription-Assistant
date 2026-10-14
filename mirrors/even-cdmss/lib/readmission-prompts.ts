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
// R10-B: ONE definition of the fetch cap. The prompt states the number the loop enforces, so the
// two cannot drift — a model told "at most 8" while code stops at 5 would look like it disobeyed.
import { RECORD_FETCH_MAX } from './readmission-ask-core';

// ── Evidence rendering ──────────────────────────────────────────────────────────

const sourceLabel = (i: EvidenceItem): string => {
  switch (i.source) {
    case 'index_summary': return 'index discharge summary — the treating team\'s OWN prose (interested)';
    case 'readmit_summary': return 'readmit discharge summary — the second team\'s note (disinterested)';
    case 'lab': return `raw lab value (disinterested)${i.side ? `, ${i.side} stay` : ''}${i.at ? `, ${i.at}` : ''}`;
    case 'adt': return 'admission/discharge record (disinterested)';
    case 'cm_form': return 'care-manager note — patient-reported (interested-but-not-clinical)';
    // R2 source 4: weight by SIDE (R2-2), exactly as the two summaries are weighed.
    case 'ot_note': case 'pac_note': case 'progress_note':
      return `${i.source === 'ot_note' ? 'OT note' : i.source === 'pac_note' ? 'pre-anaesthesia check' : 'progress note'} — ${i.side === 'readmit' ? 'the readmit team\'s contemporaneous record (disinterested)' : 'the treating team\'s contemporaneous record (interested)'}`;
    // R10-A: operative text PRINTED IN a discharge document. The label says where it came from and
    // what it is not, so the model can quote it without ever calling it a structured OT record.
    // NOTE (deliberate): the R4.1 probe-gate fingerprints are computed over a FIXTURE catalog that
    // carries no DOT item, so adding this case does not move them and the armed probe stays armed.
    case 'doc_operative_text':
      return 'operative text found in the discharge document (the treating team\'s own printed account, interested) — NOT a structured OT note';
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
Source 4 — OT / PAC / progress items ([OTn], [PACn], [Pn]) are the teams' contemporaneous notes from db13: index-stay items carry the same interest as the index summary; readmit-stay items are the other admission's record (disinterested). A template that is absent from the ledger is UNKNOWN, never "uneventful" — do not infer a clean intra-op course from silence.

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
Source 4 — OT / PAC / progress items ([OTn], [PACn], [Pn]) are the teams' contemporaneous notes from db13: index-stay items carry the same interest as the index summary; readmit-stay items are the other admission's record (disinterested). A template that is absent from the ledger is UNKNOWN, never "uneventful" — do not infer a clean intra-op course from silence.

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
Source 4 — OT / PAC / progress items ([OTn], [PACn], [Pn]) are the teams' contemporaneous notes from db13: index-stay items carry the same interest as the index summary; readmit-stay items are the other admission's record (disinterested). A template that is absent from the ledger is UNKNOWN, never "uneventful" — do not infer a clean intra-op course from silence.

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
Source 4 — OT / PAC / progress items ([OTn], [PACn], [Pn]) are the teams' contemporaneous notes from db13: index-stay items carry the same interest as the index summary; readmit-stay items are the other admission's record (disinterested). A template that is absent from the ledger is UNKNOWN, never "uneventful" — do not infer a clean intra-op course from silence.

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

// ═══ R4 — the case-page NARRATIVE leg (CDMSS-READMISSIONS-R4-PRD v1.0 §3, R4-4 / R4-5) ═════
//
// A NEW builder. The four recon builders above are byte-identical to R2 (a test pins them);
// nothing here is read by reconcileFinding or deriveJudgements — the narrative is an
// additive artefact stored on the finding, produced ONCE at audit time (or by the backfill
// tick on the Bedrock rails), never at page-request time.
//
// The model PROPOSES: an intern-style account of the case citing ONLY the ledger ids, and
// which of the patient's prior LVC findings relate to this return with a reason and both
// ends of the citation. CODE DECIDES (lib/readmission-narrative-core.ts): every marker must
// resolve to a ledger id or the account is withheld; every proposal must name a candidate
// we showed and real readmit ids or it is dropped.
//
// Inputs are already de-identified (assemble.ts is the choke point; the LVC candidates'
// rationale text is passed through deidText by the caller before it reaches here).

export interface NarrativeFacts {
  findingClass: 'even_even' | 'out_of_network' | 'delayed_ssi';
  lane: string;
  gapDays: number | null;
  indexDepartment: string | null;
  readmitDepartment: string | null;
  /** The judged finding, as stored — the account must not contradict it. */
  planned: string | null;
  sameCondition: string | null;
  avoidable: string | null;
  omissions: Array<{ claim: string; danger: string; evidenceIds: string[] }>;
  exculpatory: Array<{ claim: string; corroborated: boolean; corroboratingIds?: string[] }>;
  weakestStep: string | null;
  refusalRecord: Array<{ lookedFor: string; found: boolean; note?: string }>;
}

export interface NarrativeLvcCandidate {
  /** What the model must echo back: `noteUid#findingRef`. */
  key: string;
  noteDate: string | null;
  concept: string;
  lvcCategory: string | null;
  /** De-identified by the caller. May be empty. */
  rationale: string | null;
  reviewStatus: string;
}

export function buildNarrativePrompt(
  catalog: EvidenceCatalog,
  facts: NarrativeFacts,
  lvc: { audited: number; totalNotes: number; candidates: NarrativeLvcCandidate[]; joinFailed: boolean },
): { system: string; user: string } {
  const oon = facts.findingClass === 'out_of_network';
  const candidateBlock = lvc.joinFailed
    ? 'PRIOR OPD FINDINGS: unknown — the patient\'s outpatient records could not be joined. Do not speculate about prior care; return "related": [].'
    : !lvc.candidates.length
      ? `PRIOR OPD FINDINGS: ${lvc.audited} of this patient's ${lvc.totalNotes} outpatient notes before this readmission were audited; none of the audited notes carries a low-value-care finding. Return "related": [].`
      : `PRIOR OPD FINDINGS (${lvc.audited} of this patient's ${lvc.totalNotes} outpatient notes before this readmission were audited — the rest are UNAUDITED, not clean; every candidate below is the LATEST audit of its note):
${lvc.candidates.map((c) => `- key ${c.key} · ${c.noteDate ?? 'undated'} · ${c.concept}${c.lvcCategory ? ` (${c.lvcCategory})` : ''} · review: ${c.reviewStatus}${c.rationale ? ` · ${c.rationale}` : ''}`).join('\n')}`;
  return {
    system: `You are writing the intern's presentation of a hospital readmission case for a care-manager review room. You have ONLY the evidence ledger below and the audit's stored verdicts. You do not diagnose, you do not score, you do not address a doctor. Every factual sentence you write must carry a citation marker naming ledger ids in square brackets — [S4], [L2], [OT1], or a list [S4, R2] — and you may cite NOTHING that is not in the ledger. An uncited claim will be discarded by the system, and a single invented id discards the whole account. Prefer disinterested sources (raw labs, the readmit team's note, the other team's contemporaneous notes) over the treating team's own prose. Where the ledger is silent, say so ("the ledger does not record …") rather than inferring. Advisory throughout; a human decides.`,
    user: `CASE FACTS (from detection, disinterested): finding class ${oon ? 'out of network — the return was at another hospital; only the index stay is in evidence' : facts.findingClass}, lane ${facts.lane}, gap ${facts.gapDays ?? 'unknown'} days, index department ${facts.indexDepartment ?? 'unknown'}${oon ? '' : `, readmit department ${facts.readmitDepartment ?? 'unknown'}`}.

THE AUDIT'S STORED VERDICTS (do not contradict them; you may explain them): planned ${facts.planned ?? 'unknown'} · same condition ${facts.sameCondition ?? 'unknown'} · medical-justification verdict ${facts.avoidable ?? 'none (index side only)'}${facts.weakestStep ? ` · weakest step: ${facts.weakestStep}` : ''}.
${facts.omissions.length ? `Omissions the audit recorded:\n${facts.omissions.map((o) => `- ${o.claim} (${o.danger} danger; evidence ${o.evidenceIds.join(', ') || 'none'})`).join('\n')}` : 'Omissions the audit recorded: none.'}
${facts.exculpatory.length ? `Exculpatory claims:\n${facts.exculpatory.map((e) => `- ${e.claim} (${e.corroborated ? 'corroborated' : 'uncorroborated'}${e.corroboratingIds?.length ? `; evidence ${e.corroboratingIds.join(', ')}` : ''})`).join('\n')}` : 'Exculpatory claims: none.'}
${facts.refusalRecord.filter((r) => r.found === false).length ? `Looked for and NOT found: ${facts.refusalRecord.filter((r) => r.found === false).map((r) => r.lookedFor).join(', ')}.` : ''}

EVIDENCE LEDGER (cite ONLY these ids):
${renderEvidence(catalog)}

${candidateBlock}

WRITE, as strict JSON with exactly these keys and nothing before or after it:
{
  "narrative": "<4 to 8 short paragraphs, plain prose, no headings, no bullet characters. In order: (1) why this case was flagged — the return, its timing, the lane; (2) the index stay as the ledger records it; (3) the return as the ledger records it; (4) the medical question the audit put — what was looked for, what was found, what was not, using the omission and exculpatory items; (5) what the disinterested evidence supports and what rests on the treating team's prose alone; (6) one closing paragraph naming what a reviewer would need to see to settle it. Every factual sentence ends with a marker like [S3] or [L2, R4]. Never name the patient. Never write a rupee figure. Never quote a prior OPD note.>",
  "related": [
    { "key": "<a candidate key EXACTLY as listed>", "reason": "<one or two sentences: why this prior finding plausibly relates to THIS return>", "readmit_evidence_ids": ["<ledger id(s) on the readmission side that the link rests on>"] }
  ]
}
Rules for "related": include a candidate ONLY when the ledger shows a clinical thread from that prior finding to this return (same organ system, same drug class, a foreseeable consequence). If nothing relates, return []. Never invent a key. Never cite a ledger id that is not above.
LANGUAGE (plain clinical English): write for a care manager reading a case, never for the system. Never use internal system vocabulary — no lane names (er_routed, tight_bounce, structural_30d, out_of_network, "the other lane"), no "even_even" or "findingClass", no tier names (tier1 / tier2 / tier3, "lab-backed", "summary-only"), no "detection lane", no "this case was flagged". Open with the CLINICAL story — who the patient is clinically, what was done, what happened next — not with the detection story; say "readmitted", "the return admission", "the first stay" in ordinary words.`,
  };
}

/** Parsed narrative-leg output. Tolerant: an unparseable reply → null (the finding is stored
 *  WITHOUT a narrative and the backfill sweep re-offers it); a missing "related" → []. */
export interface NarrativeOutput {
  narrative: string;
  related: Array<{ key: string; reason: string; readmitEvidenceIds: string[] }>;
}
export function parseNarrativeOutput(text: string | null | undefined): NarrativeOutput | null {
  const obj = extractJsonObject(text);
  if (!obj) return null;
  const narrative = str(obj.narrative);
  if (!narrative) return null;
  const relatedRaw = Array.isArray(obj.related) ? obj.related : [];
  const related = relatedRaw
    .map((r) => {
      const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
      return {
        key: str(o.key) ?? '',
        reason: str(o.reason) ?? '',
        readmitEvidenceIds: strArr(o.readmit_evidence_ids ?? o.readmitEvidenceIds),
      };
    })
    .filter((r) => r.key !== '');
  return { narrative, related };
}

// ═══ R4.3 — ASK THE AGENT (CDMSS-READMISSIONS-R4.3-PRD v1.0 R43-1..R43-8) ═══════════════════
//
// A NEW builder, its own section. The four recon builders and the narrative builder above are
// byte-identical (fingerprint tests) and the refresh-gate fingerprint (4 recon + narrative) does
// NOT include this builder — the armed probe stays armed. This prompt is a CONVERSATION FENCED TO
// THE CASE: its whole world is the stored material the case page already renders (the ledger, the
// account, the judgements, the coverage, the two bills). Nothing here re-audits, regenerates or
// stores anything. The patient's name is never in it (R43-8): the material is de-identified by
// construction and the route never passes an identity.
//
// R9 (CDMSS-READMISSIONS-R9-DUAL-CONTRACT PRD, D13 / §6 / §5.3) adds a SECOND job to the same single
// call: alongside the answer, the model reports what the care manager has just STATED, as a
// `clinical_review` overlay. Two things about it are load-bearing.
//   · It reports; it does not decide. Code gates every field afterwards (gateOverlay, §12.4), and a
//     model that guesses `stated: true` on a pure question is caught by the assertion test in code.
//   · It NEVER moves the answer's own rules. The answer still cites or dies. A reviewer-stated fact
//     is reviewer-stated: the model may use it as context, labelled as such, and may never write it
//     back as though a discharge note had said it.
// The four recon builders and the narrative builder stay byte-identical; the refresh-gate fingerprint
// still does not include this builder.

export interface AskPromptMaterial {
  ledger: Array<{ id: string; source: string; side: string | null; at: string | null; weight: string; text: string }>;
  account: string | null;
  judgements: { planned: string | null; sameCondition: string | null; justification: string; preventableInjury: string; negligence: string; findingClass: string; lane: string; gapDays: number | null };
  coverage: Array<{ label: string; state: string }>;
  bills: { index: { ok: boolean; groups: Array<{ serviceType: string; netRs: number; lines: number }>; totalRs: number; lines: number } | null; readmit: { ok: boolean; groups: Array<{ serviceType: string; netRs: number; lines: number }>; totalRs: number; lines: number } | null; returnCell: string };
  refusals: Array<{ lookedFor: string; note?: string }>;
}
export interface AskPromptTurn { question: string; answer: string }

const askSource = (s: string): string => ({
  index_summary: 'discharge summary — first stay', readmit_summary: 'discharge summary — return stay', lab: 'lab', adt: 'admission record',
  cm_form: 'care-manager follow-up form (patient-reported)', ot_note: 'operative note', pac_note: 'pre-anaesthesia check', progress_note: 'ward progress note',
  // R10-A — plain clinical English (R4.2's rule), and it names the document, not a theatre record.
  doc_operative_text: 'operative text printed in the discharge document',
} as Record<string, string>)[s] ?? s;
const askWeight = (w: string): string => ({ interested: "treating team's own account", disinterested: 'independent record', neither: 'patient-reported account' } as Record<string, string>)[w] ?? w;
const askBill = (label: string, b: AskPromptMaterial['bills']['index']): string => {
  if (!b || !b.ok) return `${label}: not available`;
  if (!b.groups.length) return `${label}: bill not finalised`;
  return `${label}: total ₹${b.totalRs} over ${b.lines} line(s) — ${b.groups.map((g) => `${g.serviceType} ₹${g.netRs}`).join(', ')} [hospital bill]`;
};

/**
 * R10-B (§4.1/§4.2, R10-D5..R10-D8) — the prompt gains a RECORD INDEX and a fetch rule, and ONLY
 * when the reach actually offers something. `recordIndex` absent / empty ⇒ every line below is
 * byte-identical to R9's prompt, which is the property that lets a deployment with no reachable
 * record behave exactly as it did before R10 rather than talk about a tool it does not have.
 */
export interface AskPromptRecords {
  /** The rendered index (renderRecordIndex). Empty string ⇒ no record section, no fetch rule. */
  index: string;
  /** Artefacts already pulled into THIS thread, so a reload can cite them without re-fetching. */
  retrieved: Array<{ id: string; label: string; date: string | null; text: string }>;
  /** How many older held artefacts are NOT re-shown in full. Stated, never silently dropped. */
  olderNotShown?: number;
}

export function buildAskPrompt(
  material: AskPromptMaterial,
  history: readonly AskPromptTurn[],
  question: string,
  records?: AskPromptRecords,
): { system: string; user: string } {
  const j = material.judgements;
  const oon = j.findingClass === 'out_of_network';
  const canFetch = !!records?.index;
  const held = records?.retrieved ?? [];
  return {
    system: `You are answering a care manager's question about ONE hospital readmission case, in a review room. Your entire world is the case material below — the evidence ledger, the agent's stored account, the audit's stored judgements, the artefact coverage, and the hospital bills${canFetch ? ", plus any of this patient's other records you fetch with the fetch_record tool" : ''}. Rules, in order:
1. Answer ONLY from that material. If the material does not answer the question, say plainly that the case record does not show it — never fill the gap from general medical knowledge, never guess.
2. Every factual sentence you write must carry a citation marker naming ledger ids in square brackets — [S4], [L2], [OT1], or a list [S4, R2]. You may cite NOTHING that is not in the ledger${canFetch ? ' or in a record you actually fetched (those are cited by their X id, e.g. [X3])' : ''}; a single invented id discards the whole answer. When you say the record does not show something, set "answerable": false and cite nothing.
3. No diagnosis and no treatment advice for the patient. No legal conclusion: the audit's negligence and preventable-injury judgements are advisory rule outputs, not a court or council finding — say so if asked what they mean.
4. Plain clinical English. Never internal system vocabulary (lane names, "even_even", "findingClass", tier names, "detection lane"). Say "the first stay", "the return admission", "the treating team".
5. Be brief: two to six sentences, or a short list if the question asks for a list. Do not repeat the whole account. Plain text only — no markdown (no **bold**, no headings, no bullet characters); a list is plain numbered lines.
6. Separately from the answer, report what the care manager has JUST STATED about this case, as "overlay". This is a record of HIS judgement, not yours, and it is stored beside the audit's own — it never replaces it and it never changes any rate.
   · If his turn only asks a question, or only argues without landing on a verdict, return "overlay": null. Never infer a verdict he did not state.
   · "stated" is true only when he said it himself. Anything you worked out from the record is not stated.
   · "decision": "justified" (he says the return was clinically justified) | "not_justified" | "insufficient" (he says there is not enough here to say, or he contradicts himself).
   · "clock_class": "lt24h" | "d1_30" | "d31_90" | null — the window he is talking about.
   · "lt24h_kind": "paper_admin" | "deferred_staged" | "medical" | null — for a same-day return, what kind he says it was.
   · "exclusion_claim": "none" | "onco" | "obgyn" | "neonate" | "ophthal" | null — a category he claims this case belongs to.
   · "quote": the shortest run of HIS OWN WORDS, copied exactly from his turn, that carries the judgement. Copy it; do not paraphrase it. An overlay whose quote is not in his turn is discarded.
${canFetch ? `7. THIS PATIENT'S OTHER RECORDS. The RECORD INDEX below lists them by id, type and date — it carries no clinical text. Call fetch_record with one id to read one record. Fetch only what the question actually needs, at most ${RECORD_FETCH_MAX} records per question. Rules that do not bend:
   · Fetch only ids that appear in the index. Never guess an id, never assume a record exists because it usually would.
   · A record you fetched is cited as [X<n>], exactly like a ledger id, and only after you have fetched it — an X id you did not fetch is an invented id.
   · Retrieved records are about the SAME PATIENT but a DIFFERENT episode. Say which episode a fact came from; never write a fact from another visit as though this stay's record said it.
   · A record the index does not list, or one that could not be read, is UNKNOWN. It is never an absence and never evidence that something did not happen.
   · If you run out of fetches, answer from what you have and say plainly how many records you read.
` : ''}Return STRICT JSON only: {"answer": "<your answer with [id] markers>", "answerable": true|false, "overlay": null | {"stated": true, "decision": "...", "clock_class": null, "lt24h_kind": null, "exclusion_claim": null, "quote": "..."}} — nothing before or after it.`,
    user: `CASE FACTS: ${oon ? 'the return was at another hospital; only the first stay is in evidence' : `readmitted ${j.gapDays ?? 'an unknown number of'} days after discharge`}. STORED JUDGEMENTS (advisory, from the audit's rules): planned ${j.planned ?? 'unknown'} · same condition ${j.sameCondition ?? 'unknown'} · medical justification: ${j.justification} · preventable injury: ${j.preventableInjury} · negligence: ${j.negligence} (advisory — not a court or council finding). Return stay bill on the card: ${material.bills.returnCell}.

ARTEFACT COVERAGE (what the audit had): ${material.coverage.map((c) => `${c.label}: ${c.state}`).join(' · ') || 'unknown'}.
${material.refusals.length ? `LOOKED FOR AND NOT FOUND: ${material.refusals.map((r) => `${r.lookedFor}${r.note ? ` — ${r.note}` : ''}`).join('; ')}.` : ''}

EVIDENCE LEDGER (cite ONLY these ids):
${material.ledger.map((i) => `[${i.id}] (${askSource(i.source)}${i.side ? `, ${i.side === 'index' ? 'first stay' : i.side === 'readmit' ? 'return stay' : i.side}` : ''}, ${askWeight(i.weight)}${i.at ? `, ${i.at}` : ''}) ${i.text}`).join('\n') || '(no ledger stored for this case)'}

THE AGENT'S STORED ACCOUNT (written at audit time; its markers are ledger ids):
${material.account ?? '(no valid account stored for this case)'}

BILLS: ${askBill('First stay', material.bills.index)}. ${askBill('Return stay', material.bills.readmit)}.
${canFetch ? `\nRECORD INDEX — this patient's other records (ids only; fetch one with fetch_record to read it):\n${records!.index}\n` : ''}${held.length ? `\nRECORDS ALREADY FETCHED IN THIS CONVERSATION (cite these by their X id; do not fetch them again):\n${held.map((r) => `[${r.id}] ${r.label}${r.date ? `, ${r.date}` : ''}\n${r.text}`).join('\n\n')}\n${records!.olderNotShown ? `${records!.olderNotShown} record(s) fetched earlier in this conversation are not reprinted above; you may still cite them by their X id if you remember what they said, and you may fetch them again if you need the text.\n` : ''}` : ''}${history.length ? `\nEARLIER IN THIS CONVERSATION (context only — do not repeat). Anything the care manager asserts here is REVIEWER-STATED: you may use it as his account, always labelled as his, and you may never write it as though a hospital record said it:\n${history.map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}`).join('\n')}\n` : ''}
CARE MANAGER'S TURN: ${question}`,
  };
}
