// lib/clinical-state/audit-shadow-core.ts — ClinicalState shadow for the OPD note-audit
// surface (Platform B1). PURE: no db, no llm, no trace, no I/O. Round-trips a persisted
// findings array through the note-audit adapter and builds a ClinicalState, reporting
// fidelity. Shared by the read-only fidelity harness (scripts/clinical-state-audit-shadow.mjs)
// and the dormant in-pipeline shadow hook (lib/opd-audit-store.ts). It NEVER mutates its
// input — it works on a JSON clone — so wiring it into the persist seam cannot change the
// persisted audit output whether the flag is on or off.

import {
  noteAuditFindingToFinding, findingToNoteAuditFinding, type NoteAuditFindingRow,
} from './to-audit-family';
import { emptyClinicalState, stateCounts } from './schema';

export interface AuditShadowReport {
  roundtrip_ok: boolean;                 // every finding round-tripped byte-lossless
  n_findings: number;
  n_lossless: number;
  lossy_fields: Record<string, number>;  // key -> # of findings where it failed to round-trip
  counts: Record<string, number>;        // stateCounts of the built note_audit ClinicalState
}

/** Keys whose JSON projection differs between the original row and its round-tripped form
 *  (dropped, added, or value-changed). Compared over JSON.stringify so it mirrors exactly
 *  what the jsonb column stores — key order is irrelevant, value shape is not. */
export function lossyKeys(orig: Record<string, unknown>, rt: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(orig ?? {}), ...Object.keys(rt ?? {})]);
  const diff: string[] = [];
  for (const k of keys) if (JSON.stringify(orig?.[k]) !== JSON.stringify(rt?.[k])) diff.push(k);
  return diff;
}

/** Round-trip each persisted finding (noteAuditFindingToFinding → findingToNoteAuditFinding)
 *  and build a note_audit ClinicalState from the whole set. Operates on a JSON clone of the
 *  input, mirroring the persisted jsonb and guaranteeing the caller's array is untouched. */
export function auditShadowReport(findings: unknown[]): AuditShadowReport {
  const rows: NoteAuditFindingRow[] = (Array.isArray(findings) ? findings : []).map(
    (f) => JSON.parse(JSON.stringify(f)) as NoteAuditFindingRow,
  );

  const lossy: Record<string, number> = {};
  let nLossless = 0;
  for (const row of rows) {
    const rt = findingToNoteAuditFinding(noteAuditFindingToFinding(row));
    const diff = lossyKeys(row as Record<string, unknown>, rt as Record<string, unknown>);
    if (diff.length === 0) nLossless++;
    else for (const k of diff) lossy[k] = (lossy[k] ?? 0) + 1;
  }

  const state = emptyClinicalState('note_audit');
  state.positives = rows.map(noteAuditFindingToFinding);

  return {
    roundtrip_ok: rows.length > 0 ? nLossless === rows.length : true,
    n_findings: rows.length,
    n_lossless: nLossless,
    lossy_fields: lossy,
    counts: stateCounts(state),
  };
}
