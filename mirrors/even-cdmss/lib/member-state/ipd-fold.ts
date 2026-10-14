/**
 * lib/member-state/ipd-fold.ts — the P4 fold's IMPURE half: the identity hop, and the read that
 * turns a member's stay libraries into `kind: 'ipd'` encounters
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, §6.4, D14 / O12).
 *
 * O12 puts the hop "at fold/read time in lib/member-state/member-state.ts (or a tiny sibling in the
 * same directory)". This is that sibling, so member-state.ts gains a flag branch and nothing else.
 *
 * ⚠️ IDENTITY IS THE DANGEROUS PART, AND IT FAILS CLOSED IN BOTH DIRECTIONS.
 *
 * `ipd_discharge_audits.member_id` (which P2 copied to `clinical_states.member_uid`) is a FIRESTORE
 * member document id. It is NOT an `individual_uid`, and MemberState's `memberRef` is an
 * `individual_uid`. Getting this wrong does not produce a missing fact — it produces one member's
 * operation on another member's spine, which is the worst failure this programme can have. So:
 *
 *   · The hop resolves through the MEASURED path this repo already trusts: a stay's UHIDs against
 *     `individuals.kx_uhid` / `old_kx_uhids`, narrowed in SQL and then RE-VERIFIED by exact
 *     membership in JS (lib/readmission/db13.ts's `resolveIndividualUid`, measured 46/46 on the
 *     readmission form records). The SQL only narrows; JS decides.
 *   · A member_uid is NEVER treated as an individual_uid, and there is no code path that could:
 *     the fold takes the member_uid only to FIND the stays and passes it nowhere near `memberRef`.
 *   · MORE THAN ONE resolved individual is a REFUSAL, not a choice. A household shares a member
 *     account; picking one would be the household collapse D14 forbids. Zero is also a refusal.
 *   · A stay whose identity does not resolve to exactly one individual is SKIPPED. Its
 *     ClinicalState rows stay in the library — P2 already persisted them — and nothing folds.
 *
 * ⚠️ NO EVEN ACCOUNT NUMBER ON NEON, NO individual_uid IN A PROMPT. This file reads db13 and writes
 * nothing. The `individual_uid` it resolves is returned to the caller in memory; it is never stored
 * on a Neon table and never reaches model material.
 *
 * ⚠️ INFERRED SQL: this sandbox has no live DB. Every query used here is listed verbatim in the P4
 * report, and every path fail-closes to "no fold" rather than to a guess.
 */
import { resolveIndividualUid } from '../readmission/db13';
import { procedureFactsOf, stayDocMetaOf } from '../stay-library/core';
import { readMemberStayLibraries, type MemberStayRead } from '../stay-library/member-read';
import { stayToEncounter, type StayEvidenceInput, type StayEvidenceResult } from './ipd-evidence';
import type { EncounterEvidence } from './schema';
import type { ClinicalState } from '../clinical-state/schema';

/** The flag, and the ONLY value that turns the fold on (O2). Unset, empty, 'true', '0' — all off. */
export function ipdFoldEnabled(): boolean {
  return process.env.MEMBERSTATE_IPD_FOLD === '1';
}

export interface IdentityHop {
  /** Exactly one resolved individual, or null. Null is a refusal, never a fallback. */
  individualUid: string | null;
  reason: 'resolved' | 'no_uhid' | 'unresolved' | 'ambiguous' | 'error';
  /** How many candidate individuals the hop saw. > 1 is a household and is refused. */
  candidates: number;
}

/**
 * member_uid → individual_uid, fail-closed.
 *
 * The hop is UHID-mediated because there is no direct key: `accounts-members` carries no
 * individual_uid foreign key (lib/ccb-search.ts says so in as many words, and its own member lookup
 * is a two-hop through mobile). The stay's UHIDs are read from the admission header at fold time and
 * are never stored.
 */
export async function hopMemberToIndividual(uhids: Array<string | null | undefined>): Promise<IdentityHop> {
  const ids = Array.from(new Set(uhids.filter((u): u is string => !!u && u.trim() !== '')));
  if (!ids.length) return { individualUid: null, reason: 'no_uhid', candidates: 0 };
  try {
    const uid = await resolveIndividualUid(ids);
    if (!uid) return { individualUid: null, reason: 'unresolved', candidates: 0 };
    return { individualUid: uid, reason: 'resolved', candidates: 1 };
  } catch {
    return { individualUid: null, reason: 'error', candidates: 0 };
  }
}

/** One stay, as the fold reads it back from the library. */
export type StayLibraryRead = MemberStayRead;

/**
 * Build the `kind: 'ipd'` encounters for ONE member, or [] for every refusal.
 *
 * Returns the refusals alongside, so a caller (or a later admin readout) can say exactly which
 * facts did not reach the spine and why, rather than presenting an empty fold as "nothing happened".
 */
export async function ipdEncountersForMember(individualUid: string): Promise<{
  encounters: EncounterEvidence[];
  refused: StayEvidenceResult['refused'];
  notes: string[];
}> {
  const notes: string[] = [];
  const refused: StayEvidenceResult['refused'] = [];
  if (!individualUid) return { encounters: [], refused, notes: ['no individual_uid — nothing folded'] };

  let stays: StayLibraryRead[];
  try {
    stays = await readMemberStayLibraries(individualUid);
  } catch {
    return { encounters: [], refused, notes: ['the stay library could not be read — nothing folded'] };
  }
  if (!stays.length) return { encounters: [], refused, notes: [] };

  const encounters: EncounterEvidence[] = [];
  for (const stay of stays) {
    // THE HOP RUNS PER STAY, AND IT MUST AGREE WITH THE MEMBER WE ARE FOLDING FOR.
    //
    // The forward direction (individual_uid → UHID → stays) got us here. This is the REVERSE
    // (stay UHID → individual_uid), through the measured `individuals.kx_uhid` / `old_kx_uhids`
    // path, and both directions must land on the same individual. Requiring agreement is what
    // makes a household safe: two members sharing an account can reach the same member_uid, but
    // they cannot both reverse-resolve to the same individual_uid. Any disagreement — unresolved,
    // errored, or resolved to someone else — SKIPS the stay. The ClinicalState rows stay in the
    // library; nothing folds.
    const hop = await hopMemberToIndividual(stay.uhids);
    if (!hop.individualUid || hop.individualUid !== individualUid) {
      notes.push(`stay ${stay.encounterRef}: identity did not resolve back to this member (${hop.reason}) — skipped, nothing folded`);
      continue;
    }
    const built = stayToEncounter(stayEvidenceInputFrom(stay, true));
    refused.push(...built.refused);
    encounters.push(built.encounter);
  }
  return { encounters, refused, notes };
}

/**
 * PURE — one stay's ClinicalState documents → the gate's input.
 *
 * §6.2's precedence is applied HERE, by ORDER: OT structured procedures first, then discharge-named
 * ones. Billing never appears, because a billing code is not a candidate in this function at all —
 * "corroborates only, never sole" is enforced by absence rather than by a rule that could be
 * misread.
 */
export function stayEvidenceInputFrom(stay: StayLibraryRead, identityResolved: boolean): StayEvidenceInput {
  const ok = stay.documents.filter((d) => d.status === 'ok');
  const ot = ok.filter((d) => stayDocMetaOf(d.state)?.docKind === 'ot');
  const discharge = ok.filter((d) => stayDocMetaOf(d.state)?.docKind === 'discharge');

  // Precedence rank 1, then rank 2. PAC and progress contribute NO procedure (§6.2) and are not
  // read here at all — a planned operation in a pre-anaesthetic note is a plan.
  const procedures = [...ot, ...discharge].flatMap((d) => procedureFactsOf(d.state).map((p) => ({
    conceptRaw: p.conceptRaw,
    laterality: p.laterality,
    setting: p.setting,
    provenance: p.provenance,
    spanVerified: p.spanVerified,
    // H-D5 / addendum H-A2 — the library's write-time contamination stamp, carried from the stored
    // fact's passthrough into the gate's input. It cannot travel on `provenance` (that schema is
    // `.strict()` and this ship bumps nothing), and it cannot be re-derived here: the flag is often
    // true precisely when the OT row that produced it is no longer readable. Carrying it is the
    // whole of this file's H2 change.
    contaminationSuspect: p.contaminationSuspect,
  })));

  // Medications: the discharge list only, and the source text the gate checks against is the list
  // the library actually stored — so a rawText the extractor invented cannot pass condition 3.
  const medications = discharge.flatMap((d) => {
    const sourceText = (d.state.medications ?? []).join('\n');
    return (d.state.medicationAssertions ?? []).map((m) => ({
      raw: m.medicationConcept?.raw ?? '',
      provenance: m.provenance,
      sourceText,
    }));
  });

  // Problems: §6.2's guard is that a surgery title is never a problem unless Even coded it. A
  // candidate therefore needs either an ICD code or structured trust to clear the gate, and the
  // discharge extract carries neither today — so in practice this list gates to empty. That is
  // reported rather than worked around.
  const problems = discharge.flatMap((d) => d.state.positives
    .filter((f) => f.provenance.sourceField === 'diagnosis')
    .map((f) => ({
      conceptRaw: f.concept,
      icdCode: icdOf(f.ext),
      provenance: f.provenance,
      sourceText: null,
    })));

  const allergies = discharge.flatMap((d) => (d.state.allergyAssertions ?? [])
    .filter((a) => a.status === 'reported_allergy')     // silence is unknown; `denied` never folds
    .map((a) => ({ substanceRaw: a.substance?.raw ?? '', provenance: a.provenance, sourceText: null })));

  return { encounterRef: stay.encounterRef, date: stay.date, identityResolved, procedures, medications, problems, allergies };
}

/** An Even-coded ICD on a finding's surface extension, or null. Never derived from the text. */
function icdOf(ext: unknown): string | null {
  const extra = (ext as { extra?: Record<string, unknown> } | undefined)?.extra;
  const v = extra?.icdCode ?? extra?.icd_code;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** This module writes NO SQL of its own: the reverse hop reuses lib/readmission/db13.ts's measured
 *  `resolveIndividualUid` verbatim, and the forward read belongs to lib/stay-library/member-read.ts.
 *  Exported so a test can assert the hop really is that function and not a local re-implementation. */
export const __hopSourceForTest = resolveIndividualUid;
