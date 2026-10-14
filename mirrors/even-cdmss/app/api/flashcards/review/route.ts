import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

type Rating = 'again' | 'hard' | 'good' | 'easy';
const RATING_TO_Q: Record<Rating, number> = { again: 0, hard: 3, good: 4, easy: 5 };

// Modified SM-2 with shift-worker tweak: cap first 'easy' to 4d (vs standard 6d) since gaps between
// reviews may stretch with on-call schedules.
function applySm2(easiness: number, intervalDays: number, repetitions: number, q: number, easyCap = 4) {
  let newEasiness = easiness + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (newEasiness < 1.3) newEasiness = 1.3;
  let newInterval = intervalDays;
  let newReps = repetitions;
  if (q < 3) {
    // again — reset
    newInterval = 1;
    newReps = 0;
  } else {
    newReps = repetitions + 1;
    if (newReps === 1) newInterval = 1;
    else if (newReps === 2) newInterval = Math.min(easyCap, q === 5 ? easyCap : 3);
    else newInterval = Math.round(intervalDays * newEasiness);
    if (q === 3 /* hard */) newInterval = Math.max(1, Math.round(newInterval * 0.85));
  }
  return { easiness: newEasiness, intervalDays: newInterval, repetitions: newReps };
}

export async function POST(req: NextRequest) {
  let body: { card_id?: number; rating?: Rating };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const id = Number(body.card_id);
  const rating = body.rating;
  if (!id || !rating || !(rating in RATING_TO_Q)) {
    return NextResponse.json({ error: 'card_id + rating (again|hard|good|easy) required' }, { status: 400 });
  }
  const rows = (await sql`SELECT id, sm2_easiness, sm2_interval_days, sm2_repetitions FROM flashcards WHERE id = ${id}`) as Array<{ id: number; sm2_easiness: number; sm2_interval_days: number; sm2_repetitions: number }>;
  if (rows.length === 0) return NextResponse.json({ error: 'card not found' }, { status: 404 });
  const c = rows[0];
  const next = applySm2(Number(c.sm2_easiness), Number(c.sm2_interval_days), Number(c.sm2_repetitions), RATING_TO_Q[rating]);
  const nextReviewAt = new Date(Date.now() + next.intervalDays * 86400 * 1000).toISOString();
  await (sql as unknown as (q: string, p: unknown[]) => Promise<unknown>)(
    `UPDATE flashcards SET sm2_easiness = $1, sm2_interval_days = $2, sm2_repetitions = $3, next_review_at = $4 WHERE id = $5`,
    [next.easiness, next.intervalDays, next.repetitions, nextReviewAt, id]
  );
  return NextResponse.json({
    card_id: id,
    rating,
    new_easiness: Number(next.easiness.toFixed(2)),
    new_interval_days: next.intervalDays,
    new_repetitions: next.repetitions,
    next_review_at: nextReviewAt,
  });
}
