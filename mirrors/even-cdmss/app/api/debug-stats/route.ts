import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// Quick corpus stats — book-level chunk counts, sample text matches.
export async function GET(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const url = new URL(req.url);
  const grep = url.searchParams.get('grep');
  const out: Record<string, unknown> = {};

  const byBook = (await sql`
    SELECT book, COUNT(*)::int AS chunks
    FROM mksap_chunks GROUP BY book ORDER BY book
  `) as Array<{ book: string; chunks: number }>;
  out.by_book = byBook;

  if (grep) {
    const matches = (await (sql as unknown as (q: string, p: unknown[]) => Promise<unknown[]>)(
      `SELECT book, chapter, page_start, LEFT(text, 200) AS preview
       FROM mksap_chunks WHERE text ILIKE $1 LIMIT 20`,
      [`%${grep}%`]
    )) as Array<{ book: string; chapter: string | null; page_start: number | null; preview: string }>;
    out.grep_query = grep;
    out.grep_matches = matches.length;
    out.grep_sample = matches;
  }

  return NextResponse.json(out);
}
