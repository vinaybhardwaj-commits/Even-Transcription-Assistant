export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { startTrace, logEvent, finishTrace, setTraceQuestionPreview } from '@/lib/trace';

// Semantic search over the shared corpus. Returns ranked passages with no LLM
// synthesis — the raw evidence behind Ask/DDx. Fully traced (feature='search').
export async function POST(req: Request) {
  let traceId: string | undefined;
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const query = String((body as { query?: unknown }).query ?? '').trim();
    if (!query) return NextResponse.json({ error: 'query required' }, { status: 400 });

    const b = body as { book?: string; chunkType?: string; source?: string; skipExpand?: boolean; topK?: number };
    traceId = await startTrace('search', { query, filters: { book: b.book ?? null, chunkType: b.chunkType ?? null, source: b.source ?? null, topK: b.topK ?? 20 } });
    await Promise.all([
      logEvent(traceId, 'request_received', null, { body, ua: req.headers.get('user-agent') || '', t: new Date().toISOString() }),
      setTraceQuestionPreview(traceId, query),
    ]);

    const t0 = Date.now();
    const { hits, expandedQuery } = await retrieve(query, {
      topK: typeof b.topK === 'number' ? b.topK : 20,
      bookFilter: b.book || undefined,
      chunkType: (b.chunkType || undefined) as 'narrative' | 'explanation' | undefined,
      source: b.source || undefined,
      skipExpand: b.skipExpand === true,
    });
    await logEvent(traceId, 'retrieval_hydrated', 'retrieving', {
      expanded: expandedQuery,
      hit_count: hits.length,
      hits: (hits as Array<Record<string, unknown>>).map((h) => ({
        id: h.id, book: h.book, chapter: h.chapter, section: h.section,
        page_start: h.page_start, page_end: h.page_end, chunk_type: h.chunk_type,
        similarity: h.similarity, rerank_score: h.rerank_score, source_quality_weight: h.source_quality_weight,
        text: String(h.text ?? '').slice(0, 600),
      })),
    }, Date.now() - t0);
    await finishTrace(traceId, 'success');
    return NextResponse.json({ hits, expanded: expandedQuery });
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message));
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
