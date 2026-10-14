export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST / PUT /api/ipd-audit/review   { auditId, note, reviewedByName? }
 *   → save Dr. Binita's overall review of one IPD audit (PRD §6.4).
 *
 * The row is `ipd_audit_feedback` with `kind='review'` and `finding_ref` NULL. Its EXISTENCE is the
 * reviewed marker — there is no separate flag to drift out of sync with the note.
 *
 * "The note is per-audit and editable; edits overwrite in place and update the timestamp" (§6.4),
 * so this is UPDATE-then-INSERT rather than the append-only posture of the per-finding triage. The
 * partial unique index from 0028 makes one-review-per-audit structural.
 *
 * ⚠️ `verdict` is NOT NULL in migrations/0014 and a review has no verdict, so review rows carry the
 * literal `'review'`. The existing per-finding readers filter on the adjudication vocabulary
 * (true_positive | nitpick | false | contested | agree | disagree | needs_action), which 'review'
 * never matches — the two kinds cannot contaminate each other. Recorded in 0028's comments too.
 *
 * DELETE clears a review (un-marks the audit as reviewed).
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { cleanAttribution, ATTRIBUTION_REQUIRED_ERROR } from '@/lib/admin-attribution';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);
// NOT exported: Next.js validates route modules and rejects any export that is not a handler or a
// known config field. `verdict` is NOT NULL in migrations/0014 and a review has none, so review
// rows carry the literal 'review' — see the docblock above and 0028's comments.
const REVIEW_VERDICT = 'review';
const REVIEW_KIND = 'review';

async function authed(req: NextRequest): Promise<boolean> {
  const denied = requireAdmin(req);
  return !denied || (await isAdminUnlocked().catch(() => false));
}

async function save(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ ok: false, error: 'admin required' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const auditId = typeof body.auditId === 'string' ? body.auditId.trim() : '';
  if (!isUuid(auditId)) return NextResponse.json({ ok: false, error: 'bad auditId' }, { status: 400 });

  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 4000) : '';
  if (!note) return NextResponse.json({ ok: false, error: 'A review note is required.' }, { status: 400 });

  // §12.4 — the reviewer's self-declared name is REQUIRED alongside the note, and rejected here as
  // well as in the UI. An attestation, not authentication: admin access is a shared token.
  const reviewedByName = cleanAttribution(body.reviewedByName ?? body.changedBy);
  if (!reviewedByName) return NextResponse.json({ ok: false, error: ATTRIBUTION_REQUIRED_ERROR }, { status: 400 });

  try {
    // Overwrite in place, updating the timestamp (§6.4).
    const updated = await run(
      `UPDATE ipd_audit_feedback
          SET note = $2, reviewed_by_name = $3, created_at = NOW()
        WHERE audit_id = $1 AND kind = $4
        RETURNING id`,
      [auditId, note, reviewedByName, REVIEW_KIND],
    );
    if (!updated.length) {
      await run(
        `INSERT INTO ipd_audit_feedback (audit_id, finding_ref, verdict, note, kind, reviewed_by_name)
         VALUES ($1, NULL, $2, $3, $4, $5)`,
        [auditId, REVIEW_VERDICT, note, REVIEW_KIND, reviewedByName],
      );
    }
    const row = await run(
      `SELECT note, reviewed_by_name,
              to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS created_at
         FROM ipd_audit_feedback WHERE audit_id = $1 AND kind = $2 LIMIT 1`,
      [auditId, REVIEW_KIND],
    );
    const r = row[0];
    return NextResponse.json({
      ok: true,
      review: r ? { note: String(r.note ?? ''), reviewedByName: r.reviewed_by_name == null ? null : String(r.reviewed_by_name), at: r.created_at == null ? null : String(r.created_at) } : null,
    });
  } catch (e) {
    // Most likely cause before 0028 runs: `kind` does not exist yet. Say so plainly rather than
    // returning a bare 500 — the reviewer's text is still in the textarea either way.
    const msg = String((e as Error)?.message ?? e);
    const needsMigration = /column .*kind.* does not exist/i.test(msg);
    return NextResponse.json({
      ok: false,
      error: needsMigration
        ? 'Reviews are not enabled yet — migration 0028_review_notes.sql has not been run.'
        : `Could not save the review: ${msg.slice(0, 200)}`,
    }, { status: 500 });
  }
}

export const POST = save;
export const PUT = save;

export async function DELETE(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ ok: false, error: 'admin required' }, { status: 401 });
  const auditId = (req.nextUrl.searchParams.get('auditId') ?? '').trim();
  if (!isUuid(auditId)) return NextResponse.json({ ok: false, error: 'bad auditId' }, { status: 400 });
  try {
    await run(`DELETE FROM ipd_audit_feedback WHERE audit_id = $1 AND kind = $2`, [auditId, REVIEW_KIND]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message).slice(0, 200) }, { status: 500 });
  }
}
