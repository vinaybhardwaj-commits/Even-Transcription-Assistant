'use client';

import { useState, useRef } from 'react';

type Citation = {
  n: number; id: number; book: string; chapter: string | null;
  page_start: number | null; page_end: number | null;
  item_number: string | null; chunk_type: string;
  similarity: number; preview: string;
};

const TOPICS = [
  'Atrial fibrillation',
  'Acute kidney injury',
  'Diabetic ketoacidosis',
  'Pulmonary embolism',
  'Sepsis management',
];

// Tiny markdown-ish renderer: headings + bullets + citation pills
function renderMarkdown(md: string) {
  const blocks: React.ReactNode[] = [];
  let key = 0;
  let listBuf: string[] = [];
  function flushList() {
    if (listBuf.length === 0) return;
    blocks.push(
      <ul key={key++} className="my-2 list-disc space-y-1 pl-6 text-[15px] leading-relaxed text-slate-800">
        {listBuf.map((b, i) => <li key={i} dangerouslySetInnerHTML={{ __html: linkify(b) }} />)}
      </ul>
    );
    listBuf = [];
  }
  function linkify(line: string): string {
    return line.replace(/\[(\d+)\]/g, '<sup class="ml-0.5 inline-block rounded bg-brand-faint px-1 text-[10px] font-semibold text-brand">[$1]</sup>');
  }
  for (const rawLine of md.split('\n')) {
    const line = rawLine.trimEnd();
    if (/^##+\s+/.test(line)) {
      flushList();
      const text = line.replace(/^##+\s+/, '');
      blocks.push(<h3 key={key++} className="mt-5 border-b border-slate-200 pb-1 text-base font-semibold text-brand">{text}</h3>);
    } else if (/^\s*[-*]\s+/.test(line)) {
      listBuf.push(line.replace(/^\s*[-*]\s+/, ''));
    } else if (line.trim() === '') {
      flushList();
    } else {
      flushList();
      blocks.push(<p key={key++} className="my-2 text-[15px] leading-relaxed text-slate-800" dangerouslySetInnerHTML={{ __html: linkify(line) }} />);
    }
  }
  flushList();
  return blocks;
}

export default function TopicsClient() {
  const [topic, setTopic] = useState('');
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<Citation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const abortRef = useRef<AbortController | null>(null);

  async function submit(t: string) {
    setTopic(t); setAnswer(''); setCitations([]); setError(null); setExpanded({}); setLoading(true);
    abortRef.current?.abort();
    const ctrl = new AbortController(); abortRef.current = ctrl;
    try {
      const r = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: t }),
        signal: ctrl.signal,
      });
      if (!r.ok) { setError(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); setLoading(false); return; }
      if (!r.body) { setError('no body'); setLoading(false); return; }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = ''; let headerParsed = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (!headerParsed) {
          const idx = buf.indexOf('\n\n---STREAM---\n');
          if (idx !== -1) {
            try { const p = JSON.parse(buf.slice(0, idx)); if (p.type === 'citations') setCitations(p.items); } catch {}
            buf = buf.slice(idx + '\n\n---STREAM---\n'.length);
            headerParsed = true; setAnswer(buf);
          }
        } else { setAnswer(buf); }
      }
    } catch (e) { if ((e as Error).name !== 'AbortError') setError(String((e as Error).message)); }
    finally { setLoading(false); }
  }

  function onSubmit(e: React.FormEvent) { e.preventDefault(); const t = topic.trim(); if (t) submit(t); }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
      <div>
        <form onSubmit={onSubmit} className="space-y-3">
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Atrial fibrillation, Hyperkalemia, COPD exacerbation…"
            className="w-full rounded-lg border border-slate-300 bg-white p-3 text-base shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">Enter to submit</span>
            <button type="submit" disabled={loading || !topic.trim()} className="rounded bg-brand px-4 py-2 text-sm font-medium text-white shadow disabled:bg-slate-300">
              {loading ? 'Synthesizing…' : 'Generate study guide'}
            </button>
          </div>
        </form>

        <div className="mt-3 flex flex-wrap gap-2">
          {TOPICS.map((t) => (
            <button key={t} onClick={() => submit(t)} disabled={loading}
              className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 hover:border-brand hover:text-brand disabled:opacity-40">
              {t}
            </button>
          ))}
        </div>

        {error && <div className="mt-6 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div>}

        {(answer || loading) && (
          <article className="mt-6 rounded-lg border bg-white p-5 shadow-sm">
            <div>{renderMarkdown(answer)}</div>
            {loading && !answer && <p className="text-slate-400">Retrieving 15 excerpts and synthesizing across books…</p>}
            {loading && answer && <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-slate-400" />}
          </article>
        )}
      </div>

      <aside className="lg:sticky lg:top-4 lg:self-start">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Sources ({citations.length})</h2>
        {citations.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">Citations appear here when you generate a guide.</p>
        ) : (
          <ol className="mt-3 space-y-2">
            {citations.map((c) => {
              const isOpen = !!expanded[c.n];
              return (
                <li key={c.n} className="rounded-lg border border-slate-200 bg-white text-sm shadow-sm">
                  <button onClick={() => setExpanded((p) => ({ ...p, [c.n]: !isOpen }))}
                    className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left hover:bg-slate-50">
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-1.5">
                        <span className="rounded bg-brand-faint px-1.5 py-0.5 text-[11px] font-semibold text-brand">[{c.n}]</span>
                        <span className="truncate font-medium text-slate-800">{c.book}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        {c.chapter && <span>{c.chapter} · </span>}
                        {c.page_start && <span>p.{c.page_start} · </span>}
                        <span>sim {c.similarity.toFixed(2)}</span>
                      </div>
                    </div>
                    <span className="text-slate-400">{isOpen ? '–' : '+'}</span>
                  </button>
                  {isOpen && <div className="border-t border-slate-100 px-3 py-2 text-[13px] leading-relaxed text-slate-700">{c.preview}…</div>}
                </li>
              );
            })}
          </ol>
        )}
      </aside>
    </div>
  );
}
