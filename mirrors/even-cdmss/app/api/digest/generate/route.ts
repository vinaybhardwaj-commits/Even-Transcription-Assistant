import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { parseLooseJson } from '@/lib/drugs';
import { startTrace, finishTrace, tracedChat } from '@/lib/trace';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SYSTEM = `You analyze a junior doctor's recent clinical queries and produce a shift-end learning digest.

Return ONLY this JSON, lowercase keys, no prose:
{"summary":"<one sentence: what was the shift about>","themes":["<3-5 theme bullets, each <15 words>"],"gaps":["<2-4 specific knowledge gaps, each <20 words>"],"flashcards":[{"front":"<cloze sentence with ___ blank>","back":"<the word/phrase that fills the blank>","source_query_id":<the id of the user_queries row this came from>}]}

Rules:
- Generate exactly 3-5 flashcards. Each must be a SINGLE cloze deletion (one blank per card, marked with ___).
- "front" must be a complete clinical sentence with ONE blank. "back" is the missing word/phrase only.
- Pick the highest-value gaps — clinically important, recurring themes, or where the user asked but the answer suggests partial understanding.
- "source_query_id" MUST be one of the IDs listed in the queries below. Pick the most relevant query.
- No prose outside the JSON.`;

export async function POST(req: NextRequest) {
  let body: { user_id?: number } = {};
  try { body = await req.json(); } catch {}
  const userId = body.user_id ?? 1;

  // Find last digest for this user
  const lastRows = (await sql`SELECT generated_at FROM digest_runs WHERE user_id = ${userId} ORDER BY generated_at DESC LIMIT 1`) as Array<{ generated_at: string }>;
  const fallback = new Date(Date.now() - 24 * 3600 * 1000);
  const windowStart = lastRows[0] ? new Date(lastRows[0].generated_at) : fallback;
  const windowEnd = new Date();

  // Pull queries in window — most recent first, cap 30
  const queries = (await sql`
    SELECT id, feature, query_text, expanded_query, answer_text, citation_ids, created_at
    FROM user_queries
    WHERE user_id = ${userId} AND created_at > ${windowStart.toISOString()} AND feature != 'digest_run'
    ORDER BY created_at DESC
    LIMIT 30
  `) as Array<{ id: number; feature: string; query_text: string; expanded_query: string; answer_text: string; created_at: string }>;

  if (queries.length < 3) {
    return NextResponse.json({
      not_enough_activity: true,
      query_count: queries.length,
      window_start: windowStart.toISOString(),
      message: `Only ${queries.length} ${queries.length === 1 ? 'query' : 'queries'} since ${windowStart.toLocaleString()}. Use the app a few more times and check back.`,
    });
  }

  const queryBlock = queries.map((q) => {
    const ans = (q.answer_text || '').slice(0, 400);
    return `Query ID ${q.id} (${q.feature}, ${q.created_at}):\nQ: ${q.query_text}\nA: ${ans}`;
  }).join('\n\n---\n\n');

  const traceId = await startTrace('digest_generate', { user_id: userId, window_start: windowStart.toISOString(), query_count: queries.length });
  let raw = '';
  try {
    const r = await tracedChat(traceId, 'digest', {
      model: 'llama3.1:8b',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Window: ${windowStart.toISOString()} → ${windowEnd.toISOString()}\nQuery count: ${queries.length}\n\n${queryBlock}\n\nOutput the JSON digest now.` },
      ],
      temperature: 0.3,
      max_tokens: 1500,
      ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
    });
    raw = r.choices?.[0]?.message?.content ?? '';
    const parsed = parseLooseJson(raw) as {
      summary?: string; themes?: string[]; gaps?: string[];
      flashcards?: Array<{ front?: string; back?: string; source_query_id?: number }>;
    };

    // Validate flashcards + insert
    const validIds = new Set(queries.map((q) => q.id));
    const cards = (parsed.flashcards || []).filter((c) =>
      c.front && c.back && c.front.includes('___')
    );

    const insertedIds: number[] = [];
    for (const c of cards) {
      const sourceId = validIds.has(c.source_query_id || 0) ? c.source_query_id : null;
      try {
        const rows = (await (sql as unknown as (q: string, p: unknown[]) => Promise<Array<{ id: number }>>)(
          `INSERT INTO flashcards (user_id, front_text, back_text, source_query_id, sm2_easiness, sm2_interval_days, sm2_repetitions, next_review_at)
           VALUES ($1, $2, $3, $4, 2.5, 1, 0, NOW()) RETURNING id`,
          [userId, c.front, c.back, sourceId]
        ));
        if (rows[0]?.id) insertedIds.push(rows[0].id);
      } catch {}
    }

    // Log the digest run
    const drRows = (await (sql as unknown as (q: string, p: unknown[]) => Promise<Array<{ id: number }>>)(
      `INSERT INTO digest_runs (user_id, window_start, window_end, summary, themes, gaps, flashcard_ids, query_count)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::bigint[], $8) RETURNING id`,
      [userId, windowStart.toISOString(), windowEnd.toISOString(), parsed.summary || '',
       JSON.stringify(parsed.themes || []), JSON.stringify(parsed.gaps || []), insertedIds, queries.length]
    ));

    await finishTrace(traceId, 'success');
    return NextResponse.json({
      digest_id: drRows[0]?.id,
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
      query_count: queries.length,
      summary: parsed.summary || '',
      themes: Array.isArray(parsed.themes) ? parsed.themes : [],
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
      flashcards: cards.slice(0, insertedIds.length).map((c, i) => ({
        id: insertedIds[i],
        front: c.front,
        back: c.back,
        source_query_id: validIds.has(c.source_query_id || 0) ? c.source_query_id : null,
      })),
    }, { headers: { 'X-Trace-Id': traceId } });
  } catch (e) {
    await finishTrace(traceId, 'error', String((e as Error).message));
    return NextResponse.json({ error: 'LLM failure', detail: String((e as Error).message), raw: raw.slice(0, 300) }, { status: 502, headers: { 'X-Trace-Id': traceId } });
  }
}
