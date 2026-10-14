export const dynamic = 'force-dynamic';
export const maxDuration = 180;

import { retrieve } from '@/lib/retrieve';
import { TEXT_MODEL, geminiModelFor } from '@/lib/llm';
import { startTrace, logEvent, finishTrace, tracedChat, logStreamComplete, setTraceQuestionPreview, setTraceFinalAnswer } from '@/lib/trace';

// Topic synthesis: retrieve ~15 excerpts, then stream a cited study guide.
// Wire format: a JSON citations header, the delimiter "\n\n---STREAM---\n",
// then the markdown answer streamed as text. Fully traced (feature='topics').
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const topic = String((body as { topic?: unknown }).topic ?? '').trim();
  if (!topic) return new Response('topic required', { status: 400 });

  const traceId = await startTrace('topics', { topic });
  await Promise.all([
    logEvent(traceId, 'request_received', null, { body, ua: req.headers.get('user-agent') || '', t: new Date().toISOString() }),
    setTraceQuestionPreview(traceId, topic),
  ]);

  const t0 = Date.now();
  const { hits } = await retrieve(topic, { topK: 15 });
  const citations = hits.map((h, i) => ({
    n: i + 1, id: h.id, book: h.book, chapter: h.chapter,
    page_start: h.page_start, page_end: h.page_end, item_number: h.item_number,
    chunk_type: h.chunk_type, similarity: h.similarity,
    preview: (h.text || '').slice(0, 240),
  }));
  await logEvent(traceId, 'retrieval_hydrated', 'retrieving', {
    hit_count: hits.length,
    hits: (hits as Array<Record<string, unknown>>).map((h, i) => ({
      n: i + 1, id: h.id, book: h.book, chapter: h.chapter, section: h.section,
      page_start: h.page_start, page_end: h.page_end, chunk_type: h.chunk_type,
      similarity: h.similarity, rerank_score: h.rerank_score,
      text: String(h.text ?? '').slice(0, 600),
    })),
  }, Date.now() - t0);

  const context = hits
    .map((h, i) => `[${i + 1}] (${h.book}${h.chapter ? ', ' + h.chapter : ''})\n${h.text}`)
    .join('\n\n');
  const system =
    'You are a clinical educator. Write a concise, well-structured study guide on the given topic, grounded ONLY in the provided excerpts. ' +
    'Use "## " section headings (e.g. Definition, Diagnosis, Management, Pearls) and "- " bullet points. ' +
    'Cite every factual claim with [n] referring to the excerpt numbers. Do not invent facts beyond the excerpts.';
  const user = `Topic: ${topic}\n\nExcerpts:\n${context}`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(JSON.stringify({ type: 'citations', items: citations }) + '\n\n---STREAM---\n'));
        if (hits.length === 0) {
          controller.enqueue(encoder.encode('No matching material was found in the corpus for this topic.'));
          await logEvent(traceId, 'final_answer', 'done', { answer_text: '(no matching material)', char_count: 0 });
          await finishTrace(traceId, 'success');
          controller.close();
          return;
        }
        const llmStart = Date.now();
        // Governed envelope (Stage 4): tracedChat logs its own llm_request (+ stream-started
        // and the usage chunk on Gemini), replacing the manual llm_request that assumed
        // TEXT_MODEL even when Gemini served the stream.
        const completion = await tracedChat(traceId, 'drafting', {
          model: TEXT_MODEL,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature: 0.2,
          stream: true,
        }, { gemini: geminiModelFor('topics') });
        let full = '';
        for await (const part of completion as AsyncIterable<{ choices?: { delta?: { content?: string } }[] }>) {
          const delta = part.choices?.[0]?.delta?.content ?? '';
          if (delta) { full += delta; controller.enqueue(encoder.encode(delta)); }
        }
        await logStreamComplete(traceId, 'guide', full, llmStart, { char_count: full.length });
        await logEvent(traceId, 'final_answer', 'done', { answer_text: full, char_count: full.length });
        await setTraceFinalAnswer(traceId, full);
        await finishTrace(traceId, 'success');
        controller.close();
      } catch (e) {
        controller.enqueue(encoder.encode(`\n\n[error: ${(e as Error).message}]`));
        await finishTrace(traceId, 'error', String((e as Error).message));
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
