export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { runHarvest } from '@/lib/harvest';
import { cronAuthorized } from '@/lib/cron-auth';

// Daily literature harvest. Guarded operationally (this spends Ollama compute +
// NCBI quota): Authorization Bearer CRON_SECRET only. Vercel Cron sends that
// header when CRON_SECRET is set. This is execution protection, not a user gate.
export async function GET(req: NextRequest) {
  const ok = cronAuthorized(req);
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
