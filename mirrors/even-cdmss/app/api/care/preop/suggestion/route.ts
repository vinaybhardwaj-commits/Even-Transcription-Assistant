/**
 * POST /api/care/preop/suggestion — the ONLY path from a model suggestion to a score.
 *
 * B7 measured the extraction rail disagreeing with itself on 40% of identical texts and
 * reading a proton-pump inhibitor as a peptic ulcer, so B8 demoted the model from assertor
 * to suggester. Everything it now produces sits on the case page, unscored, until a named
 * person — shown the verbatim source span — presses Confirm or Dismiss here.
 *
 * WHAT THIS ROUTE WILL NOT DO. It does not recompute, it does not write a snapshot, and it
 * does not touch an instrument. It appends ONE row to preop_suggestion_decisions. The next
 * sweep reads that row and turns a confirm into an observation with HUMAN provenance, which
 * mints a version with capture reason 'confirm'. Keeping the write and the recompute apart
 * is what stops a clinical page from becoming a place where scores are edited by hand.
 *
 * The decision is bound to the SOURCE FINGERPRINT the suggestion was made against, so a
 * later edit to the note retires the confirmation rather than silently carrying it onto
 * text nobody read.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { recordDecision, PREOP_ENGINE_VERSION } from '@/lib/preop/store';
import { isEpisodeKeyShape } from '@/lib/preop-versions-core';
import { preopAuthed, preopDecider, preopSurfaceEnabled } from '@/lib/preop/gate';
import { PREOP_DECISIONS, SUGGEST_TARGET_IDS } from '@/lib/preop-suggest-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!preopSurfaceEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!(await preopAuthed())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ error: 'bad_body' }, { status: 400 }); }

  const episodeKey = String(body.episodeKey ?? '').trim();
  const inputId = String(body.inputId ?? '').trim();
  const decision = String(body.decision ?? '').trim();
  const status = String(body.status ?? '').trim();
  const sourceFingerprint = String(body.sourceFingerprint ?? '').trim();
  const span = typeof body.span === 'string' ? body.span.slice(0, 2000) : null;
  const field = typeof body.field === 'string' ? body.field.slice(0, 120) : null;

  // Validate everything, and validate the INPUT ID against the SUGGESTION TARGET set rather
  // than against the full input space: this route may never be used to assert an input the
  // rail is not even allowed to suggest.
  if (!episodeKey || !isEpisodeKeyShape(episodeKey)) return NextResponse.json({ error: 'bad_key' }, { status: 400 });
  if (!SUGGEST_TARGET_IDS.has(inputId)) return NextResponse.json({ error: 'bad_input' }, { status: 400 });
  if (!(PREOP_DECISIONS as readonly string[]).includes(decision)) return NextResponse.json({ error: 'bad_decision' }, { status: 400 });
  if (status !== 'present' && status !== 'absent') return NextResponse.json({ error: 'bad_status' }, { status: 400 });
  if (!sourceFingerprint) return NextResponse.json({ error: 'bad_fingerprint' }, { status: 400 });

  const decidedBy = await preopDecider();
  const r = await recordDecision({ episodeKey, inputId, status, span, field, decision, decidedBy, sourceFingerprint });
  // A Confirm that vanished silently is worse than one that was refused, so this write is
  // the one place in the module that reports its own failure to the user.
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error ?? 'the decision could not be saved' }, { status: 500 });

  return NextResponse.json({
    ok: true,
    engine: PREOP_ENGINE_VERSION,
    decision, inputId, decidedBy,
    // Said plainly on the response, because the page must not imply the score just moved.
    effect: decision === 'confirm'
      ? 'recorded — the next sweep applies it as a confirmed input and mints a new snapshot version'
      : 'recorded — this suggestion will not be offered again for this version of the note',
  });
}
