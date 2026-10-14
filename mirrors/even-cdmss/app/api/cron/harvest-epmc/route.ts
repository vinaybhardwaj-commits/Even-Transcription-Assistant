export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { runHarvestEpmc } from '@/lib/harvest-epmc';

// Europe PMC literature harvest (OA full text + abstract fallback). Same execution
// guard as /api/cron/harvest: Vercel Cron (x-vercel-cron) OR Authorization: Bearer
// CRON_SECRET OR ?secret=CRON_SECRET. Not wired into vercel.json cron yet — manual
// trigger only until validated. ?topic=<id> targets one topic, ?max=<n> caps articles.
export async function GET(req: NextRequest) {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const ok = isCron || bearerOk || (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET);
  if (!ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const onlyTopicId = req.nextUrl.searchParams.get('topic');
  const onlyTopicName = req.nextUrl.searchParams.get('name');
  const max = req.nextUrl.searchParams.get('max');
  try {
    const result = await runHarvestEpmc({
      maxArticles: max ? Number(max) : 12,  // conservative default: full-text articles are heavy (~20 chunks each); the daily cron passes no ?max
      onlyTopicId: onlyTopicId ? Number(onlyTopicId) : undefined,
      onlyTopicName: onlyTopicName || undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
