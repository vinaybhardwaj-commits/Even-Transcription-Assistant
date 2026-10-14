export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { refreshDoctorMetrics } from '@/lib/doctor-metrics-refresh';

/**
 * Daily refresh of doctor_operational_metrics + doctor_roster from db13 (the CDMSS cron target,
 * replacing the weekly Claude perf task). Auth: Vercel Cron header, OR Bearer/?secret=CRON_SECRET,
 * OR admin session. Read-only against db13; writes only Neon.
 */
async function authed(req: NextRequest): Promise<boolean> {
  if (req.headers.get('x-vercel-cron') !== null) return true;
  const auth = req.headers.get('authorization') || '';
  const secret = new URL(req.url).searchParams.get('secret');
  if (process.env.CRON_SECRET && (auth === `Bearer ${process.env.CRON_SECRET}` || secret === process.env.CRON_SECRET)) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  try { return NextResponse.json(await refreshDoctorMetrics()); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
