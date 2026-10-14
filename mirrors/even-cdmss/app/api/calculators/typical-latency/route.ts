import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'edge';

// Per PRD §14.2 — streamed-result "typically Ns" badge data.
// Returns rolling p50 wall time per feature from the last 100 successful traces.
// Falls back to a seed value if no trace data yet (the v1 typicalLatencySec from config).
const SEED_LATENCY_MS: Record<string, number> = {
  egfr: 2500,
  news2: 2000,
  abg: 25000,
  hyponatremia: 22000,
  sepsis_bundle: 800,
  calc_sidebar: 20000,
  calc_extract: 2500,
};

export async function GET(req: NextRequest) {
  const calc = req.nextUrl.searchParams.get('calc');
  if (!calc) return NextResponse.json({ error: 'calc required' }, { status: 400 });

  try {
    const rows = (await sql`
      SELECT total_ms
      FROM traces
      WHERE feature = ${calc}
        AND status = 'success'
        AND total_ms IS NOT NULL
      ORDER BY started_at DESC
      LIMIT 100
    `) as Array<{ total_ms: number }>;

    if (rows.length < 5) {
      return NextResponse.json({
        calc,
        p50_ms: SEED_LATENCY_MS[calc] ?? 5000,
        sample_size: rows.length,
        source: 'seed',
      });
    }

    const sorted = rows.map((r) => r.total_ms).sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];

    return NextResponse.json({
      calc,
      p50_ms: p50,
      p95_ms: p95,
      sample_size: rows.length,
      source: 'rolling',
    });
  } catch (e) {
    return NextResponse.json({
      calc,
      p50_ms: SEED_LATENCY_MS[calc] ?? 5000,
      sample_size: 0,
      source: 'error_fallback',
      error: String((e as Error).message),
    });
  }
}
