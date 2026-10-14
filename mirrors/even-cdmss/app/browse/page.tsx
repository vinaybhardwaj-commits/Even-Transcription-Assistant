import Link from 'next/link';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Browse' };

const NONE = '__none__';

type BookRow = { book: string; source: string | null; n: number };
type ChapterRow = { chapter: string | null; n: number };
type PassageRow = {
  id: number;
  source: string | null;
  section: string | null;
  page_start: number | null;
  page_end: number | null;
  item_number: string | null;
  chunk_type: string;
  text: string;
};

function Header() {
  return (
    <>
      <Link href="/knowledge" className="mb-2 inline-flex items-center gap-1 text-[12.5px] text-slate-500 hover:text-brand">
        ‹ Knowledge base
      </Link>
      <h1 className="font-serif text-[26px] font-semibold leading-tight text-slate-900 sm:text-[30px]">Browse the corpus</h1>
      <p className="mt-1.5 text-sm text-slate-500">
        Walk the evidence base by book and chapter — the raw source passages that ground Ask, Differential, and the rest.
      </p>
    </>
  );
}

export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<{ book?: string; chapter?: string }>;
}) {
  const { book, chapter } = await searchParams;

  // ---- Passage level: a specific book + chapter ----
  if (book && typeof chapter === 'string') {
    const isNone = chapter === NONE;
    const rows = (isNone
      ? await sql`SELECT id, source, section, page_start, page_end, item_number, chunk_type, text
                  FROM mksap_chunks WHERE book = ${book} AND chapter IS NULL
                  ORDER BY page_start NULLS FIRST, id LIMIT 500`
      : await sql`SELECT id, source, section, page_start, page_end, item_number, chunk_type, text
                  FROM mksap_chunks WHERE book = ${book} AND chapter = ${chapter}
                  ORDER BY page_start NULLS FIRST, id LIMIT 500`) as PassageRow[];

    return (
      <div>
        <Header />
        <nav className="mt-4 text-sm text-slate-500">
          <Link href="/browse" className="text-brand hover:underline">Books</Link>
          <span className="mx-1">›</span>
          <Link href={`/browse?book=${encodeURIComponent(book)}`} className="text-brand hover:underline">{book}</Link>
          <span className="mx-1">›</span>
          <span className="text-slate-700">{isNone ? '(no chapter)' : chapter}</span>
        </nav>
        <p className="mt-2 text-xs text-slate-400">
          {rows.length} passage{rows.length === 1 ? '' : 's'}{rows.length === 500 ? ' (showing first 500)' : ''}
        </p>
        <div className="mt-4 space-y-4">
          {rows.length === 0 && <p className="text-sm text-slate-500">No passages found.</p>}
          {rows.map((r) => (
            <div key={r.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">{r.chunk_type}</span>
                {r.source && <span>{r.source}</span>}
                {r.section && <span>· {r.section}</span>}
                {r.item_number && <span>· item {r.item_number}</span>}
                {r.page_start != null && (
                  <span>· p.{r.page_start}{r.page_end != null && r.page_end !== r.page_start ? `–${r.page_end}` : ''}</span>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{r.text}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ---- Chapter level: chapters within a book ----
  if (book) {
    const rows = (await sql`SELECT chapter, COUNT(*)::int AS n FROM mksap_chunks
                            WHERE book = ${book} GROUP BY chapter ORDER BY chapter NULLS FIRST`) as ChapterRow[];
    return (
      <div>
        <Header />
        <nav className="mt-4 text-sm text-slate-500">
          <Link href="/browse" className="text-brand hover:underline">Books</Link>
          <span className="mx-1">›</span>
          <span className="text-slate-700">{book}</span>
        </nav>
        <ul className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white shadow-sm">
          {rows.length === 0 && <li className="p-4 text-sm text-slate-500">No chapters found for this book.</li>}
          {rows.map((r, i) => (
            <li key={i}>
              <Link
                href={`/browse?book=${encodeURIComponent(book)}&chapter=${encodeURIComponent(r.chapter ?? NONE)}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-slate-50"
              >
                <span className="text-sm text-slate-800">{r.chapter ?? '(no chapter)'}</span>
                <span className="text-xs text-slate-400">{r.n} passage{r.n === 1 ? '' : 's'}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // ---- Book level: all books ----
  const rows = (await sql`SELECT book, MIN(source) AS source, COUNT(*)::int AS n FROM mksap_chunks
                          GROUP BY book ORDER BY book`) as BookRow[];
  return (
    <div>
      <Header />
      <ul className="mt-6 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white shadow-sm">
        {rows.length === 0 && <li className="p-4 text-sm text-slate-500">No books found in the corpus.</li>}
        {rows.map((r, i) => (
          <li key={i}>
            <Link href={`/browse?book=${encodeURIComponent(r.book)}`} className="flex items-center justify-between px-4 py-3 hover:bg-slate-50">
              <span className="text-sm font-medium text-slate-800">{r.book}</span>
              <span className="text-xs text-slate-400">{r.source ? `${r.source} · ` : ''}{r.n} passage{r.n === 1 ? '' : 's'}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
