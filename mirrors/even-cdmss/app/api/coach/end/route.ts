import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { retrieve } from '@/lib/retrieve';
import { searchPlos } from '@/lib/plos';
import { COACH_MODEL, loadSession, computeAccuracy } from '@/lib/coach';
import { geminiModelFor } from '@/lib/llm';
import { startTrace, finishTrace, tracedChat, logEvent, setTraceQuestionPreview, setTraceSeverity, setTraceModelSummary, setTraceFinalAnswer } from '@/lib/trace';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SUMMARY_SYSTEM = `You are a teaching coach wrapping up a Socratic session. Return ONLY this JSON:
{"summary":"<one sentence>","concepts_mastered":["<bullet>"],"gaps":["<bullet>"],"suggested_next":"<one topic to explore next>"}
- 3-5 items per array max. Each item under 20 words.
- "summary" reflects overall progress in one sentence.
- No prose outside the JSON.`;

const COACH_CRITIQUE_SYSTEM = `You are auditing a draft session-summary written by a Socratic teaching coach.

You'll receive the transcript and the draft JSON. Identify problems and output ONLY this JSON:
{
  "ungrounded_concepts": ["a 'mastered' concept that the learner never actually demonstrated in the transcript"],
  "missed_gaps": ["a gap visible in the transcript that the draft missed"],
  "suggested_next_problems": ["if suggested_next is off-topic, too vague, or already-mastered"],
  "summary_inaccurate": ["if the one-line summary misrepresents how the session actually went"],
  "needs_revision": true | false
}
Empty arrays are fine. needs_revision=true if ANY array has entries. Be specific.`;

const COACH_REVISION_SYSTEM = `You are revising your coach session summary based on an auditor critique.
Output the FINAL JSON in exactly this shape (no prose):
{"summary":"<one sentence>","concepts_mastered":["<bullet>"],"gaps":["<bullet>"],"suggested_next":"<one topic>"}
Apply every fix: drop ungrounded concepts, add missed gaps, replace bad suggested_next, correct the summary.`;

export async function POST(req: NextRequest) {
  let body: { session_id?: number; selfCritique?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const id = Number(body.session_id);
  if (!id) return NextResponse.json({ error: 'session_id required' }, { status: 400 });

  const sess = await loadSession(id);
  if (!sess) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  // v1.4 P1c: fetch source recap (textbook + PLOS) for the end-of-session drawer.
  // Fresh re-fetch by topic — cheap, no schema changes, gives a representative view
  // of what content was available to ground this session.
  let recapHits: Awaited<ReturnType<typeof retrieve>>['hits'] = [];
  let recapPlos: Awaited<ReturnType<typeof searchPlos>> = [];
  try {
    const [r, p] = await Promise.all([
      retrieve(sess.topic, { topK: 6, minSimilarity: 0.3 }),
      searchPlos(sess.topic, { rows: 5, yearsBack: 5 }),
    ]);
    recapHits = r.hits;
    recapPlos = p;
  } catch { /* recap is best-effort; never blocks the end-of-session summary */ }

  const transcript = (sess.turns || []).map((t) => `${t.role.toUpperCase()}: ${t.content}`).join('\n\n');
  const accuracy = computeAccuracy(sess.turns || []);

  const useSelfCritique = body.selfCritique !== false;  // default true
  const traceId = await startTrace('coach_end', { session_id: id, topic: sess.topic, difficulty: sess.difficulty, accuracy, selfCritique: useSelfCritique });

  // v1.7b S3: forensic capture
  await Promise.all([
    logEvent(traceId, 'request_received', null, { body, ua: req.headers.get('user-agent') || '', t: new Date().toISOString() }),
    setTraceQuestionPreview(traceId, `End summary: ${sess.topic.slice(0, 140)}`),
    setTraceModelSummary(traceId, { draft: COACH_MODEL, critique: COACH_MODEL, revise: COACH_MODEL }),
    logEvent(traceId, 'retrieval_hydrated', 'retrieving', {
      hits: recapHits.map((h) => ({
        id: h.id, book: h.book, chapter: h.chapter, similarity: h.similarity, text: h.text,
      })),
    }),
    logEvent(traceId, 'plos_search', 'retrieving', {
      query: sess.topic.slice(0, 200),
      hit_count: recapPlos.length,
      hits: recapPlos.map((p) => ({ doi: p.doi, title: p.title, year: p.year, authors: p.authors, url: p.url, abstract: p.abstract })),
    }),
  ]);

  let raw = '';
  let critiqueJson: { ungrounded_concepts?: string[]; missed_gaps?: string[]; suggested_next_problems?: string[]; summary_inaccurate?: string[]; needs_revision?: boolean } | null = null;
  try {
    const draftReq = await tracedChat(traceId, 'summary_draft', {
      model: COACH_MODEL,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: `Topic: ${sess.topic}\nDifficulty: ${sess.difficulty}\nFinal accuracy: ${(accuracy * 100).toFixed(0)}%\n\nTranscript:\n${transcript}\n\nOutput the JSON summary now.` },
      ],
      temperature: 0.3,
      max_tokens: 400,
      ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
    }, { gemini: geminiModelFor('coach') });
    raw = draftReq.choices?.[0]?.message?.content ?? '';

    if (useSelfCritique && raw.trim()) {
      try {
        const critReq = await tracedChat(traceId, 'summary_critique', {
          model: COACH_MODEL,
          messages: [
            { role: 'system', content: COACH_CRITIQUE_SYSTEM },
            { role: 'user', content: `Transcript:\n${transcript}\n\nDraft summary JSON:\n${raw}\n\nOutput the JSON critique now.` },
          ],
          temperature: 0.1,
          max_tokens: 400,
          ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
        }, { gemini: geminiModelFor('coach') });
        let critRaw = critReq.choices?.[0]?.message?.content?.trim() || '{}';
        if (critRaw.startsWith('```')) critRaw = critRaw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
        const a = critRaw.indexOf('{'); const b = critRaw.lastIndexOf('}');
        if (a >= 0 && b > a) critRaw = critRaw.slice(a, b + 1);
        critiqueJson = JSON.parse(critRaw);

        const issueCount0 = (critiqueJson?.ungrounded_concepts?.length || 0)
          + (critiqueJson?.missed_gaps?.length || 0)
          + (critiqueJson?.suggested_next_problems?.length || 0)
          + (critiqueJson?.summary_inaccurate?.length || 0);
        const severity0 = issueCount0 === 0 ? 'none' : issueCount0 <= 2 ? 'minor' : issueCount0 <= 4 ? 'moderate' : 'major';
        await Promise.all([
          logEvent(traceId, 'critique_parsed', 'reviewing', {
            issue_count: issueCount0,
            severity: severity0,
            needs_revision: critiqueJson?.needs_revision,
            critique: critiqueJson,
          }),
          setTraceSeverity(traceId, severity0),
        ]);

        const issueCount = (critiqueJson?.ungrounded_concepts?.length || 0)
          + (critiqueJson?.missed_gaps?.length || 0)
          + (critiqueJson?.suggested_next_problems?.length || 0)
          + (critiqueJson?.summary_inaccurate?.length || 0);
        if (critiqueJson?.needs_revision && issueCount > 0) {
          const revReq = await tracedChat(traceId, 'summary_revision', {
            model: COACH_MODEL,
            messages: [
              { role: 'system', content: COACH_REVISION_SYSTEM },
              { role: 'user', content: `Transcript:\n${transcript}\n\nDraft JSON:\n${raw}\n\nAuditor critique:\n${JSON.stringify(critiqueJson, null, 2)}\n\nOutput the revised JSON now.` },
            ],
            temperature: 0.2,
            max_tokens: 400,
            ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
          }, { gemini: geminiModelFor('coach') });
          raw = revReq.choices?.[0]?.message?.content ?? raw;
        }
      } catch (e) { console.warn('[coach end critique] failed', (e as Error).message); }
    }
    let t = raw.trim();
    if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const a = t.indexOf('{'); const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    const parsed = JSON.parse(t) as { summary?: string; concepts_mastered?: string[]; gaps?: string[]; suggested_next?: string };

    // v1.7b S3: emit final_answer + denormalize summary into traces.final_answer_text
    const finalAnswerText = [
      parsed.summary || '',
      ...(parsed.concepts_mastered || []).map((c) => 'Mastered: ' + c),
      ...(parsed.gaps || []).map((g) => 'Gap: ' + g),
      parsed.suggested_next ? 'Next: ' + parsed.suggested_next : '',
    ].filter(Boolean).join(' | ');
    await Promise.all([
      logEvent(traceId, 'final_answer', 'done', {
        answer_text: finalAnswerText,
        parsed_full: parsed,
        char_count: finalAnswerText.length,
      }),
      setTraceFinalAnswer(traceId, finalAnswerText),
    ]);

    if (!sess.ended_at) {
      await (sql as unknown as (q: string, p: unknown[]) => Promise<unknown>)(
        `UPDATE coaching_sessions SET ended_at = NOW(), outcome = COALESCE(outcome, 'completed'), accuracy = $1 WHERE id = $2`,
        [accuracy, id]
      );
    }

    await finishTrace(traceId, 'success');
    return NextResponse.json({
      session_id: id,
      accuracy: Number(accuracy.toFixed(2)),
      summary: parsed.summary || '',
      concepts_mastered: Array.isArray(parsed.concepts_mastered) ? parsed.concepts_mastered : [],
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
      critique: critiqueJson || undefined,
      sources_recap: {
        textbook: recapHits.map((h, i) => ({
          n: i + 1, id: h.id, book: h.book, chapter: h.chapter,
          page_start: h.page_start, page_end: h.page_end, item_number: h.item_number,
          similarity: Number(h.similarity.toFixed(3)),
          preview: h.text.slice(0, 400),
        })),
        plos: recapPlos.map((p, i) => ({
          n: i + 1, doi: p.doi, title: p.title, authors: p.authors,
          year: p.year, url: p.url, full_url: p.full_url,
          preview: p.abstract.slice(0, 400),
        })),
      },
      suggested_next: parsed.suggested_next || '',
    }, { headers: { 'X-Trace-Id': traceId } });
  } catch (e) {
    await finishTrace(traceId, 'error', String((e as Error).message));
    return NextResponse.json({ error: 'LLM failure', detail: String((e as Error).message), raw: raw.slice(0, 300) }, { status: 502, headers: { 'X-Trace-Id': traceId } });
  }
}
