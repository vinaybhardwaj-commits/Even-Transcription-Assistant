export const dynamic = 'force-dynamic';
export const maxDuration = 120;

import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { TEXT_MODEL, geminiModelFor } from '@/lib/llm';
import { startTrace, logEvent, finishTrace, tracedChat, setTraceQuestionPreview, setTraceFinalAnswer } from '@/lib/trace';

type SrcRow = {
  id: number; book: string; chapter: string | null;
  page_start: number | null; item_number: string | null; text: string;
};

// Practice: pick a random MKSAP-19 passage, generate a single-best-answer MCQ.
// Returns { mcq, source }. Fully traced (feature='practice').
export async function POST(req: Request) {
  let traceId: string | undefined;
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const book = String((body as { book?: unknown }).book ?? '').trim();

    traceId = await startTrace('practice', { book: book || null });
    await Promise.all([
      logEvent(traceId, 'request_received', null, { body, ua: req.headers.get('user-agent') || '', t: new Date().toISOString() }),
      setTraceQuestionPreview(traceId, book ? `Practice MCQ · ${book}` : 'Practice MCQ · random'),
    ]);

    const rows = (book
      ? await sql`SELECT id, book, chapter, page_start, item_number, text FROM mksap_chunks
                  WHERE source = 'mksap-19' AND book = ${book} AND char_length(text) > 400
                  ORDER BY random() LIMIT 1`
      : await sql`SELECT id, book, chapter, page_start, item_number, text FROM mksap_chunks
                  WHERE source = 'mksap-19' AND char_length(text) > 400
                  ORDER BY random() LIMIT 1`) as SrcRow[];

    if (!rows.length) {
      await finishTrace(traceId, 'error', 'no source material found');
      return NextResponse.json({ error: 'no source material found' }, { status: 404 });
    }
    const src = rows[0];
    await logEvent(traceId, 'retrieval_hydrated', 'retrieving', {
      mode: 'random_mksap', hit_count: 1,
      hits: [{ id: src.id, book: src.book, chapter: src.chapter, page_start: src.page_start, item_number: src.item_number, text: String(src.text).slice(0, 600) }],
    });

    const system =
      'You are a medical board examiner. From the provided MKSAP excerpt, write ONE high-quality single-best-answer ' +
      'multiple-choice question with four options (A-D), exactly one correct, and a concise rationale explaining why the ' +
      'correct answer is right and the others are wrong. Base it strictly on the excerpt. ' +
      'Respond ONLY with JSON of the form: ' +
      '{"question": string, "options": {"A": string, "B": string, "C": string, "D": string}, "correct": "A"|"B"|"C"|"D", "rationale": string}.';
    const user = `Excerpt (from ${src.book}${src.chapter ? ', ' + src.chapter : ''}):\n${src.text}`;

    // Governed envelope (Stage 4): tracedChat logs its own llm_request/llm_response on the
    // 'drafting' stage (richer — real served model, provider, usage), replacing the manual
    // pair that assumed TEXT_MODEL even when Gemini served the call.
    const res = await tracedChat(traceId, 'drafting', {
      model: TEXT_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.4,
    }, { gemini: geminiModelFor('practice') });
    let raw = (res.choices?.[0]?.message?.content ?? '').trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    const mcq = JSON.parse(match ? match[0] : raw);

    await logEvent(traceId, 'final_answer', 'done', { answer_text: JSON.stringify(mcq), char_count: JSON.stringify(mcq).length });
    await setTraceFinalAnswer(traceId, typeof mcq?.question === 'string' ? mcq.question : 'MCQ generated');
    await finishTrace(traceId, 'success');

    return NextResponse.json({
      mcq,
      source: { id: src.id, book: src.book, chapter: src.chapter, page_start: src.page_start, item_number: src.item_number, text: src.text },
    });
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message));
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
