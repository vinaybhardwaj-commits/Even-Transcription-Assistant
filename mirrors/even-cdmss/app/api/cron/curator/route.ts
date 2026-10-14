export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

import { NextRequest, NextResponse } from 'next/server';
import { runCurator } from '@/lib/curator';
import { cronAuthorized } from '@/lib/cron-auth';

// Weekly Curator: discovers new harvest topics from real clinician demand.
// Same operational guard as the harvester (Authorization Bearer CRON_SECRET).
export async function GET(req: NextRequest) {
  const ok = cronAuthorized(req);
  if (!ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const days = req.nextUrl.searchParams.get('days');
  const cap = req.nextUrl.searchParams.get('cap');
  const result = await runCurator({ days: days ? Number(days) : undefined, cap: cap ? Number(cap) : undefined });
  return NextResponse.json({ ok: !result.error, ...result });
}
