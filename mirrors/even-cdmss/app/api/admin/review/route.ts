/**
 * /api/admin/review — WM6 sequential review (review/0.1). Admin-only, all three actions.
 *
 * POST {action:'start'}  opens a session over one subject's walk.
 * GET  ?session_id=      returns the session state, revealed cuts ONLY.
 * POST {action:'belief'} records one belief and advances the session.
 *
 * ⚠️ A REVEALED CUT CANNOT BE UNSEEN, and this route is where that is enforced: GET slices the
 * stored cuts at `revealed_index` and never returns one beyond it, so a reviewer cannot read ahead
 * even by calling the API directly. `revealed_index` only ever moves forward, one step at a time,
 * and only when every required belief for the current step is recorded.
 *
 * ⚠️ THE PLAIN individual_uid IS NEVER STORED. `start` resolves the subject, walks it, and writes
 * `sha256(individual_uid)` hex. The uid appears only in the db13 reads the walk itself performs,
 * which this ship does not change.
 *
 * ⚠️ NOBODY IS SCORED. Nothing here compares a belief to an outcome, to another reviewer, or to
 * CDMSS. There is no correctness field to write.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import {
  walkO, resolveWalkSubject, readWalkFlags, ipdFoldLabelFor,
  GRAIN_LABEL, HONESTY_CHIP, WORLD_MODEL_WALK_VERSION,
} from '@/lib/world-model/walk-o';
import { MEMBER_STATE_VERSION } from '@/lib/member-state/schema';
import { REVIEW_SCHEMA_VERSION } from '@/lib/cognition/schema';
import {
  advance, canRecord, classifyBelief, isReviewerRole, nextRequired, parseSecondsSpent,
  parseVariants, validateBeliefPayload,
  type BeliefKey, type ReviewCutStatus, type ReviewSession,
} from '@/lib/review/session';
import {
  beliefStats, getBelief, getSession, insertBelief, insertSession, listBeliefKeys,
  updateSessionProgress, type SessionRow,
} from '@/lib/review/store';

const ROLE_ERROR = 'reviewer_role must be consulting_physician|neurologist';

/** The stored row as the pure step model sees it: dates and statuses, no snapshots. */
function toReviewSession(row: SessionRow): ReviewSession {
  return {
    id: row.id, variants: row.variants, cutCount: row.cut_count,
    revealedIndex: row.revealed_index, status: row.status,
    cuts: row.cuts.map((c) => ({ date: c.date, status: c.status as ReviewCutStatus })),
  };
}

const bad = (error: string, status: number) => NextResponse.json({ ok: false, error }, { status });

export async function POST(req: NextRequest) {
  if (!(await isAdminUnlocked())) return bad('unauthorized', 401);

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { body = {}; }
  const action = String(body.action ?? '');
  if (action === 'start') return startSession(body);
  if (action === 'belief') return recordBelief(body);
  return bad("action must be 'start' or 'belief'", 400);
}

async function startSession(body: Record<string, unknown>) {
  if (!isReviewerRole(body.reviewer_role)) return bad(ROLE_ERROR, 400);
  const variants = parseVariants(body.variants ?? []);
  if (!variants.ok) return bad(variants.error, 400);

  const subject = await resolveWalkSubject({
    individualUid: typeof body.individual_uid === 'string' ? body.individual_uid : null,
    uhid: typeof body.uhid === 'string' ? body.uhid : null,
  });
  if (!subject.individualUid) return bad(subject.reason, 400);

  const walk = await walkO(subject.individualUid, new Date().toISOString());
  // An enumeration outage is NOT an empty history, and a session must never be opened over one.
  if (walk.enumeration.status !== 'ok') return bad('walk enumeration failed', 502);
  if (walk.cuts.length === 0) return bad('no cuts for this subject', 409);

  // Cut 0 unreadable ⇒ the session is born incomplete: there is nothing honest to ask about.
  const status = walk.cuts[0].status === 'context_fetch_failed' ? 'incomplete' : 'active';
  const row = await insertSession({
    individual_uid_hash: createHash('sha256').update(subject.individualUid).digest('hex'),
    microworld: 'headache',
    reviewer_role: body.reviewer_role,
    variants: variants.value,
    walk_version: WORLD_MODEL_WALK_VERSION,
    member_state_version: MEMBER_STATE_VERSION,
    ipd_fold: ipdFoldLabelFor(readWalkFlags()),
    cuts: walk.cuts.map((c) => ({
      date: c.date, status: c.status, snapshot: c.snapshot,
      foldNotes: c.foldNotes, foldRefused: c.foldRefused,
    })),
    cut_count: walk.cuts.length,
    status,
  });

  return NextResponse.json({
    ok: true, session_id: row.id, cut_count: row.cut_count,
    revealed_index: row.revealed_index, status: row.status,
  });
}

async function recordBelief(body: Record<string, unknown>) {
  const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
  if (!sessionId) return bad('session_id is required', 400);
  if (!isReviewerRole(body.reviewer_role)) return bad(ROLE_ERROR, 400);
  if (!Number.isInteger(body.step_index)) return bad('step_index must be an integer', 400);
  const stepIndex = body.step_index as number;
  const variantId = body.variant_id == null ? null : String(body.variant_id);
  const payload = validateBeliefPayload(body.payload);
  if (!payload.ok) return bad(payload.error, 400);
  const seconds = parseSecondsSpent(body.seconds_spent);
  if (!seconds.ok) return bad(seconds.error, 400);

  const row = await getSession(sessionId);
  if (!row) return bad('unknown session', 404);
  const session = toReviewSession(row);
  const recorded = await listBeliefKeys(sessionId);
  const key: BeliefKey = { stepIndex, variantId: variantId as BeliefKey['variantId'] };
  if (!canRecord(session, recorded, key)) return bad('step not open', 409);

  const stored = await getBelief(sessionId, stepIndex, variantId);
  const disposition = classifyBelief(stored, { payload: payload.value });
  if (disposition === 'conflict') return bad('belief already recorded', 409);
  if (disposition === 'replay') return NextResponse.json({ ok: true, replay: true });

  const written = await insertBelief({
    session_id: sessionId, step_index: stepIndex, cut_date: row.cuts[stepIndex].date,
    variant_id: key.variantId, reviewer_role: body.reviewer_role,
    payload: payload.value, seconds_spent: seconds.value,
  });
  if (!written) {
    // The step index refused the write: a double submit landed between the read above and this
    // insert. Re-read and classify — a race resolves to the same two answers, never to a 500.
    const now = await getBelief(sessionId, stepIndex, variantId);
    if (now && classifyBelief(now, { payload: payload.value }) === 'replay') {
      return NextResponse.json({ ok: true, replay: true });
    }
    return bad('belief already recorded', 409);
  }

  const after = advance(session, [...recorded, key]);
  if (after.revealedIndex !== session.revealedIndex || after.status !== session.status) {
    await updateSessionProgress(sessionId, after.revealedIndex, after.status);
  }
  return NextResponse.json({
    ok: true, replay: false, revealed_index: after.revealedIndex, status: after.status,
    next_required: after.status === 'active' ? nextRequired(after, [...recorded, key]) : null,
  });
}

export async function GET(req: NextRequest) {
  if (!(await isAdminUnlocked())) return bad('unauthorized', 401);
  return readState((req.nextUrl.searchParams.get('session_id') || '').trim());
}

async function readState(sessionId: string) {
  // No session named: the start state. This also gives the page its admin probe — the wall it
  // renders is this 401, not a second gate of its own.
  if (!sessionId) return NextResponse.json({ ok: true, session: null });

  const row = await getSession(sessionId);
  if (!row) return bad('unknown session', 404);
  const session = toReviewSession(row);
  const recorded = await listBeliefKeys(sessionId);

  return NextResponse.json({
    ok: true,
    session: {
      id: row.id,
      status: row.status,
      reviewer_role: row.reviewer_role,
      variants: row.variants,
      cut_count: row.cut_count,
      revealed_index: row.revealed_index,
      // NEVER a cut beyond revealed_index. The slice is the enforcement.
      cuts: row.cuts.slice(0, row.revealed_index + 1),
      recorded,
      next_required: row.status === 'active' ? nextRequired(session, recorded) : null,
      grain_label: GRAIN_LABEL,
      honesty_chip: HONESTY_CHIP,
      ipd_fold: row.ipd_fold,
      schema_version: REVIEW_SCHEMA_VERSION,
      // Burden figures for the closing line, and only once the session has ended. Not in the
      // kickoff's GET shape; the page's completion sentence cannot be written without them.
      stats: row.status === 'active' ? null : await beliefStats(sessionId),
    },
  });
}
