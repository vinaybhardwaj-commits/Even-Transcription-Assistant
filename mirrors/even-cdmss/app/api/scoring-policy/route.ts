export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/scoring-policy?note_type=discharge_summary
 *   → the active version + the working draft + the field catalogue for the screen.
 *
 * PRD §9 Phase A. Auth: admin session cookie OR ADMIN_TOKEN, matching every other admin surface in
 * this repo (lib/admin-cookie + lib/admin-gate). NOTE: the PRD §5.1 says "gated by the existing
 * admin check via getCurrentUser()" — there is no getCurrentUser() in this codebase; the actual
 * mechanism is isAdminUnlocked()/requireAdmin(). Flagged in the build report.
 *
 * Fail-safe: a read failure returns the equal-weights fallback with `fallback: true`, HTTP 200 —
 * the screen renders legacy behaviour rather than an error (PRD §8.1).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getActivePolicy, getDraft, authedAdminRequest, resolveNoteType } from '@/lib/scoring-policy/store';
import { fieldsFor, weightedKeysFor, vectorsEqual, diffVectors } from '@/lib/scoring-policy/weights';

export async function GET(req: NextRequest) {
  if (!(await authedAdminRequest(req))) return NextResponse.json({ error: 'admin required' }, { status: 401 });

  const noteType = resolveNoteType(req.nextUrl.searchParams.get('note_type'));
  const keys = weightedKeysFor(noteType);

  const [active, draft] = await Promise.all([getActivePolicy(noteType), getDraft(noteType)]);
  const candidate = draft?.vector ?? active.vector;

  return NextResponse.json({
    noteType,
    fields: fieldsFor(noteType),
    active: {
      version: active.version,
      versionString: active.versionString,
      vector: active.vector,
      rationale: active.rationale,
      publishedByName: active.publishedByName,
      publishedAt: active.publishedAt,
      fallback: active.fallback,
    },
    draft: draft ? { vector: draft.vector, updatedBy: draft.updatedBy, updatedAt: draft.updatedAt } : null,
    candidate,
    changed: !vectorsEqual(active.vector, candidate, keys),
    changedFields: diffVectors(active.vector, candidate, keys),
  });
}
