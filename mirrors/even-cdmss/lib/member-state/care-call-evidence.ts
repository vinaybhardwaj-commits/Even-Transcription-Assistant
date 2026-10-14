// lib/member-state/care-call-evidence.ts — Care-Call → MemberEvidence write-back loop (Amendment B).
// PURE mapper: one saved CareCallOutcome → one immutable `care_call` EncounterEvidence the FROZEN
// buildMemberState reconciles by its Stage-1-validated 1.2 rules (patient currentness overrides
// prescription; complaint resolved → documented_resolved; allergy trust-conflict → safety_critical;
// stop-then-represcribe → temporal_conflict). The frozen core is UNTOUCHED — this only produces input.
//
// IDENTIFIER-FREE: copies ONLY the derived 1.2 assertions + opaque refs (never name/mobile).
// Deterministic (no Date.now); never throws.

import type { EncounterEvidence } from './schema';
import type { CareCallOutcome } from '../care-call-core';

export function careCallOutcomeToEncounter(o: CareCallOutcome): EncounterEvidence {
  try {
    // A care call is a FRESH patient observation — date it at called_at (fall back to note_date).
    // (Dating it at the episode note_date backdated the report and could fire a spurious
    // medication/temporal_conflict against a later prescription.)
    const callDate = o.called_at && String(o.called_at).trim() ? String(o.called_at).slice(0, 10) : '';
    const noteDate = o.note_date && String(o.note_date).trim() ? String(o.note_date).slice(0, 10) : '';
    const date = callDate || noteDate;
    const d = o.derived || ({} as CareCallOutcome['derived']);
    return {
      encounterRef: String(o.id),
      date,
      kind: 'care_call',
      problems: [],
      medicationAssertions: Array.isArray(d.medications) ? d.medications : [],
      allergyAssertions: Array.isArray(d.allergies) ? d.allergies : [],
      investigations: [],
      complaintStatuses: Array.isArray(d.complaints) ? d.complaints : [],
      followUps: Array.isArray(d.followUps) ? d.followUps : [],
    };
  } catch {
    return { encounterRef: String(o?.id ?? ''), date: '', kind: 'care_call', problems: [], medicationAssertions: [], allergyAssertions: [], investigations: [], complaintStatuses: [], followUps: [] };
  }
}
