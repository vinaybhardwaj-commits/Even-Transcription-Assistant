/**
 * lib/care-tracks.ts — CCB v2 TRACK workspace assembler (WIRED).
 *
 * Ties the read-only Pulse forms (db13 `individuals-health_forms`) + the owned assignment lifecycle
 * (Neon `care_track_assignments`) to the pure evaluation engine in care-tracks-core. Returns the
 * track layer for the /care member workspace: the member's assignments (active + recent), the
 * auto-suggested track, and for the SELECTED track its rendered context + auto-evaluated
 * expectations + a "ready to archive" completion nudge. Deterministic — no LLM. Read-only on db13.
 *
 * Additive: does NOT touch CCB v1 (dossier / brief / pitch). Every id validated before SQL.
 */

import { metabaseQuery } from './metabase';
import {
  healthFormsSql, hba1cDiagnosticsSql, mapFormRow, autoTrack, trackFromReasonType,
  buildFeverContext, buildPosthospContext, buildAihsContext, evaluateExpectations, openCount,
  TRACKS, DEEP_TRACKS, isUid,
  type TrackKey, type Expectation, type TrackContext, type HealthFormRow,
} from './care-tracks-core';
import { listAssignments, type Assignment } from './care-tracks-store';

export interface TrackWorkspace {
  individual_uid: string;
  auto_track: TrackKey;
  tracks_with_forms: TrackKey[];           // tracks the member has SOURCE forms for (quick-assign)
  assignments: Assignment[];               // active first, then recent archived
  active_tracks: TrackKey[];
  selected: {
    track: TrackKey;
    source: 'assignment' | 'requested' | 'auto';
    assignment_id: string | null;          // the active assignment for this track, if any
    context: TrackContext;
    expectations: Expectation[];
    open_count: number;
    ready_to_archive: { ready: boolean; reason: string | null };
  };
  track_catalog: { key: TrackKey; label: string; short: string; anchor: string; deep: boolean }[];
}

function tracksWithForms(rows: HealthFormRow[]): TrackKey[] {
  const set = new Set<TrackKey>();
  for (const r of rows) set.add(trackFromReasonType(r.reason, r.type));
  return Array.from(set);
}

async function latestHba1c(individualUid: string): Promise<{ value: number | null; date: string | null }> {
  const rows = await metabaseQuery(hba1cDiagnosticsSql(individualUid)).catch(() => [] as Record<string, unknown>[]);
  const first = rows[0];
  return { value: null, date: first?.report_date ? String(first.report_date) : null };
}

function readyToArchive(track: TrackKey, ctx: TrackContext): { ready: boolean; reason: string | null } {
  if (track === 'fever' && ctx.fever?.recovered === true) return { ready: true, reason: 'recovered' };
  if (track === 'posthosp' && ctx.posthosp && ctx.posthosp.items.length > 0 && ctx.posthosp.items.every((i) => i.completed)) {
    return { ready: true, reason: 'completed' };
  }
  return { ready: false, reason: null };
}

/** Assemble the track workspace for a member. `requested` picks the visible track (else active, else auto). */
export async function assembleTrackWorkspace(individualUid: string, requested?: string | null): Promise<TrackWorkspace | null> {
  if (!isUid(individualUid)) return null;

  const rawRows = await metabaseQuery(healthFormsSql(individualUid)).catch(() => [] as Record<string, unknown>[]);
  const rows = rawRows.map(mapFormRow);
  const auto = autoTrack(rows);
  const withForms = tracksWithForms(rows);

  // assignment lifecycle (soft-fail if the table isn't migrated yet)
  const assignments = await listAssignments(individualUid).catch(() => [] as Assignment[]);
  const active = assignments.filter((a) => a.status === 'active');
  const activeTracks = active.map((a) => a.track);

  // choose the selected track
  const reqValid = requested && Object.prototype.hasOwnProperty.call(TRACKS, requested) ? (requested as TrackKey) : null;
  let selectedTrack: TrackKey;
  let source: 'assignment' | 'requested' | 'auto';
  if (reqValid) { selectedTrack = reqValid; source = activeTracks.includes(reqValid) ? 'assignment' : 'requested'; }
  else if (activeTracks.length) { selectedTrack = activeTracks[0]; source = 'assignment'; }
  else { selectedTrack = auto; source = 'auto'; }

  // build the selected track's context
  const context: TrackContext = {};
  if (selectedTrack === 'fever') context.fever = buildFeverContext(rows);
  else if (selectedTrack === 'posthosp') context.posthosp = buildPosthospContext(rows);
  else if (selectedTrack === 'aihs') context.aihs = buildAihsContext(rows, await latestHba1c(individualUid));

  const expectations = DEEP_TRACKS.includes(selectedTrack) ? evaluateExpectations(selectedTrack, context) : [];
  const activeForSelected = active.find((a) => a.track === selectedTrack) || null;

  return {
    individual_uid: individualUid,
    auto_track: auto,
    tracks_with_forms: withForms,
    assignments,
    active_tracks: activeTracks,
    selected: {
      track: selectedTrack,
      source,
      assignment_id: activeForSelected?.id ?? null,
      context,
      expectations,
      open_count: openCount(expectations),
      ready_to_archive: readyToArchive(selectedTrack, context),
    },
    track_catalog: (Object.keys(TRACKS) as TrackKey[]).map((k) => ({ key: k, label: TRACKS[k].label, short: TRACKS[k].short, anchor: TRACKS[k].anchor, deep: TRACKS[k].deep })),
  };
}
