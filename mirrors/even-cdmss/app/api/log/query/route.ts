import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

type Body = {
  feature: string;
  query_text: string;
  expanded_query?: string;
  answer_text?: string;
  citation_ids?: number[];
  duration_ms?: number;
  session_id?: string;
  user_id?: number;
  meta?: Record<string, unknown>;
};

export async function POST(req: NextRequest) {
  let b: Body;
  try { b = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  if (!b.feature || !b.query_text) return NextResponse.json({ error: 'feature + query_text required' }, { status: 400 });
  try {
    const rows = (await (sql as unknown as (q: string, p: unknown[]) => Promise<Array<{ id: number }>>)(
      `INSERT INTO user_queries
        (user_id, session_id, feature, query_text, expanded_query, answer_text, citation_ids, duration_ms, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [b.user_id ?? 1, b.session_id ?? null, b.feature, b.query_text, b.expanded_query ?? null,
       b.answer_text ?? null, b.citation_ids ?? null, b.duration_ms ?? null, b.meta ? JSON.stringify(b.meta) : null]
    )) as Array<{ id: number }>;
    return NextResponse.json({ ok: true, id: rows[0]?.id });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 500 });
  }
}
