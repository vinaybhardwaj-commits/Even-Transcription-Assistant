/**
 * lib/preop/surface-row.ts — one stored finding row → one card row for the surface.
 *
 * The card is built from the STORED SNAPSHOT, not from the scalar columns beside it. The
 * scalars exist so the board can filter and sort in SQL; the snapshot is what the sweep
 * actually computed, and rendering from it means the board cannot drift from the engine.
 * A row whose snapshot is unreadable degrades to its scalars rather than disappearing.
 */

import type { InstrumentScore } from '../preop-instruments-core';
import type { Tier } from '../preop-tier-core';
import type { PreopCardRow } from '../preop-surface-core';
import { narrativeRenderable, type PreopNarrative } from '../preop-narrative-core';
import {
  openSuggestions, redundantSuggestions,
  type PreopDecision, type PreopSuggestion, type PreopSuggestionRecord,
} from '../preop-suggest-core';
import type { FindingRow } from './store';

function asObject(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') { try { return JSON.parse(v) as Record<string, unknown>; } catch { return null; } }
  return null;
}

function instrument(snap: Record<string, unknown> | null, key: string, lo: number | null, hi: number | null): InstrumentScore | null {
  const v = snap?.[key] as InstrumentScore | undefined;
  if (v && typeof v === 'object' && 'instrument' in v) return v;
  if (lo == null && hi == null) return null;
  // Snapshot unreadable: rebuild just enough for a chip, with an empty factor table so
  // the case page shows nothing it cannot prove rather than inventing rows.
  return {
    instrument: key === 'rcri' ? 'rcri' : key === 'mfi5' ? 'mfi5' : 'charlson',
    kind: lo === hi ? 'point' : 'range', lo, hi, missing: [], factors: [],
  };
}

export function toCardRow(r: FindingRow): PreopCardRow {
  const snap = asObject(r.snapshot);
  const pac = asObject(snap?.pac);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
  return {
    episodeKey: r.episode_key,
    patientName: r.patient_name,
    uhid: r.uhid,
    age: r.age,
    sex: r.sex,
    procedure: r.procedure,
    hospital: r.hospital,
    surgeryDate: r.surgery_date,
    tier: (r.tier as Tier | null) ?? null,
    rcri: instrument(snap, 'rcri', num(r.rcri_lo), num(r.rcri_hi)),
    mfi5: instrument(snap, 'mfi5', num(r.mfi_lo), num(r.mfi_hi)),
    charlson: instrument(snap, 'charlson', num(r.cci_lo), num(r.cci_hi)),
    needsReview: r.needs_review === true,
    bookingOnly: r.booking_only === true,
    whyLine: r.why_line,
    missingLine: r.missing_line,
    situationLine: r.situation_line,
    versionNo: r.version_no,
    reviewedAt: r.reviewed_at,
    reviewedBy: r.reviewed_by,
    reviewedVersion: r.reviewed_version,
    computedAt: r.computed_at,
    pacOnFile: r.pac_on_file === true,
    pacStatus: r.pac_status,
    pacFinalizedAt: str(r.pac_finalized_at) ?? str(pac?.finalizedAt),
    pacVerdict: r.pac_verdict,
    // A1-3's other fact. It lives in its own live-row columns, refreshed by every sweep
    // and deliberately outside the snapshot fingerprint, so a workflow transition never
    // mints a version. The snapshot is the fallback for rows written before B4.
    pacWorkflowStatus: str(r.pac_workflow_status) ?? str(pac?.workflowStatus),
    pacWorkflowLoggedAt: str(r.pac_workflow_logged_at) ?? str(pac?.workflowLoggedAt),
  };
}

/**
 * The case page additionally needs the resolved input list and the factor tables — and,
 * from B5/B6, the two rails' stored artefacts.
 *
 * The narrative is returned ONLY when it is renderable: valid by CODE's own citation check
 * AND written for the reading currently on the row. A narrative that has fallen behind its
 * score is not shrunk to a caveat, it is not returned at all; the page says the rail is
 * waiting for this version. An INVALID narrative is likewise never returned — it is stored
 * for review and that is the whole of its life (the R4-4 contract).
 */
export function caseDetail(r: FindingRow, decisions: readonly PreopDecision[] = []): {
  row: PreopCardRow;
  snapshot: Record<string, unknown> | null;
  suggestions: PreopSuggestionRecord | null;
  /** what the panel offers: suggestions nobody has confirmed or dismissed yet */
  open: PreopSuggestion[];
  /** suggestions that agreed with the record and are therefore not offered */
  redundant: number;
  /** what a decision must be bound to — null when there is no stored reading to decide on */
  sourceFingerprint: string | null;
  decisions: readonly PreopDecision[];
  narrative: PreopNarrative | null;
  narrativeState: 'none' | 'stale' | 'invalid' | 'shown';
} {
  const suggestions = asObject(r.extraction) as unknown as PreopSuggestionRecord | null;
  const stored = asObject(r.narrative) as unknown as PreopNarrative | null;
  const live = (r.snapshot_fingerprint as string | null | undefined) ?? null;
  const narrativeState: 'none' | 'stale' | 'invalid' | 'shown' =
    !stored ? 'none'
      : !stored.valid ? 'invalid'
        : narrativeRenderable(stored, live) ? 'shown' : 'stale';
  const snapshot = asObject(r.snapshot);
  // The current resolved status per input, so the panel can drop a suggestion that agrees
  // with what the record already says (see openSuggestions).
  const resolved: Record<string, string> = {};
  for (const i of (snapshot?.inputs as Array<{ inputId: string; status: string }> | undefined) ?? []) {
    resolved[i.inputId] = i.status;
  }
  return {
    row: toCardRow(r),
    snapshot,
    suggestions,
    open: openSuggestions(suggestions, decisions, resolved),
    redundant: redundantSuggestions(suggestions, resolved),
    sourceFingerprint: suggestions?.sourceFingerprint ?? null,
    decisions,
    narrative: narrativeState === 'shown' ? stored : null,
    narrativeState,
  };
}
