export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { runHarvest } from '@/lib/harvest';

// Daily literature harvest. Guarded operationally (this spends Ollama compute +
// NCBI quota): runs only for Vercel Cron (un-spoofable x-vercel-cron header) or
// a manual trigger carrying ?secret=CRON_SECRET. This is execution protection,
// not a user gate — the admin VIEW stays open per spec.
export async function GET(req: NextRequest) {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const ok = isCron || bearerOk || (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET);
  if (!ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!process.env.NCBI_API_KEY) {
    // not fatal (anon 3 req/s still works) — just a heads-up in the response
  }
  const onlyTopicId = req.nextUrl.searchParams.get('topic');
  const max = req.nextUrl.searchParams.get('max');
  try {
    const result = await runHarvest({
      maxInserts: max ? Number(max) : 80,
      onlyTopicId: onlyTopicId ? Number(onlyTopicId) : undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
