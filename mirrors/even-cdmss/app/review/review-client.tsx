'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, BookOpen, Sparkles, Lightbulb, Brain, RotateCcw, Check, X, ChevronDown, ChevronUp, FilePlus2 } from 'lucide-react';

type DigestResp = {
  not_enough_activity?: boolean;
  message?: string;
  digest_id?: number;
  window_start?: string;
  window_end?: string;
  query_count?: number;
  summary?: string;
  themes?: string[];
  gaps?: string[];
  flashcards?: Array<{ id: number; front: string; back: string; source_query_id: number | null }>;
};

type Card = {
  id: number;
  front_text: string;
  back_text: string;
  source_query_id: number | null;
  sm2_easiness: number;
  sm2_interval_days: number;
  sm2_repetitions: number;
  next_review_at: string;
};

const RATINGS: Array<{ rating: 'again' | 'hard' | 'good' | 'easy'; label: string; cls: string }> = [
  { rating: 'again', label: 'Again',  cls: 'bg-rose-100 text-rose-900 hover:bg-rose-200' },
  { rating: 'hard',  label: 'Hard',   cls: 'bg-amber-100 text-amber-900 hover:bg-amber-200' },
  { rating: 'good',  label: 'Good',   cls: 'bg-emerald-100 text-emerald-900 hover:bg-emerald-200' },
  { rating: 'easy',  label: 'Easy',   cls: 'bg-sky-100 text-sky-900 hover:bg-sky-200' },
];

function renderCloze(s: string) {
  return s.split(/(_{3,})/).map((part, i) =>
    /^_+$/.test(part)
      ? <span key={i} className="mx-0.5 inline-block min-w-[3rem] rounded border-b-2 border-slate-400 bg-slate-100">&nbsp;</span>
      : <span key={i}>{part}</span>
  );
}

function DigestPanel() {
  const [data, setData] = useState<DigestResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true); setError(null); setData(null);
    try {
      const r = await fetch('/api/digest/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!r.ok) { setError(`${r.status}: ${(await r.text()).slice(0, 200)}`); return; }
      setData(await r.json());
    } catch (e) { setError(String((e as Error).message)); }
    finally { setLoading(false); }
  }

  return (
    <div>
      <button
        onClick={generate}
        disabled={loading}
        className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white shadow disabled:bg-slate-300"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FilePlus2 className="h-4 w-4" />}
        {loading ? 'Reading your shift…' : "Generate today's digest"}
      </button>

      {error && <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}

      {data?.not_enough_activity && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{data.message}</div>
      )}

      {data && !data.not_enough_activity && (
        <div className="mt-6 space-y-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-2 text-[11px] text-slate-500">
              <span>Window: {data.window_start ? new Date(data.window_start).toLocaleString() : '?'} → now</span>
              <span>·</span>
              <span>{data.query_count} queries</span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-slate-800">{data.summary}</p>
          </div>

          {data.themes && data.themes.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <h3 className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500"><Sparkles className="h-3 w-3" /> Themes</h3>
              <ul className="mt-2 ml-4 list-disc space-y-1 text-sm text-slate-800">
                {data.themes.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </div>
          )}

          {data.gaps && data.gaps.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <h3 className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-amber-900"><Lightbulb className="h-3 w-3" /> Knowledge gaps</h3>
              <ul className="mt-2 ml-4 list-disc space-y-1 text-sm text-amber-900">
                {data.gaps.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </div>
          )}

          {data.flashcards && data.flashcards.length > 0 && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <h3 className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-900">
                <BookOpen className="h-3 w-3" /> {data.flashcards.length} new flashcard{data.flashcards.length !== 1 ? 's' : ''} added to your queue
              </h3>
              <ol className="mt-2 space-y-2">
                {data.flashcards.map((c) => (
                  <li key={c.id} className="rounded-lg border border-emerald-200 bg-white p-3 text-sm">
                    <p className="text-slate-800">{renderCloze(c.front)}</p>
                    <p className="mt-1 text-xs text-emerald-700">Answer: <span className="font-semibold">{c.back}</span></p>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-xs text-emerald-700">Switch to the Review tab to start working through them.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReviewPanel() {
  const [queue, setQueue] = useState<Card[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completedToday, setCompletedToday] = useState(0);
  const [showSourceFor, setShowSourceFor] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<{ rating: string; next_review_at: string; new_interval_days: number } | null>(null);

  const loadQueue = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/flashcards/due?limit=20');
      if (!r.ok) { setError(`${r.status}: ${(await r.text()).slice(0, 200)}`); return; }
      const d = await r.json();
      setQueue(d.cards); setTotal(d.total_count);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  const card = queue[0];

  async function rate(rating: 'again' | 'hard' | 'good' | 'easy') {
    if (!card) return;
    setSubmitting(true); setError(null);
    try {
      const r = await fetch('/api/flashcards/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_id: card.id, rating }),
      });
      if (!r.ok) { setError(`${r.status}: ${(await r.text()).slice(0, 200)}`); return; }
      const d = await r.json();
      setLastResult({ rating: d.rating, next_review_at: d.next_review_at, new_interval_days: d.new_interval_days });
      setCompletedToday((c) => c + 1);
      setQueue((q) => q.slice(1));
      setRevealed(false);
      setShowSourceFor(null);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setSubmitting(false); }
  }

  if (loading) {
    return <div className="rounded-xl border bg-white p-8 text-center text-slate-400 shadow-sm"><Loader2 className="mx-auto h-6 w-6 animate-spin" /></div>;
  }

  if (queue.length === 0) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center">
          <Check className="mx-auto h-8 w-8 text-emerald-600" />
          <h3 className="mt-2 font-semibold text-emerald-900">All caught up</h3>
          <p className="mt-1 text-sm text-emerald-800">
            {total === 0 ? "You don't have any flashcards yet. Generate a digest on the other tab to create some." : `${total} card${total !== 1 ? 's' : ''} in your deck. None are due right now.`}
          </p>
          {completedToday > 0 && <p className="mt-2 text-xs text-emerald-700">Reviewed {completedToday} this session.</p>}
        </div>
        {lastResult && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            Last: <span className="font-semibold capitalize">{lastResult.rating}</span> · next review in {lastResult.new_interval_days}d ({new Date(lastResult.next_review_at).toLocaleString()})
          </div>
        )}
        <button onClick={loadQueue} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:border-brand hover:text-brand">
          <RotateCcw className="h-3 w-3" /> Refresh
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between text-xs text-slate-500">
        <span>{queue.length} due · {total} total</span>
        <span>Reviewed: {completedToday}</span>
      </div>

      {error && <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}

      <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="min-h-[6rem]">
          <p className="text-[16px] leading-relaxed text-slate-800">{renderCloze(card.front_text)}</p>
          {revealed && (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Answer</span>
              <p className="mt-0.5 text-base font-semibold text-emerald-900">{card.back_text}</p>
            </div>
          )}
        </div>

        <div className="mt-5 border-t pt-4">
          {!revealed ? (
            <button
              onClick={() => setRevealed(true)}
              className="w-full rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white shadow"
            >
              Show answer
            </button>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {RATINGS.map((r) => (
                <button
                  key={r.rating}
                  onClick={() => rate(r.rating)}
                  disabled={submitting}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold transition disabled:opacity-50 ${r.cls}`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-3 flex items-center justify-between text-[11px] text-slate-400">
          <span>Easiness {Number(card.sm2_easiness).toFixed(2)} · interval {card.sm2_interval_days}d · reps {card.sm2_repetitions}</span>
          {card.source_query_id && (
            <button onClick={() => setShowSourceFor((p) => p === card.id ? null : card.id)} className="text-brand hover:underline">
              {showSourceFor === card.id ? 'Hide source' : 'Source query'}
            </button>
          )}
        </div>
      </article>
    </div>
  );
}

export default function ReviewClient() {
  const [tab, setTab] = useState<'digest' | 'review'>('digest');
  return (
    <div>
      <div className="mb-5 flex gap-1 rounded-lg bg-slate-100 p-1">
        <button
          onClick={() => setTab('digest')}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition ${
            tab === 'digest' ? 'bg-white text-brand shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <FilePlus2 className="h-4 w-4" /> Today&apos;s Digest
        </button>
        <button
          onClick={() => setTab('review')}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition ${
            tab === 'review' ? 'bg-white text-brand shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Brain className="h-4 w-4" /> Flashcard Review
        </button>
      </div>
      {tab === 'digest' ? <DigestPanel /> : <ReviewPanel />}
    </div>
  );
}
