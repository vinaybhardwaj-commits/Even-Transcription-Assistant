import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { retrieve } from '@/lib/retrieve';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const q = req.nextUrl.searchParams.get('q') || '';
  const topK = parseInt(req.nextUrl.searchParams.get('k') || '10', 10);
  const minSim = parseFloat(req.nextUrl.searchParams.get('min') || '0');
  const book = req.nextUrl.searchParams.get('book') || undefined;
  const skipExpand = req.nextUrl.searchParams.get('raw') === '1';
  if (!q) return NextResponse.json({ error: 'q is required' }, { status: 400 });
  try {
    const hybridFlag = req.nextUrl.searchParams.get('hybrid');
    const { hits, expandedQuery, meta } = await retrieve(q, { topK, minSimilarity: minSim, bookFilter: book, skipExpand, hybrid: hybridFlag !== '0' });
    return NextResponse.json({
      query: q,
      expanded: expandedQuery,
      meta,
      n: hits.length,
      hits: hits.map((h) => ({
        id: h.id,
        book: h.book,
        chapter: h.chapter,
        page_start: h.page_start,
        item_number: h.item_number,
        chunk_type: h.chunk_type,
        similarity: Number(h.similarity.toFixed(4)),
        preview: h.text.slice(0, 200),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 500 });
  }
}
