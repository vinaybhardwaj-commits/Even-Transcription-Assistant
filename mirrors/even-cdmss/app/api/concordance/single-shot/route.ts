import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { runConcordanceSingleShot } from '@/lib/concordance';
import { buildRunRecord } from '@/lib/concordance-core';
import { insertConcordanceRun } from '@/lib/concordance-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

// Admin-gated single-shot (no-interview) concordance verdict on the Mac-mini (qwen2.5:14b
// direct, no RAG/revise, ₹0). Doubles as the P0 eval route: the 26-case harness loops it.
// When the surface is LIVE (CONCORDANCE_ENABLED=1) it writes a de-identified walled run;
// while unset (eval mode) it does NOT write, so test cases never pollute the registry.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;

  let body: { result?: string; context?: string; model?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const result = (body?.result ?? '').trim();
  const context = (body?.context ?? '').trim();
  if (!result) return NextResponse.json({ ok: false, error: 'body must include { result, context }' }, { status: 400 });

  try {
    const out = await runConcordanceSingleShot(result, context, body?.model);
    if (process.env.CONCORDANCE_ENABLED === '1') {
      try { await insertConcordanceRun(buildRunRecord(result, context, out.parsed, 'single-shot')); }
      catch (e) { console.warn('[concordance] walled run insert failed:', String((e as Error).message).slice(0, 160)); }
    }
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
