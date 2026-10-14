export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * §4.5 EXCLUSION MARKING (GRADER-PROVENANCE PRD, V ruled D3, 2 Aug 2026).
 *
 * The mini backfill's deleted prod mode wrote `qwen2.5:14b` audits under the PLAIN production
 * engine label. Those rows displaced the real Gemini audits in the canonical ranking and marked
 * doctors down. This marks them excluded.
 *
 *   WHERE model LIKE 'qwen%' AND engine_version NOT LIKE '%-mini' AND excluded_reason IS NULL
 *   SET   excluded_reason = 'mini_labelled_prod_2026_08'
 *
 * NOTHING IS DELETED AND NOTHING IS RE-AUDITED (D3). Exclusion is how the 27–28 July contamination
 * was handled: the row stays for later comparison, and every read surface already filters
 * `excluded_reason IS NULL`. The grader tier in lib/audit-canonical.ts is the standing guard — this
 * route cleans up the rows written before it existed, it is not the fix.
 *
 * Read-only by default. `?apply=1` is the ONLY write switch (the house pattern).
 *   GET /api/admin/mark-mini-labelled-prod          → count what WOULD be marked
 *   GET /api/admin/mark-mini-labelled-prod?apply=1  → mark them, report the count
 *
 * Auth: Vercel cron header / Bearer|?secret=CRON_SECRET / admin session.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

const EXCLUDED_REASON = 'mini_labelled_prod_2026_08';
/** The identifying predicate, written ONCE and shared by the count and the update. */
const TARGET_WHERE =
  `model LIKE 'qwen%' AND engine_version NOT LIKE '%-mini' AND excluded_reason IS NULL`;

async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const apply = req.nextUrl.searchParams.get('apply') === '1';

  try {
    const before = await run(
      `SELECT count(*)::int AS n, count(DISTINCT uid)::int AS notes,
              min(engine_version) AS min_engine, max(engine_version) AS max_engine
         FROM opd_note_audits WHERE ${TARGET_WHERE}`, []);
    const candidates = Number(before[0]?.n ?? 0);
    const notes = Number(before[0]?.notes ?? 0);

    // How many of those notes ALSO hold a cloud row that the exclusion hands the dashboard back to.
    const displaced = await run(
      `SELECT count(*)::int AS n FROM (
         SELECT a.uid FROM opd_note_audits a
          WHERE ${TARGET_WHERE.replace(/model/g, 'a.model').replace(/engine_version/g, 'a.engine_version').replace(/excluded_reason/g, 'a.excluded_reason')}
            AND EXISTS (
              SELECT 1 FROM opd_note_audits c
               WHERE c.uid = a.uid AND c.excluded_reason IS NULL
                 AND (c.model IS NULL OR c.model NOT LIKE 'qwen%')
                 AND c.engine_version NOT LIKE '%-mini')
          GROUP BY a.uid) s`, []).catch(() => [{ n: null }]);

    if (!apply) {
      return NextResponse.json({
        ok: true, apply: false, excluded_reason: EXCLUDED_REASON,
        would_mark_rows: candidates, would_mark_notes: notes,
        notes_with_a_cloud_row_to_fall_back_to: displaced[0]?.n ?? null,
        engine_range: { min: before[0]?.min_engine ?? null, max: before[0]?.max_engine ?? null },
        note: 'DRY RUN — nothing written. Re-run with ?apply=1 to mark. Rows are never deleted or re-audited (D3).',
      });
    }

    const updated = await run(
      `UPDATE opd_note_audits SET excluded_reason = $1 WHERE ${TARGET_WHERE} RETURNING id`, [EXCLUDED_REASON]);
    const after = await run(
      `SELECT count(*)::int AS n FROM opd_note_audits WHERE ${TARGET_WHERE}`, []);

    return NextResponse.json({
      ok: true, apply: true, excluded_reason: EXCLUDED_REASON,
      marked_rows: updated.length, marked_notes: notes,
      remaining_unmarked: Number(after[0]?.n ?? 0),
      notes_with_a_cloud_row_to_fall_back_to: displaced[0]?.n ?? null,
      note: 'Marked excluded. Nothing deleted, nothing re-audited — the rows remain for comparison.',
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
