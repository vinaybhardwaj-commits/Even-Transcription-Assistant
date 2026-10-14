/**
 * lib/member-state/ipd-evidence.ts — the P4 fold's PURE half: one stay's ClinicalState library →
 * one `kind: 'ipd'` EncounterEvidence, and the trust gate that decides what is allowed through
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, §6.2 / §6.3, D6 / D12 / D13).
 *
 * THE SHAPE OF THE WRITE (D6, §6.4). "Write" means: build ONE EncounterEvidence, append it after
 * the frozen assemble, then let frozen `buildMemberState` project. This file produces input and
 * nothing else — it never patches a snapshot array, and it cannot: it returns evidence, not a
 * snapshot. Sibling to care-call-evidence.ts by design, which does the same job for the CCB loop.
 *
 * THE GATE IS THE POINT. A spine write is not reverted by a code revert — a wrong fact promoted
 * onto a member's longitudinal record is there until someone finds it. So `promotable` is a pure
 * function with SIX conjunctive conditions and a NAMED refusal reason for each, and every default
 * is refusal:
 *   1. the slot is on the §6.2 allow-list                      (nothing else has a promote path)
 *   2. provenance.trust ∈ { structured_db, clinician_documented }
 *   3. an LLM-extracted fact must carry a VERIFIED verbatim span in its named source field
 *   4. `inferred` is absent or false                            (D12: inferred NEVER promotes)
 *   5. the caller resolved a SINGLE individual_uid              (checked by the caller, asserted here)
 *   6. the fact is not `contaminationSuspect`                   (H-D5: see below)
 *
 * CONDITION 6 IS NEW AND IT EXISTS BECAUSE CONDITION 3 IS NOT ENOUGH
 * (CDMSS-STAY-LIBRARY-HARDENING-PRD-v1.0-29-AUG-2026, H-D5). R10 found a cholecystectomy operative
 * note printed word for word inside a hernioplasty discharge summary — hospital template
 * contamination. That discharge procedure is verbatim, so it PASSES condition 3, and it is
 * clinician-documented, so it passes condition 2. Until H2 the only thing keeping the wrong
 * operation off the spine was that discharge spans usually fail to verify, which is luck. The
 * library now compares the discharge's procedure against the stay's own structured OT
 * `surgery_name` at write time and stamps the discharge side when they share no substantive word;
 * this gate refuses anything so stamped, permanently, whatever else is true of it.
 *
 * WHAT CONDITION 3 ACTUALLY CHECKS, stated plainly because it is easy to make vacuous. The rule is
 * that `rawText` occurs verbatim in the text of the field the provenance NAMES. That text must be
 * SUPPLIED by the caller. A caller that cannot supply it does not get a pass — the fact fails
 * closed. This is why a P2 discharge procedure, whose extractor kept no span into the PDF, usually
 * does not promote, and why an OT `surgery_name` (deterministic, so condition 3 does not apply) does.
 *
 * REFUSED, ALWAYS (§6.5): situations, NQI / CVI / PDQI / bands / LVC / Hide, disposition, LOS,
 * admission type, completeness holes, mesh or implant as a device, a surgery title as a problem
 * without an Even code, an intra-op invented from a missing OT, a PROM-path fold. None of them has a
 * branch here; the allow-list is a closed set and a test enumerates it.
 *
 * PURE: no DB, no model, no clock, no I/O. Imports nothing the frozen-spine tripwires forbid —
 * architecture rules 6, 7 and 8 guard the IPD audit module, the admission-window projection and the
 * compose-outside adapter respectively, and acceptance #13 additionally requires that the second of
 * those names appears nowhere in this directory AT ALL, comments included. Hence this paraphrase:
 * a tripwire that a file can trip by DESCRIBING what it refuses to import is a tripwire worth
 * keeping strict, so the text is worked around rather than the test loosened.
 */
import type { Provenance } from '../clinical-state/schema';
import type { EncounterEvidence, EncounterProcedure, Laterality } from './schema';

/** §6.2 — the ONLY slots with a promote path. A closed set; membership is condition 1. */
export const PROMOTE_ALLOW_LIST = ['problems', 'medications', 'allergies', 'followUps', 'procedures'] as const;
export type PromotableSlot = (typeof PROMOTE_ALLOW_LIST)[number];

/** §6.2 — `investigations` is named here to be REFUSED. The spine's investigation series stays the
 *  existing `test_values_view` hop; no lab value is LLM-read off a discharge PDF (D10), and no
 *  union with `dpipe_all_digital_values`. */
export const REFUSED_SLOTS = ['investigations'] as const;

/** §6.3 — trust channels that may promote. `patient_reported` is off this fold entirely (D12);
 *  `inferred` never promotes anywhere. */
export const PROMOTABLE_TRUST = ['structured_db', 'clinician_documented'] as const;

export type RefusalReason =
  | 'slot_not_allowed'
  | 'trust_not_promotable'
  | 'span_unverified'
  | 'inferred'
  | 'identity_unresolved'
  | 'contamination_suspect'
  | 'empty';

export type GateResult = { ok: true } | { ok: false; reason: RefusalReason };

/** What the gate is told about one candidate fact. `sourceText` is the stored text of the field
 *  `provenance.sourceField` names — REQUIRED for an LLM-extracted fact and ignored otherwise. */
export interface PromotionCandidate {
  slot: string;
  provenance: Provenance;
  /** The text of the named source field, when the library retained it. */
  sourceText?: string | null;
  /** Set by a caller that has already verified the span itself (P2's `spanVerified`). When present
   *  it is authoritative and `sourceText` is not consulted — the library did the check with the
   *  source in hand, and re-deriving it from a summary here would be a weaker test, not a stronger. */
  spanVerified?: boolean;
  /** Whether the identity hop resolved to exactly one individual_uid. */
  identityResolved: boolean;
  /** D12 — an inferred fact never promotes, whatever else is true of it. */
  inferred?: boolean;
  /**
   * H-D5 (CDMSS-STAY-LIBRARY-HARDENING-PRD-v1.0-29-AUG-2026) — the library stamped this fact at
   * write time because the discharge summary named an operation sharing no substantive word with
   * this stay's own OT note. R10 measured that shape in production: a cholecystectomy operative
   * note printed verbatim inside a hernioplasty discharge summary. Absent or false means what it
   * meant before H2, so every fact stamped before this ship reads exactly as it did.
   */
  contaminationSuspect?: boolean;
}

/** Whitespace-insensitive verbatim containment. Case-insensitive because a source routinely
 *  re-cases a term it copied; anything looser would stop being a span check. */
function containsVerbatim(haystack: string, needle: string): boolean {
  const h = (haystack ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const n = (needle ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return n !== '' && h.includes(n);
}

/**
 * PURE — §6.3's gate. Five conditions, all of which must hold. Every failure is NAMED, so a refusal
 * can be argued with in a test rather than discovered on the spine.
 */
export function promotable(c: PromotionCandidate): GateResult {
  if (!c || !c.provenance) return { ok: false, reason: 'empty' };
  // 1 — allow-list
  if (!(PROMOTE_ALLOW_LIST as readonly string[]).includes(c.slot)) return { ok: false, reason: 'slot_not_allowed' };
  // 4 — inferred never promotes (checked early: it outranks everything else)
  if (c.inferred === true) return { ok: false, reason: 'inferred' };
  // 6 — H-D5: a contaminated discharge procedure NEVER promotes. Checked here, beside `inferred`
  // and ahead of trust and span, because that ordering IS the rule: the R10 case had a verbatim
  // span and clinician_documented trust, so a taint that only applied after conditions 2 and 3 had
  // passed would be a taint that never fired on the case it was written for. It also holds when the
  // OT row that produced the flag has since disappeared — the stamp is on the stored fact, not on
  // a comparison re-run at fold time, and a stay whose theatre record is now unreadable is not a
  // stay whose discharge became trustworthy.
  if (c.contaminationSuspect === true) return { ok: false, reason: 'contamination_suspect' };
  // 2 — trust channel
  const trust = c.provenance.trust;
  if (!trust || !(PROMOTABLE_TRUST as readonly string[]).includes(trust)) return { ok: false, reason: 'trust_not_promotable' };
  // 3 — an LLM fact needs a verified verbatim span in its NAMED source field
  if (c.provenance.extractionMethod === 'llm') {
    const verified = c.spanVerified === true
      || (typeof c.sourceText === 'string' && containsVerbatim(c.sourceText, c.provenance.rawText ?? ''));
    if (!verified) return { ok: false, reason: 'span_unverified' };
  }
  // 5 — a single resolved individual
  if (!c.identityResolved) return { ok: false, reason: 'identity_unresolved' };
  return { ok: true };
}

// ── the stay → evidence mapper ───────────────────────────────────────────────────────────

/** One procedure the stay library evidenced, as P2 recorded it (lib/stay-library/core.ts's
 *  StayProcedureFact, restated structurally so this file imports nothing from that module). */
export interface StayProcedureInput {
  conceptRaw: string;
  /** P2.1 — canonical, or absent. The library parses KX's widget; this layer never sees the raw. */
  laterality: Laterality | null;
  setting: 'ot' | 'ward' | 'unknown';
  provenance: Provenance;
  spanVerified: boolean;
  /** H-D5 — the library's write-time contamination stamp, carried through from the stored fact's
   *  passthrough. Only a discharge-sourced fact ever carries it; an OT fact is the structured row
   *  the comparison was made against. */
  contaminationSuspect?: boolean;
}

/** One medication the stay library evidenced. */
export interface StayMedicationInput {
  raw: string;
  provenance: Provenance;
  /** The stored text of the field the provenance names (the discharge list, joined). */
  sourceText?: string | null;
}

/** One problem the stay evidenced. §6.2's guard lives in the CALLER's choice of what to pass:
 *  a surgery title is never a problem unless Even coded it, so a candidate without an `icdCode`
 *  and without structured trust cannot pass condition 2/3 anyway. */
export interface StayProblemInput {
  conceptRaw: string;
  icdCode?: string | null;
  provenance: Provenance;
  sourceText?: string | null;
}

export interface StayAllergyInput {
  substanceRaw: string;
  provenance: Provenance;
  sourceText?: string | null;
}

export interface StayEvidenceInput {
  /** Opaque stay reference — the encounter id. NEVER a UHID, a name, or an individual_uid. */
  encounterRef: string;
  /** ISO date of the stay, as the source stated it. */
  date: string;
  identityResolved: boolean;
  procedures?: StayProcedureInput[];
  medications?: StayMedicationInput[];
  problems?: StayProblemInput[];
  allergies?: StayAllergyInput[];
}

export interface StayEvidenceResult {
  encounter: EncounterEvidence;
  /** Every candidate the gate refused, with its reason. Returned rather than logged so the fold's
   *  caller can report exactly what did not reach the spine and why. */
  refused: Array<{ slot: string; concept: string; reason: RefusalReason }>;
}

/**
 * PURE — one stay's promotable facts → one `kind: 'ipd'` EncounterEvidence.
 *
 * PROCEDURE PRECEDENCE (§6.2): the caller passes procedures in precedence order and this preserves
 * it — (1) an OT structured `surgery_name` at `structured_db` trust, setting 'ot'; (2) a named
 * discharge procedure at `clinician_documented`, setting 'unknown', and ONLY with a verified span;
 * (3) billing codes corroborate and are never a sole source, which is enforced by their simply not
 * being a candidate here at all. Laterality is copied, never derived — a title is not a side.
 *
 * A stay whose facts all fail the gate still yields an encounter, with empty arrays. That is
 * deliberate: `kind: 'ipd'` with nothing in it is the truthful statement "this stay is on the
 * record and evidenced nothing promotable", and it keeps `sourceEncounterRefs` honest about what
 * was considered.
 */
export function stayToEncounter(input: StayEvidenceInput): StayEvidenceResult {
  const refused: StayEvidenceResult['refused'] = [];
  const gate = (slot: PromotableSlot, concept: string, c: Omit<PromotionCandidate, 'slot' | 'identityResolved'>): boolean => {
    const r = promotable({ ...c, slot, identityResolved: input.identityResolved });
    if (!r.ok) refused.push({ slot, concept, reason: r.reason });
    return r.ok;
  };

  const procedures: EncounterProcedure[] = [];
  for (const p of input.procedures ?? []) {
    const raw = (p?.conceptRaw ?? '').trim();
    if (!raw) continue;
    if (!gate('procedures', raw, {
      provenance: p.provenance, spanVerified: p.spanVerified,
      contaminationSuspect: p.contaminationSuspect,     // H-D5 — condition 6
    })) continue;
    procedures.push({
      conceptRaw: raw,
      laterality: p.laterality ?? null,     // copied from the source row's own side field, never derived
      setting: p.setting ?? 'unknown',
      provenance: p.provenance,
    });
  }

  const medicationAssertions: EncounterEvidence['medicationAssertions'] = [];
  for (const [i, m] of (input.medications ?? []).entries()) {
    const raw = (m?.raw ?? '').trim();
    if (!raw) continue;
    if (!gate('medications', raw, { provenance: m.provenance, sourceText: m.sourceText })) continue;
    medicationAssertions.push({
      id: `ipd-med-${input.encounterRef}-${i}`,
      medicationConcept: { raw },
      // §6.2 — `prescribed` and nothing else. `administered` requires a real MAR row, and there is
      // no MAR anywhere in this substrate, so this fold has no branch that can produce one.
      status: 'prescribed',
      provenance: m.provenance,
      encounterRef: input.encounterRef,
    });
  }

  const problems: EncounterEvidence['problems'] = [];
  for (const p of input.problems ?? []) {
    const raw = (p?.conceptRaw ?? '').trim();
    if (!raw) continue;
    if (!gate('problems', raw, { provenance: p.provenance, sourceText: p.sourceText })) continue;
    problems.push({
      conceptRaw: raw,
      icdCode: p.icdCode ?? null,
      explicitStatus: null,     // a discharge diagnosis is documented, not declared active or resolved
      provenance: p.provenance,
    });
  }

  const allergyAssertions: EncounterEvidence['allergyAssertions'] = [];
  for (const [i, a] of (input.allergies ?? []).entries()) {
    const raw = (a?.substanceRaw ?? '').trim();
    if (!raw) continue;
    if (!gate('allergies', raw, { provenance: a.provenance, sourceText: a.sourceText })) continue;
    allergyAssertions.push({
      id: `ipd-allergy-${input.encounterRef}-${i}`,
      substance: { raw },
      // D13 — silence is unknown. A stay that documents an allergy asserts one; a stay that says
      // nothing asserts NOTHING, and `denied` is never synthesised from an absent allergy line.
      status: 'reported_allergy',
      provenance: a.provenance,
      encounterRef: input.encounterRef,
    });
  }

  return {
    encounter: {
      encounterRef: input.encounterRef,
      date: input.date,
      kind: 'ipd',
      problems,
      medicationAssertions,
      allergyAssertions,
      investigations: [],   // §6.2 — NOTHING new. The existing test_values_view hop is the only source.
      ...(procedures.length ? { procedures } : {}),
    },
    refused,
  };
}
