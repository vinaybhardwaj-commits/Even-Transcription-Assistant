export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { mineAndSaveProposals } from '@/lib/learning';
import { DEFAULT_THRESHOLDS, DEFAULT_GAP_THRESHOLDS } from '@/lib/learning-core';
import { isAdminUnlocked } from '@/lib/admin-cookie';

// Run the learning miner (LL.2-v1): scan recent audits → upsert candidate rule proposals into
// the review queue. Spends NO LLM (deterministic clustering) and writes ONLY to
// learning_proposals — never to lvc_recommendations or the live engine. Auth: Vercel Cron
// header, OR Bearer/?secret=CRON_SECRET, OR a logged-in admin session.
async function authed(req: NextRequest): Promise<boolean> {
  if (req.headers.get('x-vercel-cron') !== null) return true;
  const auth = req.headers.get('authorization') || '';
  const secret = req.nextUrl.searchParams.get('secret');
  if (process.env.CRON_SECRET && (auth === `Bearer ${process.env.CRON_SECRET}` || secret === process.env.CRON_SECRET)) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const days = Math.max(1, Math.min(365, Number(p.get('days') || 90)));
  const minOccurrences = Math.max(1, Number(p.get('minOcc') || DEFAULT_THRESHOLDS.minOccurrences));
  const minDoctors = Math.max(1, Number(p.get('minDoctors') || DEFAULT_THRESHOLDS.minDoctors));
  // Harvest-gap floor is tunable independently (admin preview); production default 10/3.
  const minGapOcc = Math.max(1, Number(p.get('minGapOcc') || DEFAULT_GAP_THRESHOLDS.minOccurrences));
  const minGapDoctors = Math.max(1, Number(p.get('minGapDoctors') || DEFAULT_GAP_THRESHOLDS.minDoctors));
  try {
    const gapThresholds = { minOccurrences: minGapOcc, minDoctors: minGapDoctors, requireCitation: false };
    const summary = await mineAndSaveProposals(days, { minOccurrences, minDoctors, requireCitation: true }, true, gapThresholds);
    return NextResponse.json({ ok: true, days, thresholds: { minOccurrences, minDoctors, requireCitation: true }, gapThresholds, ...summary });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
