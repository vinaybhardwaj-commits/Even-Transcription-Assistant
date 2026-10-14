/**
 * v1.7 Sprint G — bucket-pick rotating example questions.
 * Picks N random specialty buckets, then 1 random active question per bucket.
 * Default N=4 (matches the existing 4-chip layout). Lock #22.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const n = Math.min(8, Math.max(1, parseInt(url.searchParams.get('n') || '4', 10)));
  const rawSurface = (url.searchParams.get('surface') || 'ask').toLowerCase();
  const surface = (['ask', 'ddx', 'coach'].includes(rawSurface) ? rawSurface : 'ask') as 'ask' | 'ddx' | 'coach';

  try {
    const specialties = await sql`
      SELECT DISTINCT specialty FROM example_questions WHERE active = TRUE AND surface = ${surface}
    ` as { specialty: string }[];
    if (specialties.length === 0) {
      // Fallback to hardcoded set if table empty (e.g. fresh deploy pre-seed)
      return NextResponse.json({
        questions: [
          { question: 'First-line management of HFrEF NYHA III?', specialty: 'Cardiology' },
          { question: 'Workup for hyponatremia, serum osmolality 268', specialty: 'Renal' },
          { question: 'Empiric antibiotics for CAP in a 70y with COPD', specialty: 'Pulm' },
          { question: 'Distinguishing IBS from IBD in a 28y with chronic diarrhea', specialty: 'Gastro' },
        ].slice(0, n),
      });
    }
    // Shuffle specialties and take N (or fewer if not enough buckets)
    const shuffled = [...specialties].sort(() => Math.random() - 0.5).slice(0, Math.min(n, specialties.length));
    const picked = await Promise.all(shuffled.map(async ({ specialty }) => {
      const rows = await sql`
        SELECT id, question, specialty FROM example_questions
        WHERE active = TRUE AND specialty = ${specialty} AND surface = ${surface}
        ORDER BY random() LIMIT 1
      ` as { id: number; question: string; specialty: string }[];
      return rows[0] || null;
    }));
    return NextResponse.json({ questions: picked.filter(Boolean) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
