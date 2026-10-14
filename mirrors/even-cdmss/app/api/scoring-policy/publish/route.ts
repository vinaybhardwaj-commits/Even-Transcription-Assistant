export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/scoring-policy/publish   { note_type, weights, rationale, published_by_name?,
 *                                     expected_draft_updated_at? }
 *   → publish a new version (PRD §5.4).
 *
 * Any holder of an admin token may publish — no new role, no propose/ratify step (decision §1.3).
 * A written rationale of >= 10 characters is MANDATORY and is enforced here as well as in the UI,
 * because the endpoint is reachable without the UI.
 *
 * §8.6 — if `expected_draft_updated_at` is supplied and the draft has moved since, the publish is
 * REFUSED with 409 and the other editor's name/time, rather than silently overwriting their work.
 */
import { NextRequest, NextResponse } from 'next/server';
import { publishVersion, MIN_RATIONALE_CHARS, authedAdminRequest, resolveNoteType } from '@/lib/scoring-policy/store';
import { validateVector, weightedKeysFor } from '@/lib/scoring-policy/weights';
import { cleanAttribution, ATTRIBUTION_REQUIRED_ERROR } from '@/lib/admin-attribution';

export async function POST(req: NextRequest) {
  if (!(await authedAdminRequest(req))) return NextResponse.json({ error: 'admin required' }, { status: 401 });

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { body = {}; }

  const noteType = resolveNoteType(typeof body.note_type === 'string' ? body.note_type : null);
  const keys = weightedKeysFor(noteType);

  const v = validateVector(body.weights, keys);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const rationale = typeof body.rationale === 'string' ? body.rationale.trim() : '';
  if (rationale.length < MIN_RATIONALE_CHARS) {
    return NextResponse.json(
      { error: `Why are you making this change? A written rationale of at least ${MIN_RATIONALE_CHARS} characters is required.` },
      { status: 400 },
    );
  }

  // §12.4 — the self-declared author is REQUIRED wherever a rationale is required, and is rejected
  // HERE as well as in the UI: a client that skips the field must not succeed. It is an attestation,
  // not authentication (admin access is a shared token) — the label says so and so does the PRD.
  const changedBy = cleanAttribution(body.published_by_name ?? body.changedBy);
  if (!changedBy) return NextResponse.json({ error: ATTRIBUTION_REQUIRED_ERROR }, { status: 400 });

  const result = await publishVersion({
    noteType,
    vector: v.vector,
    rationale: rationale.slice(0, 4000),
    publishedBy: typeof body.published_by === 'string' ? body.published_by.slice(0, 200) : null,
    publishedByName: changedBy,
    expectedDraftUpdatedAt: typeof body.expected_draft_updated_at === 'string' ? body.expected_draft_updated_at : undefined,
  });

  if (result.staleDraft) {
    return NextResponse.json({
      error: `This draft was changed by ${result.staleDraft.updatedBy ?? 'someone else'} at ${result.staleDraft.updatedAt ?? 'an unknown time'}. Reload to see their edits.`,
      staleDraft: result.staleDraft,
    }, { status: 409 });
  }
  if (!result.ok) return NextResponse.json({ error: result.error ?? 'publish failed' }, { status: 500 });

  return NextResponse.json({
    ok: true,
    version: result.version,
    versionString: result.versionString,
    toast: `Version ${result.version} published`,
  });
}
