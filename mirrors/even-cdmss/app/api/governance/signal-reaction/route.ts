/**
 * /api/governance/signal-reaction — WM2 v1 (reaction/0.1).
 *
 * POST records what a doctor pressed on a Findings card: `already_knew`, `surprised` or `dismiss`.
 * GET reads one physician's reactions to one doctor's signals, keyed by signal_id.
 *
 * ⚠️ THIS ROUTE NOTIFIES NOBODY. A reaction is a belief record (CLINICIAN_REPORTED_BELIEF), not an
 * answer to a governance thread. It does not touch opd_gov_signal, it does not move a status, it
 * appends no lifecycle event and it writes nothing to the calibration corpus. The doctor-response
 * route remains the only writer of a thread's answer; this one only ever reads a thread to check
 * that the signal exists and belongs to the doctor named.
 *
 * One reaction per signal per physician, immutable. The same verb again is a replay (200, stored
 * row, nothing written); a different verb is a 409. Same posture as classifyDoctorResponse.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { govKeyValid } from '@/lib/gov-auth';
import { getBySignalId } from '@/lib/opd-gov-signal-store';
import { resolveInstances } from '@/lib/opd-gov-read';
import { classifyReaction, isReactionVerb } from '@/lib/cognition/reactions';
import { getReaction, insertReaction, listReactionsFor, type ReactionRow } from '@/lib/cognition/reactions-store';

const REQUIRED = 'signal_id, physician_id, cdmss_doctor_uid and reaction are required';

interface ReactionInput { signal_id?: string; physician_id?: string; cdmss_doctor_uid?: string; reaction?: string }

/** The success body for both a first press and a replay. */
function reactionBody(row: ReactionRow, replay: boolean) {
  return {
    ok: true,
    replay,
    reaction: {
      signal_id: row.signal_id,
      reference: row.reference,
      reaction: row.reaction,
      at: row.created_at,
      after_cdmss: row.after_cdmss,
    },
  };
}

export async function POST(req: NextRequest) {
  if (!govKeyValid(req) && !(await isAdminUnlocked())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  // A body that does not parse has none of the required fields, so it takes the required-fields 400
  // rather than an error string of its own.
  let body: ReactionInput = {};
  try { body = (await req.json()) as ReactionInput; } catch { body = {}; }

  const signalId = typeof body.signal_id === 'string' ? body.signal_id.trim() : '';
  const physicianId = typeof body.physician_id === 'string' ? body.physician_id.trim() : '';
  const doctorUid = typeof body.cdmss_doctor_uid === 'string' ? body.cdmss_doctor_uid.trim() : '';
  const reaction = typeof body.reaction === 'string' ? body.reaction : '';
  if (!signalId || !physicianId || !doctorUid || !reaction) {
    return NextResponse.json({ ok: false, error: REQUIRED }, { status: 400 });
  }
  if (!isReactionVerb(reaction)) {
    return NextResponse.json({ ok: false, error: 'reaction must be already_knew|surprised|dismiss' }, { status: 400 });
  }

  const signal = await getBySignalId(signalId);
  if (!signal) return NextResponse.json({ ok: false, error: 'unknown signal' }, { status: 404 });
  if (signal.doctor_uid !== doctorUid) {
    return NextResponse.json({ ok: false, error: 'doctor_uid does not match the signal' }, { status: 403 });
  }

  const stored = await getReaction(signalId, physicianId);
  const disposition = classifyReaction(stored, reaction);
  if (disposition === 'conflict') return NextResponse.json({ ok: false, error: 'reaction already recorded' }, { status: 409 });
  if (disposition === 'replay') return NextResponse.json(reactionBody(stored!, true));

  // The audit instance this card was showing, recorded so WM3 can join the reaction to what the
  // doctor was actually looking at. NULL means "could not resolve", never "there was none".
  let clinicalStateRef: string | null = null;
  try {
    const { representative } = await resolveInstances(signal.doctor_uid, signal.signal_type, signal.window_from, signal.window_to);
    clinicalStateRef = representative?.audit_id ?? null;
  } catch { clinicalStateRef = null; }

  const written = await insertReaction({
    signal_id: signalId, reference: signal.reference, clinical_state_ref: clinicalStateRef,
    cdmss_doctor_uid: doctorUid, physician_id: physicianId, reaction,
  });
  if (written) return NextResponse.json(reactionBody(written, false));

  // The identity index refused the write: another request for the same (signal, physician) landed
  // between the read above and this insert. Re-read and classify again — a race must resolve to the
  // same two answers a sequential pair of requests would have given, never to a 500.
  const now = await getReaction(signalId, physicianId);
  if (now && classifyReaction(now, reaction) === 'replay') return NextResponse.json(reactionBody(now, true));
  return NextResponse.json({ ok: false, error: 'reaction already recorded' }, { status: 409 });
}

export async function GET(req: NextRequest) {
  if (!govKeyValid(req) && !(await isAdminUnlocked())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const doctorUid = (req.nextUrl.searchParams.get('doctor_uid') || '').trim();
  const physicianId = (req.nextUrl.searchParams.get('physician_id') || '').trim();
  if (!doctorUid || !physicianId) {
    return NextResponse.json({ ok: false, error: 'doctor_uid and physician_id required' }, { status: 400 });
  }

  const rows = await listReactionsFor(doctorUid, physicianId);
  const reactions: Record<string, { reaction: string; at: string }> = {};
  for (const r of rows) reactions[r.signal_id] = { reaction: r.reaction, at: r.created_at };
  return NextResponse.json({ ok: true, reactions });
}
