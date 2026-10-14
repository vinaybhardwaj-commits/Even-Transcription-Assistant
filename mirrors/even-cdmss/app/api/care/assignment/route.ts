export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { assignTrack, archiveAssignment, reopenAssignment, transferTrack, type CloseReason } from '@/lib/care-tracks-store';

// WRITES: care-manager session or admin only (the read-only Pulse API key cannot mutate lifecycle).
async function canWrite(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

const REASONS: CloseReason[] = ['recovered', 'completed', 'transferred', 'no_longer_needed', 'other'];

/**
 * CCB v2 track-assignment lifecycle (DARK behind CCB_ENABLED).
 *   POST /api/care/assignment  { action, ... }
 *     action=assign   { individual_uid, track, anchor_ref?, opened_by? }
 *     action=archive  { id, close_reason?, closed_by? }
 *     action=reopen   { id }
 *     action=transfer { id, to_track, anchor_ref?, opened_by? }
 */
export async function POST(req: NextRequest) {
  if (process.env.CCB_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await canWrite())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }

  const action = String(body.action || '');
  const str = (k: string) => (body[k] == null ? null : String(body[k]));

  try {
    if (action === 'assign') {
      const a = await assignTrack({ individualUid: String(body.individual_uid || ''), track: String(body.track || ''), anchorRef: str('anchor_ref'), openedBy: str('opened_by') });
      return NextResponse.json({ ok: true, assignment: a });
    }
    if (action === 'archive') {
      const reason = REASONS.includes(String(body.close_reason) as CloseReason) ? (String(body.close_reason) as CloseReason) : 'other';
      const a = await archiveAssignment(String(body.id || ''), { closeReason: reason, closedBy: str('closed_by') });
      if (!a) return NextResponse.json({ error: 'assignment not found' }, { status: 404 });
      return NextResponse.json({ ok: true, assignment: a });
    }
    if (action === 'reopen') {
      const a = await reopenAssignment(String(body.id || ''));
      if (!a) return NextResponse.json({ error: 'assignment not found' }, { status: 404 });
      return NextResponse.json({ ok: true, assignment: a });
    }
    if (action === 'transfer') {
      const r = await transferTrack({ fromId: String(body.id || ''), toTrack: String(body.to_track || ''), anchorRef: str('anchor_ref'), openedBy: str('opened_by') });
      return NextResponse.json({ ok: true, ...r });
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 400 });
  }
}
