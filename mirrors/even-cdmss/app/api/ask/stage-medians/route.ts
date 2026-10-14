/**
 * v1.7 Sprint G — rolling 30-day median latency per stage (lock #25).
 * Used by the /ask progress bar + ETA. Recomputed by daily cron at 03:00 IST.
 * No auth — read-only aggregate, no PHI.
 */
import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

const FALLBACK = {
  variants: 10_000,
  retrieving: 40_000,
  reranking: 5_000,
  drafting: 50_000,
  reviewing: 30_000,
  revising: 50_000,
  total_p50: 185_000,
  total_p90: 280_000,
  computed_at: new Date(0).toISOString(),
  trace_count: 0,
};

export async function GET() {
  try {
    const rows = await sql`
      SELECT stage,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50
      FROM trace_events
      WHERE ts > NOW() - INTERVAL '30 days'
        AND latency_ms IS NOT NULL
        AND stage IS NOT NULL
        AND kind IN ('llm_response_stream_complete', 'llm_response', 'retrieval_hydrated', 'critique_parsed')
      GROUP BY stage
    ` as { stage: string; p50: number }[];

    const totals = await sql`
      SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY total_ms) AS p50,
             percentile_disc(0.9) WITHIN GROUP (ORDER BY total_ms) AS p90,
             COUNT(*)::int AS n
      FROM traces
      WHERE started_at > NOW() - INTERVAL '30 days' AND feature = 'ask' AND status = 'success'
    ` as { p50: number; p90: number; n: number }[];

    const stagesMap: Record<string, number> = {};
    for (const r of rows) stagesMap[r.stage] = Number(r.p50) || 0;

    const out = {
      variants: stagesMap['expanding'] || FALLBACK.variants,
      retrieving: stagesMap['retrieving'] || FALLBACK.retrieving,
      reranking: stagesMap['reranking'] || FALLBACK.reranking,
      drafting: stagesMap['drafting'] || stagesMap['draft'] || FALLBACK.drafting,
      reviewing: stagesMap['reviewing'] || stagesMap['critique'] || FALLBACK.reviewing,
      revising: stagesMap['revising'] || stagesMap['revision'] || FALLBACK.revising,
      total_p50: Number(totals[0]?.p50) || FALLBACK.total_p50,
      total_p90: Number(totals[0]?.p90) || FALLBACK.total_p90,
      computed_at: new Date().toISOString(),
      trace_count: totals[0]?.n || 0,
    };
    return NextResponse.json(out, { headers: { 'Cache-Control': 'public, max-age=300' } });
  } catch (e) {
    return NextResponse.json({ ...FALLBACK, error: e instanceof Error ? e.message : String(e) });
  }
}
