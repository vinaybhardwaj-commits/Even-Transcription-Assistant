import { NextRequest, NextResponse } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { retrieveMultiQuery } from '@/lib/multi-query';
import { searchPlos, formatPlosForPrompt } from '@/lib/plos';
import { sql } from '@/lib/db';
import { COACH_MODEL, buildCoachSystemPrompt, parseLooseJson, Turn } from '@/lib/coach';
import { geminiModelFor } from '@/lib/llm';
import { startTrace, finishTrace, tracedChat, logEvent, setTraceQuestionPreview, setTraceModelSummary, setTraceFinalAnswer } from '@/lib/trace';

export const runtime = 'nodejs';
export const maxDuration = 120;

type Body = { mode?: 'topic' | 'case'; topic?: string; case_text?: string; difficulty?: 'novice' | 'intermediate' | 'advanced'; multiQuery?: boolean };

export async function POST(req: NextRequest) {
  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const mode = body.mode || 'topic';
  const subject = mode === 'case' ? (body.case_text || '').trim() : (body.topic || '').trim();
  if (!subject) return NextResponse.json({ error: 'topic or case_text required' }, { status: 400 });
  const difficulty = body.difficulty || 'intermediate';

  // v1.4 P1c: PLOS fan-out in parallel with retrieve()
  let result, plosHits;
  try {
    const useMultiQuery = body.multiQuery !== false;
    const retrievePromise = useMultiQuery
      ? retrieveMultiQuery(subject, { topK: 6, minSimilarity: 0.3, useNormativeLeg: true })
      : retrieve(subject, { topK: 6, minSimilarity: 0.3 }).then((r) => ({ hits: r.hits, variants: [subject], perVariantCounts: [r.hits.length] }));
    const [r, p] = await Promise.all([
      retrievePromise,
      searchPlos(subject, { rows: 4, yearsBack: 5 }),
    ]);
    result = { hits: r.hits };
    plosHits = p;
  } catch (e) {
    return NextResponse.json({ error: 'retrieval failed', detail: String((e as Error).message) }, { status: 500 });
  }
  const hits = result.hits;
  if (hits.length === 0 && plosHits.length === 0) {
    return NextResponse.json({ error: 'no relevant excerpts found' }, { status: 404 });
  }

  const contextBlock = hits.map((h, i) =>
    `--- Excerpt ${i + 1} (${h.book}${h.chapter ? ' · ' + h.chapter : ''}) ---\n${h.text.slice(0, 700)}`
  ).join('\n\n') + (plosHits.length ? '\n\n' + formatPlosForPrompt(plosHits) : '');

  const system = buildCoachSystemPrompt(difficulty, mode, subject);
  const userMsg = `Excerpts (your grounding, do NOT quote to the learner):\n${contextBlock}\n\nThe learner has just initiated the session. Output the FIRST coach turn — a single Socratic opener question matched to the current difficulty. Use this exact JSON shape: {"evaluation":{"correctness":"clarifying","feedback":"Session start"},"difficulty_change":"stay","mastered":false,"next_turn":{"type":"question","content":"..."}}`;

  const traceId = await startTrace('coach_start', { mode, subject, difficulty });

  // v1.7b S3: forensic capture
  await Promise.all([
    logEvent(traceId, 'request_received', null, { body, ua: req.headers.get('user-agent') || '', t: new Date().toISOString() }),
    setTraceQuestionPreview(traceId, `[${mode}] ${subject}`),
    setTraceModelSummary(traceId, { opener: COACH_MODEL }),
    logEvent(traceId, 'retrieval_hydrated', 'retrieving', {
      hits: hits.map((h) => ({
        id: h.id, book: h.book, chapter: h.chapter,
        page_start: h.page_start, page_end: h.page_end,
        chunk_type: h.chunk_type, similarity: h.similarity,
        text: h.text,
      })),
    }),
    logEvent(traceId, 'plos_search', 'retrieving', {
      query: subject.slice(0, 200),
      hit_count: plosHits.length,
      hits: plosHits.map((p) => ({ doi: p.doi, title: p.title, year: p.year, authors: p.authors, url: p.url, abstract: p.abstract })),
    }),
  ]);

  let raw = '';
  try {
    const r = await tracedChat(traceId, 'opener', {
      model: COACH_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
      temperature: 0.3,
      max_tokens: 400,
      ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
    }, { gemini: geminiModelFor('coach') });
    raw = r.choices?.[0]?.message?.content ?? '';
    const parsed = parseLooseJson(raw) as { next_turn?: { content?: string } };
    const opener = (parsed.next_turn?.content || '').trim();
    if (!opener) throw new Error('no opener generated');

    const openTurn: Turn = { role: 'coach', content: opener, timestamp: new Date().toISOString() };
    const inserted = (await (sql as unknown as (q: string, p: unknown[]) => Promise<Array<{ id: number }>>)(
      `INSERT INTO coaching_sessions (user_id, topic, difficulty, turns) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
      [1, subject, difficulty, JSON.stringify([openTurn])]
    )) as Array<{ id: number }>;

    await Promise.all([
      logEvent(traceId, 'final_answer', 'done', { answer_text: opener, char_count: opener.length }),
      setTraceFinalAnswer(traceId, opener),
    ]);
    await finishTrace(traceId, 'success');
    return NextResponse.json({
      session_id: inserted[0].id,
      topic: subject,
      mode,
      difficulty,
      opener: openTurn,
    }, { headers: { 'X-Trace-Id': traceId } });
  } catch (e) {
    await finishTrace(traceId, 'error', String((e as Error).message));
    return NextResponse.json({ error: 'LLM failure', detail: String((e as Error).message), raw: raw.slice(0, 300) }, { status: 502, headers: { 'X-Trace-Id': traceId } });
  }
}
