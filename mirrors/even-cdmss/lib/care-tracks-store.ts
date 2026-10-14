/**
 * lib/care-tracks-store.ts — Care Conversation Brief v2: TRACK ASSIGNMENT lifecycle (Neon, WIRED).
 *
 * The read-only Pulse forms (`individuals-health_forms`, db13) are the SOURCE; track lifecycle is
 * STATE WE OWN here in Neon — exactly how the rest of CAT layers its own state over the db13 read.
 * A care manager assigns a member to a track, archives it when done, transfers to another track,
 * and monitors a member on several ACTIVE tracks at once. UNASSIGNED POOL model (v1): no per-track
 * owner — any care manager can pick up any track; opened_by/closed_by are audit only.
 *
 * Reversible, append-only in spirit (archive, never delete). Idempotent assign (one active row per
 * member+track+anchor). Table created by /api/admin/migrate-care-tracks (ensureCareTrackTables).
 */

import { randomUUID } from 'crypto';
import { sql } from './db';
import { isUid, TRACKS, type TrackKey } from './care-tracks-core';

export type AssignmentStatus = 'active' | 'archived';
export type CloseReason = 'recovered' | 'completed' | 'transferred' | 'no_longer_needed' | 'other';

export interface Assignment {
  id: string;
  individual_uid: string;
  track: TrackKey;
  status: AssignmentStatus;
  anchor_ref: string | null;
  opened_at: string;
  opened_by: string | null;
  closed_at: string | null;
  closed_by: string | null;
  close_reason: string | null;
  next_assignment_id: string | null;
  notes: string | null;
}

const isTrack = (t: string): t is TrackKey => Object.prototype.hasOwnProperty.call(TRACKS, t);
const cleanAnchor = (a: string | null | undefined): string | null =>
  a && isUid(a) ? a : null;
const cleanActor = (a: string | null | undefined): string | null =>
  a ? String(a).slice(0, 64) : null;

export async function ensureCareTrackTables(): Promise<void> {
  await sql(`CREATE TABLE IF NOT EXISTS care_track_assignments (
    id text PRIMARY KEY,
    individual_uid text NOT NULL,
    track text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    anchor_ref text,
    opened_at timestamptz NOT NULL DEFAULT now(),
    opened_by text,
    closed_at timestamptz,
    closed_by text,
    close_reason text,
    next_assignment_id text,
    notes text,
    app_source text NOT NULL DEFAULT 'standalone'
  )`, []);
  await sql(`CREATE INDEX IF NOT EXISTS idx_cta_member ON care_track_assignments (individual_uid, status)`, []);
  // one ACTIVE assignment per member+track+anchor → idempotent assign
  await sql(`CREATE UNIQUE INDEX IF NOT EXISTS uq_cta_active
    ON care_track_assignments (individual_uid, track, coalesce(anchor_ref,'')) WHERE status = 'active'`, []);
}

function rowToAssignment(r: Record<string, unknown>): Assignment {
  return {
    id: String(r.id),
    individual_uid: String(r.individual_uid),
    track: String(r.track) as TrackKey,
    status: (String(r.status) as AssignmentStatus),
    anchor_ref: r.anchor_ref == null ? null : String(r.anchor_ref),
    opened_at: r.opened_at == null ? '' : String(r.opened_at),
    opened_by: r.opened_by == null ? null : String(r.opened_by),
    closed_at: r.closed_at == null ? null : String(r.closed_at),
    closed_by: r.closed_by == null ? null : String(r.closed_by),
    close_reason: r.close_reason == null ? null : String(r.close_reason),
    next_assignment_id: r.next_assignment_id == null ? null : String(r.next_assignment_id),
    notes: r.notes == null ? null : String(r.notes),
  };
}

const COLS = `id, individual_uid, track, status, anchor_ref, opened_at, opened_by, closed_at, closed_by, close_reason, next_assignment_id, notes`;

/** All assignments for a member — active first, then most-recently-closed. */
export async function listAssignments(individualUid: string, opts: { includeArchived?: boolean } = {}): Promise<Assignment[]> {
  if (!isUid(individualUid)) return [];
  const includeArchived = opts.includeArchived !== false;
  const rows = includeArchived
    ? await sql(`SELECT ${COLS} FROM care_track_assignments WHERE individual_uid = $1
        ORDER BY (status = 'active') DESC, coalesce(closed_at, opened_at) DESC LIMIT 50`, [individualUid])
    : await sql(`SELECT ${COLS} FROM care_track_assignments WHERE individual_uid = $1 AND status = 'active'
        ORDER BY opened_at DESC LIMIT 50`, [individualUid]);
  return (rows as Record<string, unknown>[]).map(rowToAssignment);
}

async function findActive(individualUid: string, track: TrackKey, anchor: string | null): Promise<Assignment | null> {
  const rows = await sql(`SELECT ${COLS} FROM care_track_assignments
    WHERE individual_uid = $1 AND track = $2 AND coalesce(anchor_ref,'') = coalesce($3,'') AND status = 'active' LIMIT 1`,
    [individualUid, track, anchor]);
  const list = (rows as Record<string, unknown>[]).map(rowToAssignment);
  return list[0] ?? null;
}

/** Assign a member to a track (idempotent — returns the existing active row if present). */
export async function assignTrack(input: { individualUid: string; track: string; anchorRef?: string | null; openedBy?: string | null; notes?: string | null }): Promise<Assignment> {
  if (!isUid(input.individualUid)) throw new Error('bad individual uid');
  if (!isTrack(input.track)) throw new Error('unknown track');
  const anchor = cleanAnchor(input.anchorRef);
  const existing = await findActive(input.individualUid, input.track, anchor);
  if (existing) return existing;
  const id = randomUUID();
  await sql(`INSERT INTO care_track_assignments (id, individual_uid, track, status, anchor_ref, opened_by, notes, app_source)
    VALUES ($1,$2,$3,'active',$4,$5,$6,'standalone')`,
    [id, input.individualUid, input.track, anchor, cleanActor(input.openedBy), input.notes ? String(input.notes).slice(0, 500) : null]);
  const created = await findActive(input.individualUid, input.track, anchor);
  if (!created) throw new Error('assign failed');
  return created;
}

async function getById(id: string): Promise<Assignment | null> {
  const rows = await sql(`SELECT ${COLS} FROM care_track_assignments WHERE id = $1 LIMIT 1`, [id]);
  const list = (rows as Record<string, unknown>[]).map(rowToAssignment);
  return list[0] ?? null;
}

/** Archive an active assignment (reversible via reopen). */
export async function archiveAssignment(id: string, opts: { closeReason?: CloseReason; closedBy?: string | null } = {}): Promise<Assignment | null> {
  await sql(`UPDATE care_track_assignments
    SET status = 'archived', closed_at = now(), close_reason = $2, closed_by = $3
    WHERE id = $1 AND status = 'active'`,
    [id, opts.closeReason || 'other', cleanActor(opts.closedBy)]);
  return getById(id);
}

/** Reopen an archived assignment (clears close fields). */
export async function reopenAssignment(id: string): Promise<Assignment | null> {
  await sql(`UPDATE care_track_assignments
    SET status = 'active', closed_at = NULL, close_reason = NULL, closed_by = NULL, next_assignment_id = NULL
    WHERE id = $1 AND status = 'archived'`, [id]);
  return getById(id);
}

/** Transfer: archive the current assignment (reason=transferred) AND open the new track, chained. */
export async function transferTrack(input: { fromId: string; toTrack: string; anchorRef?: string | null; openedBy?: string | null }): Promise<{ from: Assignment | null; to: Assignment }> {
  const from = await getById(input.fromId);
  if (!from) throw new Error('assignment not found');
  if (!isTrack(input.toTrack)) throw new Error('unknown track');
  const to = await assignTrack({ individualUid: from.individual_uid, track: input.toTrack, anchorRef: input.anchorRef, openedBy: input.openedBy });
  await sql(`UPDATE care_track_assignments
    SET status = 'archived', closed_at = now(), close_reason = 'transferred', closed_by = $2, next_assignment_id = $3
    WHERE id = $1 AND status = 'active'`, [input.fromId, cleanActor(input.openedBy), to.id]);
  const fromAfter = await getById(input.fromId);
  return { from: fromAfter, to };
}
