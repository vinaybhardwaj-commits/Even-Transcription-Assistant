export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * READMISSION AGENT HEALTH (READMIT-OBSERVABILITY, 13 Oct 2026). GET. 200 when green, 503 when red,
 * so an external uptime check sees it. Counts and timestamps only: no ids, no uhids, no text.
 * Auth: Vercel cron header / Bearer|?secret=CRON_SECRET / admin session (same as readmission-refresh).
 */
import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { readReadmissionHealth } from '@/lib/readmission/health';

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
  try {
    const h = await readReadmissionHealth();
    return NextResponse.json(
      { status: h.status, reasons: h.reasons, ages: h.ages, counts: h.counts, bedrock: h.bedrock },
      { status: h.status === 'green' ? 200 : 503 },
    );
  } catch {
    return NextResponse.json({ status: 'red', reasons: ['health route error'] }, { status: 503 });
  }
}
