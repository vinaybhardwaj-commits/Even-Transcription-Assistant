import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const userId = Number(req.nextUrl.searchParams.get('user_id') ?? '1');
  const limit = Math.min(50, Number(req.nextUrl.searchParams.get('limit') ?? '20'));
  const due = (await sql`
    SELECT id, front_text, back_text, source_query_id, sm2_easiness, sm2_interval_days, sm2_repetitions, next_review_at
    FROM flashcards
    WHERE user_id = ${userId} AND next_review_at <= NOW()
    ORDER BY next_review_at ASC
    LIMIT ${limit}
  `) as Array<{ id: number; front_text: string; back_text: string; source_query_id: number | null; sm2_easiness: number; sm2_interval_days: number; sm2_repetitions: number; next_review_at: string }>;

  const totalRows = (await sql`SELECT COUNT(*)::int AS n FROM flashcards WHERE user_id = ${userId}`) as Array<{ n: number }>;
  return NextResponse.json({
    due_count: due.length,
    total_count: totalRows[0]?.n ?? 0,
    cards: due,
  });
}
