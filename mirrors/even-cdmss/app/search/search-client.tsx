'use client';

import { useState } from 'react';

type Hit = {
  id: number;
  book: string;
  chapter: string | null;
  page_start: number | null;
  page_end: number | null;
  item_number: string | null;
  chunk_type: string;
  token_count: number | null;
  similarity: number;
  text: string;
};

const BOOKS = [
  'Board basics _ an enhancement to MKSAP 19',
  'Cardiovascular Medicine',
  'Gastroenterology and Hepatology',
  'General Internal Medicine 1',
  'General Internal Medicine 2',
  'Hematology',
  'Infectious Disease',
  'Nephrology',
  'Neurology',
  'Oncology',
  'Pulmonary and Critical Care Medicine',
  'Rheumatology',
];

const BOOK_SHORT: Record<string, string> = {
  'Board basics _ an enhancement to MKSAP 19': 'Board Basics',
  'Cardiovascular Medicine': 'Cardio',
  'Gastroenterology and Hepatology': 'GI',
  'General Internal Medicine 1': 'GIM 1',
  'General Internal Medicine 2': 'GIM 2',
  'Hematology': 'Heme',
  'Infectious Disease': 'ID',
  'Nephrology': 'Nephro',
  'Neurology': 'Neuro',
  'Oncology': 'Onc',
  'Pulmonary and Critical Care Medicine': 'Pulm/CC',
  'Rheumatology': 'Rheum',
};

export default function SearchClient() {
  const [query, setQuery] = useState('');
  const [book, setBook] = useState<string>('');
  const [source, setSource] = useState<string>('');
  const [chunkType, setChunkType] = useState<'' | 'narrative' | 'explanation'>('');
  const [skipExpand, setSkipExpand] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [expanded, setExpanded] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<Record<number, boolean>>({});

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    setHits(null);
    setExpanded('');
    try {
      const r = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: q,
          book: book || undefined,
          chunkType: chunkType || undefined,
          source: source || undefined,
          skipExpand,
          topK: 20,
        }),
      });
      if (!r.ok) {
        setError(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      } else {
        const data = await r.json();
        setHits(data.hits);
        setExpanded(data.expanded || '');
      }
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <form onSubmit={submit} className="space-y-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search for a clinical concept, drug, or finding…"
          className="w-full rounded-lg border border-slate-300 bg-white p-3 text-base shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
          >
            <option value="">All sources</option>
            <option value="mksap-19">MKSAP 19</option>
            <option value="statpearls">StatPearls</option>
          </select>
          <select
            value={book}
            onChange={(e) => setBook(e.target.value)}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
          >
            <option value="">All books</option>
            {BOOKS.map((b) => <option key={b} value={b}>{BOOK_SHORT[b] || b}</option>)}
          </select>
          <select
            value={chunkType}
            onChange={(e) => setChunkType(e.target.value as 'narrative' | 'explanation' | '')}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
          >
            <option value="">All chunk types</option>
            <option value="narrative">Narrative (textbook)</option>
            <option value="explanation">Explanation (Q&amp;A items)</option>
          </select>
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <input type="checkbox" checked={skipExpand} onChange={(e) => setSkipExpand(e.target.checked)} />
            Skip query expansion
          </label>
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="ml-auto rounded bg-brand px-4 py-1.5 text-sm font-medium text-white shadow disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>

      {expanded && expanded.trim() !== query.trim() && !skipExpand && (
        <details className="mt-4 rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          <summary className="cursor-pointer font-medium text-slate-700">Expanded query (used for embedding)</summary>
          <p className="mt-2 whitespace-pre-wrap leading-relaxed">{expanded}</p>
        </details>
      )}

      {error && <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}

      {hits && (
        <div className="mt-6">
          <p className="text-sm text-slate-500">
            {hits.length} {hits.length === 1 ? 'result' : 'results'} above similarity 0.40
          </p>
          <ol className="mt-3 space-y-3">
            {hits.map((h, i) => {
              const isOpen = !!openIds[h.id];
              return (
                <li key={h.id} className="rounded-lg border border-slate-200 bg-white shadow-sm">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-3">
                    <span className="rounded bg-brand-faint px-1.5 py-0.5 text-[11px] font-semibold text-brand">#{i + 1}</span>
                    {(h as unknown as { source?: string }).source === 'statpearls' && (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">StatPearls</span>
                    )}
                    <span className="font-medium text-slate-800">{BOOK_SHORT[h.book] || h.book}</span>
                    {h.chapter && <span className="text-sm text-slate-500">· {h.chapter}</span>}
                    {h.page_start && <span className="text-xs text-slate-400">· p.{h.page_start}{h.page_end && h.page_end !== h.page_start ? `–${h.page_end}` : ''}</span>}
                    {h.item_number && <span className="text-xs text-slate-400">· Item {h.item_number}</span>}
                    <span className="ml-auto rounded bg-slate-100 px-2 py-0.5 text-xs font-mono text-slate-600">sim {h.similarity.toFixed(2)}</span>
                  </div>
                  <div className={`px-4 pb-3 text-[14px] leading-relaxed text-slate-700 ${isOpen ? '' : 'line-clamp-4'}`}>
                    {h.text}
                  </div>
                  <button
                    onClick={() => setOpenIds((p) => ({ ...p, [h.id]: !isOpen }))}
                    className="block w-full border-t border-slate-100 px-4 py-1.5 text-left text-xs text-slate-500 hover:bg-slate-50"
                  >
                    {isOpen ? 'Collapse' : `Expand (${h.token_count ?? '?'} tokens)`}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
