export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PUT /api/scoring-policy/draft   { note_type, weights }
 *   → upsert the shared working draft (PRD §5.3 — one draft per note type, §8.6).
 *
 * Saving a draft NEVER changes a score: only a published, active version is read by the scoring
 * paths. A failure to save returns 200 with `saved: false` so the screen can warn without losing
 * the user's edits.
 */
import { NextRequest, NextResponse } from 'next/server';
import { saveDraft, getDraft, authedAdminRequest, resolveNoteType } from '@/lib/scoring-policy/store';
import { validateVector, weightedKeysFor } from '@/lib/scoring-policy/weights';

export async function PUT(req: NextRequest) {
  if (!(await authedAdminRequest(req))) return NextResponse.json({ error: 'admin required' }, { status: 401 });

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { body = {}; }

  const noteType = resolveNoteType(typeof body.note_type === 'string' ? body.note_type : null);
  const keys = weightedKeysFor(noteType);
  const v = validateVector(body.weights, keys);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const by = typeof body.updated_by === 'string' ? body.updated_by.slice(0, 200) : null;
  const saved = await saveDraft(noteType, v.vector, by);
  const draft = saved ? await getDraft(noteType) : null;

  return NextResponse.json({
    saved,
    noteType,
    updatedAt: draft?.updatedAt ?? null,
    ...(saved ? {} : { error: 'The draft could not be saved. Your edits are still on screen; scores are unaffected.' }),
  });
}
