export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { fetchBilledTotal } from '@/lib/ipd-audit/billing';

/**
 * S7 — populate `billed_total` on rows audited BEFORE the billing join existed.
 *
 * New rows get billed_total at audit time (lib/ipd-audit/run.ts + the audit-now route). This
 * route is the one-shot for the pre-S7 backlog: it re-reads the db13 envelope per ip_uid and
 * writes the ₹ scalar ONLY — no LLM, no re-audit, no other column touched, so it cannot disturb
 * a single adjudicated finding.
 *
 * Rows with no ip_uid, or an admission with no billing record (~8%), stay NULL by design — the
 * panel renders that as "no linked billing record", which is a state, not an error.
 *
 *   ?dry=1     report what WOULD change (default — this route does nothing until told to)
 *   ?apply=1   write
 *   ?limit=N   cap the rows touched (default 200)
 */

async function authed(req: NextRequest): Promise<boolean> {
  const auth = req.headers.get('authorization') || '';
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  const denied = requireAdmin(req);
  if (!denied) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const apply = p.get('apply') === '1';
  const limit = Math.max(1, Math.min(500, Number(p.get('limit')) || 200));

  try {
    const rows = (await sql(
      `SELECT id, ip_uid FROM ipd_discharge_audits
       WHERE ip_uid IS NOT NULL AND billed_total IS NULL
       ORDER BY audited_at DESC LIMIT $1`,
      [limit],
    )) as unknown as Array<{ id: string; ip_uid: string }>;

    let matched = 0, written = 0, envelopeless = 0;
    const sample: Array<{ ip_uid: string; billed_total: number }> = [];

    // Serial: db13 goes through the shared Metabase session, and this is a one-shot over ~137 rows.
    for (const r of rows) {
      const total = await fetchBilledTotal(r.ip_uid).catch(() => null);
      if (total == null) { envelopeless++; continue; }
      matched++;
      if (sample.length < 5) sample.push({ ip_uid: r.ip_uid, billed_total: Math.round(total) });
      if (apply) {
        await sql(`UPDATE ipd_discharge_audits SET billed_total = $1 WHERE id = $2`, [total, r.id]);
        written++;
      }
    }

    return NextResponse.json({
      ok: true, mode: apply ? 'apply' : 'dry-run',
      candidates: rows.length, matched, envelopeless, written, sample,
      note: apply ? 'billed_total written; no other column touched' : 'dry run — pass ?apply=1 to write',
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
