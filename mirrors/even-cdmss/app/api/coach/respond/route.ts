import { NextRequest, NextResponse } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { retrieveMultiQuery } from '@/lib/multi-query';
import { searchPlos, formatPlosForPrompt } from '@/lib/plos';
import { sql } from '@/lib/db';
import { COACH_MODEL, buildCoachSystemPrompt, buildRevealSystemPrompt, isRevealIntent, parseLooseJson, loadSession, computeAccuracy, Turn } from '@/lib/coach';
import { geminiModelFor } from '@/lib/llm';
import { startTrace, finishTrace, tracedChat, logEvent, setTraceQuestionPreview, setTraceModelSummary, setTraceFinalAnswer } from '@/lib/trace';

export const runtime = 'nodejs';
export const maxDuration = 120;

const MAX_TURNS = 15; // total messages each side combined — hard cap

export async function POST(req: NextRequest) {
  let body: { session_id?: number; user_message?: string; force_answer?: boolean; multiQuery?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const id = Number(body.session_id);
  const msg = (body.user_message || '').trim();
  if (!id) return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  // For reveal-by-button, the client may send an empty user_message — accept it.
  if (!msg && !body.force_answer) return NextResponse.json({ error: 'user_message required' }, { status: 400 });

  const sess = await loadSession(id);
  if (!sess) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  if (sess.ended_at) return NextResponse.json({ error: 'session already ended' }, { status: 409 });

  const turns: Turn[] = Array.isArray(sess.turns) ? sess.turns : [];

  // ────────────────────────────────────────────────────────────────────────────
  // REVEAL BRANCH — explicit force_answer OR phrase-detected intent
  // ────────────────────────────────────────────────────────────────────────────
  const isReveal = !!body.force_answer || isRevealIntent(msg);
  if (isReveal) {
    const lastCoachTurn = [...turns].reverse().find((t) => t.role === 'coach' && !t.is_reveal);
    const previousQuestion = lastCoachTurn?.content || '(no previous coach question found)';
    const userMsgForLog = msg || '(show answer)';
    const userTurn: Turn = { role: 'user', content: userMsgForLog, timestamp: new Date().toISOString(), revealed: true };

    // Retrieve excerpts grounded on the topic + the previous question (richer than topic alone).
    // v1.4 P1c: PLOS fan-out — uses just sess.topic (cleaner anchor than topic+question for PLOS).
    const retrievalQuery = `${sess.topic} ${previousQuestion}`;
    let hits: Awaited<ReturnType<typeof retrieve>>['hits'] = [];
    let plosHitsR: Awaited<ReturnType<typeof searchPlos>> = [];
    try {
      const useMultiQuery = body.multiQuery !== false;
      const retrievePromise = useMultiQuery
        ? retrieveMultiQuery(retrievalQuery, { topK: 6, minSimilarity: 0.3, bm25Query: sess.topic, useNormativeLeg: true })
        : retrieve(retrievalQuery, { topK: 6, minSimilarity: 0.3, bm25Query: sess.topic }).then((r) => ({ hits: r.hits }));
      const [r, p] = await Promise.all([
        retrievePromise,
        searchPlos(sess.topic, { rows: 4, yearsBack: 5 }),
      ]);
      hits = r.hits;
      plosHitsR = p;
    } catch {}
    const contextBlock = (hits.length
      ? hits.map((h, i) => `--- Excerpt ${i + 1} (${h.book}${h.chapter ? ' · ' + h.chapter : ''}) ---\n${h.text.slice(0, 700)}`).join('\n\n')
      : '(no fresh excerpts retrieved)') + (plosHitsR.length ? '\n\n' + formatPlosForPrompt(plosHitsR) : '');

    const traceId = await startTrace('coach_reveal', { session_id: id, topic: sess.topic, difficulty: sess.difficulty, previous_question_chars: previousQuestion.length });

    // v1.7b S3: forensic capture for reveal branch
    await Promise.all([
      logEvent(traceId, 'request_received', null, { body, ua: req.headers.get('user-agent') || '', t: new Date().toISOString(), branch: 'reveal' }),
      setTraceQuestionPreview(traceId, `Reveal: ${previousQuestion.slice(0, 140)}`),
      setTraceModelSummary(traceId, { reveal: COACH_MODEL }),
      logEvent(traceId, 'retrieval_hydrated', 'retrieving', {
        hits: hits.map((h) => ({
          id: h.id, book: h.book, chapter: h.chapter, similarity: h.similarity, text: h.text,
        })),
      }),
      logEvent(traceId, 'plos_search', 'retrieving', {
        query: sess.topic.slice(0, 200),
        hit_count: plosHitsR.length,
        hits: plosHitsR.map((p) => ({ doi: p.doi, title: p.title, year: p.year, authors: p.authors, url: p.url, abstract: p.abstract })),
      }),
    ]);

    let raw = '';
    try {
      const r = await tracedChat(traceId, 'reveal', {
        model: COACH_MODEL,
        messages: [
          { role: 'system', content: buildRevealSystemPrompt(sess.difficulty, sess.topic) },
          { role: 'user', content: `Previous coach question:\n${previousQuestion}\n\nExcerpts:\n${contextBlock}\n\nThe learner has explicitly requested the answer. Output the reveal JSON now.` },
        ],
        temperature: 0.3,
        max_tokens: 600,
        ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
      }, { gemini: geminiModelFor('coach') });
      raw = r.choices?.[0]?.message?.content ?? '';
      const parsed = parseLooseJson(raw) as { reveal_answer?: string; next_turn?: { content?: string } };
      const answer = (parsed.reveal_answer || '').trim() || 'Sorry — I could not generate an answer this time. Try rephrasing the question or end the session.';
      const followUp = (parsed.next_turn?.content || '').trim() || 'Want to keep going on this topic, or shift focus?';

      // Two coach turns: the revealed answer, then the next question.
      const answerTurn: Turn = { role: 'coach', content: answer, is_reveal: true, timestamp: new Date().toISOString() };
      const questionTurn: Turn = { role: 'coach', content: followUp, timestamp: new Date().toISOString() };

      const newTurns = [...turns, userTurn, answerTurn, questionTurn];
      const accuracy = computeAccuracy(newTurns);

      await (sql as unknown as (q: string, p: unknown[]) => Promise<unknown>)(
        `UPDATE coaching_sessions SET turns = $1::jsonb, accuracy = $2 WHERE id = $3`,
        [JSON.stringify(newTurns), accuracy, id]
      );

      await Promise.all([
        logEvent(traceId, 'final_answer', 'done', { answer_text: `Answer: ${answer}\n\nFollow-up: ${followUp}`, char_count: answer.length + followUp.length }),
        setTraceFinalAnswer(traceId, `Answer: ${answer} | Follow-up: ${followUp}`),
      ]);
      await finishTrace(traceId, 'success');
      return NextResponse.json({
        session_id: id,
        user_turn: userTurn,
        coach_turn: answerTurn,
        next_coach_turn: questionTurn,
        revealed: true,
        difficulty: sess.difficulty,
        difficulty_changed: false,
        accuracy: Number(accuracy.toFixed(2)),
        mastered: false,
        ended_at: null,
        outcome: null,
        is_summary: false,
      }, { headers: { 'X-Trace-Id': traceId } });
    } catch (e) {
      await finishTrace(traceId, 'error', String((e as Error).message));
      return NextResponse.json({ error: 'reveal failed', detail: String((e as Error).message), raw: raw.slice(0, 300) }, { status: 502, headers: { 'X-Trace-Id': traceId } });
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // NORMAL SOCRATIC BRANCH — original flow
  // ────────────────────────────────────────────────────────────────────────────
  const userTurn: Turn = { role: 'user', content: msg, timestamp: new Date().toISOString() };

  // Build conversation history for LLM
  const history = turns.map((t) => ({
    role: (t.role === 'coach' ? 'assistant' : 'user') as 'assistant' | 'user',
    content: t.content,
  }));

  // Retrieve fresh context based on the user's most recent message (more responsive than fixed-topic retrieval)
  const subject = `${sess.topic} ${msg}`;
  let hits: Awaited<ReturnType<typeof retrieve>>['hits'] = [];
  try { hits = (await retrieve(subject, { topK: 5, minSimilarity: 0.3 })).hits; } catch {}
  const contextBlock = hits.length
    ? hits.map((h, i) => `--- Excerpt ${i + 1} (${h.book}${h.chapter ? ' · ' + h.chapter : ''}) ---\n${h.text.slice(0, 600)}`).join('\n\n')
    : '(no fresh excerpts retrieved for this turn)';

  const system = buildCoachSystemPrompt(sess.difficulty, 'topic', sess.topic);
  const turnCount = turns.length + 1;
  const forceSummary = turnCount >= MAX_TURNS;

  const llmInput = [
    { role: 'system' as const, content: system },
    ...history,
    {
      role: 'user' as const,
      content: `Learner's latest reply: "${msg}"\n\nFresh excerpts (your grounding, do NOT quote):\n${contextBlock}\n\nEvaluate the learner's reply, decide difficulty change, then output the JSON.${forceSummary ? '\n\nNOTE: turn budget reached — set mastered=true and next_turn.type="summary".' : ''}`,
    },
  ];

  const traceId = await startTrace('coach_respond', { session_id: id, user_message: msg, turn_count: turnCount, difficulty: sess.difficulty });

  // v1.7b S3: forensic capture for normal Socratic branch
  await Promise.all([
    logEvent(traceId, 'request_received', null, { body, ua: req.headers.get('user-agent') || '', t: new Date().toISOString(), branch: 'socratic' }),
    setTraceQuestionPreview(traceId, `Turn ${turnCount}: ${msg.slice(0, 140)}`),
    setTraceModelSummary(traceId, { turn: COACH_MODEL }),
    logEvent(traceId, 'retrieval_hydrated', 'retrieving', {
      hits: hits.map((h) => ({
        id: h.id, book: h.book, chapter: h.chapter, similarity: h.similarity, text: h.text,
      })),
    }),
  ]);

  let raw = '';
  try {
    const r = await tracedChat(traceId, 'turn', {
      model: COACH_MODEL,
      messages: llmInput,
      temperature: 0.3,
      max_tokens: 500,
      ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
    }, { gemini: geminiModelFor('coach') });
    raw = r.choices?.[0]?.message?.content ?? '';
    const parsed = parseLooseJson(raw) as {
      evaluation?: { correctness?: string; feedback?: string };
      difficulty_change?: 'up' | 'down' | 'stay';
      mastered?: boolean;
      next_turn?: { type?: 'question' | 'summary'; content?: string };
    };

    // Attach evaluation onto the user turn
    if (parsed.evaluation?.correctness) {
      userTurn.evaluation = {
        correctness: (parsed.evaluation.correctness as Turn['evaluation'] extends infer T ? (T extends { correctness: infer C } ? C : never) : never) || 'partial',
        feedback: parsed.evaluation.feedback || '',
      } as Turn['evaluation'];
    }

    const coachTurn: Turn = {
      role: 'coach',
      content: (parsed.next_turn?.content || 'Could you say more about that?').trim(),
      timestamp: new Date().toISOString(),
    };

    // Apply difficulty change
    const order = ['novice', 'intermediate', 'advanced'] as const;
    let newDifficulty = sess.difficulty;
    const idx = order.indexOf(sess.difficulty);
    if (parsed.difficulty_change === 'up' && idx < 2) newDifficulty = order[idx + 1];
    if (parsed.difficulty_change === 'down' && idx > 0) newDifficulty = order[idx - 1];

    const newTurns = [...turns, userTurn, coachTurn];
    const accuracy = computeAccuracy(newTurns);
    const mastered = !!parsed.mastered || parsed.next_turn?.type === 'summary' || forceSummary;
    const ended_at = mastered ? new Date().toISOString() : null;
    const outcome = mastered ? (parsed.mastered ? 'mastered' : 'capped') : null;

    await (sql as unknown as (q: string, p: unknown[]) => Promise<unknown>)(
      `UPDATE coaching_sessions SET turns = $1::jsonb, difficulty = $2, accuracy = $3, ended_at = $4, outcome = $5 WHERE id = $6`,
      [JSON.stringify(newTurns), newDifficulty, accuracy, ended_at, outcome, id]
    );

    await Promise.all([
      logEvent(traceId, 'final_answer', 'done', { answer_text: coachTurn.content, char_count: coachTurn.content.length, mastered }),
      setTraceFinalAnswer(traceId, coachTurn.content),
    ]);
    await finishTrace(traceId, 'success');
    return NextResponse.json({
      session_id: id,
      user_turn: userTurn,
      coach_turn: coachTurn,
      difficulty: newDifficulty,
      difficulty_changed: newDifficulty !== sess.difficulty,
      accuracy: Number(accuracy.toFixed(2)),
      mastered,
      ended_at,
      outcome,
      is_summary: parsed.next_turn?.type === 'summary',
    }, { headers: { 'X-Trace-Id': traceId } });
  } catch (e) {
    await finishTrace(traceId, 'error', String((e as Error).message));
    return NextResponse.json({ error: 'LLM failure', detail: String((e as Error).message), raw: raw.slice(0, 300) }, { status: 502, headers: { 'X-Trace-Id': traceId } });
  }
}
