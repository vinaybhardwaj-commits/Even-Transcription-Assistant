import { NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';

export const runtime = 'edge';

export async function GET() {
  const checks: Record<string, unknown> = {};
  let tooltipCacheVersion: string | null = null;

  // 1. Neon connectivity + chunk count + book count + tooltip cache version (PRD §3.14)
  try {
    const sql = neon(process.env.DATABASE_URL!);
    const start = Date.now();
    const rows = (await sql`
      SELECT COUNT(*)::int AS chunks,
             COUNT(DISTINCT book)::int AS books
      FROM mksap_chunks
    `) as Array<{ chunks: number; books: number }>;
    checks.neon = {
      status: 'ok',
      latency_ms: Date.now() - start,
      chunks: rows[0]?.chunks ?? 0,
      books: rows[0]?.books ?? 0,
    };

    // Tooltip cache version (best-effort — never breaks health on absence)
    try {
      const v = (await sql`SELECT value FROM app_settings WHERE key = 'tooltip_cache_version'`) as Array<{ value: string }>;
      tooltipCacheVersion = v[0]?.value ?? null;
    } catch {
      // app_settings table may not exist yet (pre-v8); leave as null
    }
  } catch (e) {
    checks.neon = { status: 'error', error: String((e as Error).message) };
  }

  // 2. LLM tunnel reachability — list models
  try {
    const start = Date.now();
    const base = process.env.OLLAMA_BASE_URL!;
    const r = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(8000) });
    const data = (await r.json()) as { data?: Array<{ id: string }> };
    checks.llm = {
      status: r.ok ? 'ok' : 'degraded',
      http: r.status,
      latency_ms: Date.now() - start,
      models: (data.data ?? []).map((m) => m.id).slice(0, 10),
    };
  } catch (e) {
    checks.llm = { status: 'error', error: String((e as Error).message) };
  }

  const allOk = Object.values(checks).every((c) => (c as { status: string }).status === 'ok');
  return NextResponse.json(
    {
      ok: allOk,
      checks,
      tooltip_cache_version: tooltipCacheVersion,
      timestamp: new Date().toISOString(),
    },
    { status: allOk ? 200 : 503 },
  );
}
