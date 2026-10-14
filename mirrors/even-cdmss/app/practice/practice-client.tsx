'use client';

import { useState, useEffect, useCallback } from 'react';

type MCQ = {
  question: string;
  options: { A: string; B: string; C: string; D: string };
  correct: 'A' | 'B' | 'C' | 'D' | string;
  rationale: string;
};
type Source = {
  id: number;
  book: string;
  chapter: string;
  page_start: number;
  item_number: string;
  text: string;
};

const BOOKS = [
  '', 'Cardiovascular Medicine', 'Gastroenterology and Hepatology',
  'General Internal Medicine 1', 'General Internal Medicine 2',
  'Hematology', 'Infectious Disease', 'Nephrology', 'Neurology',
  'Oncology', 'Pulmonary and Critical Care Medicine', 'Rheumatology',
];
const SHORT: Record<string, string> = {
  '': 'All books',
  'Cardiovascular Medicine': 'Cardio',
  'Gastroenterology and Hepatology': 'GI/Hep',
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

export default function PracticeClient() {
  const [book, setBook] = useState<string>('');
  const [mcq, setMcq] = useState<MCQ | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0 });
  const [showSource, setShowSource] = useState(false);

  const next = useCallback(async () => {
    setMcq(null); setSource(null); setPicked(null); setRevealed(false); setError(null); setShowSource(false);
    setLoading(true);
    try {
      const r = await fetch('/api/practice/next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book: book || undefined }),
      });
      if (!r.ok) {
        const t = await r.text(); setError(`HTTP ${r.status}: ${t.slice(0, 200)}`); return;
      }
      const d = await r.json();
      setMcq(d.mcq); setSource(d.source);
    } catch (e) {
      setError(String((e as Error).message));
    } finally { setLoading(false); }
  }, [book]);

  useEffect(() => { next(); }, [next]);

  function pick(opt: string) {
    if (revealed) return;
    setPicked(opt);
    setRevealed(true);
    setScore((s) => ({ correct: s.correct + (opt === mcq?.correct ? 1 : 0), total: s.total + 1 }));
  }

  const correctLetter = mcq?.correct;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <select
          value={book}
          onChange={(e) => setBook(e.target.value)}
          disabled={loading}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
        >
          {BOOKS.map((b) => <option key={b} value={b}>{SHORT[b] ?? b}</option>)}
        </select>
        <div className="text-sm text-slate-500">
          Score: <span className="font-semibold text-slate-800">{score.correct}/{score.total}</span>
        </div>
      </div>

      {error && <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}

      {loading && <div className="rounded-lg border bg-white p-8 text-center text-slate-400 shadow-sm">Generating MCQ from a random MKSAP item…</div>}

      {mcq && !loading && (
        <article className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-800">{mcq.question}</p>
          <div className="mt-5 space-y-2">
            {(['A','B','C','D'] as const).map((k) => {
              const isPicked = picked === k;
              const isCorrect = revealed && k === correctLetter;
              const isWrong = revealed && isPicked && k !== correctLetter;
              const cls = isCorrect
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                : isWrong
                  ? 'border-rose-300 bg-rose-50 text-rose-900'
                  : revealed
                    ? 'border-slate-200 bg-white text-slate-700'
                    : 'border-slate-300 bg-white text-slate-800 hover:border-brand hover:bg-brand-faint/50';
              return (
                <button
                  key={k}
                  onClick={() => pick(k)}
                  disabled={revealed}
                  className={`flex w-full items-start gap-3 rounded-lg border px-4 py-2.5 text-left text-[14px] leading-relaxed transition disabled:cursor-default ${cls}`}
                >
                  <span className="mt-0.5 inline-block w-5 shrink-0 font-semibold">{k}.</span>
                  <span>{mcq.options[k]}</span>
                  {isCorrect && <span className="ml-auto text-xs font-semibold">✓ correct</span>}
                  {isWrong && <span className="ml-auto text-xs font-semibold">✗</span>}
                </button>
              );
            })}
          </div>

          {revealed && (
            <div className="mt-5 rounded-lg border border-brand-faint bg-brand-faint/30 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-brand">Rationale</h3>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{mcq.rationale}</p>
            </div>
          )}

          {source && (
            <div className="mt-5 text-xs text-slate-500">
              Source: <span className="font-medium text-slate-700">{source.book}</span>
              {source.chapter && <> · {source.chapter}</>}
              {source.page_start && <> · p.{source.page_start}</>}
              {source.item_number && <> · Item {source.item_number}</>}
              <button onClick={() => setShowSource((s) => !s)} className="ml-2 text-brand hover:underline">
                {showSource ? 'Hide excerpt' : 'Show excerpt'}
              </button>
              {showSource && (
                <p className="mt-2 whitespace-pre-wrap rounded border bg-slate-50 p-3 text-[13px] leading-relaxed text-slate-700">{source.text}</p>
              )}
            </div>
          )}

          <div className="mt-6 flex items-center justify-between border-t pt-4">
            <button
              onClick={next}
              disabled={loading}
              className="rounded bg-brand px-4 py-2 text-sm font-medium text-white shadow disabled:bg-slate-300"
            >
              Next question →
            </button>
            {!revealed && <span className="text-xs text-slate-400">Pick an answer to reveal</span>}
          </div>
        </article>
      )}
    </div>
  );
}
