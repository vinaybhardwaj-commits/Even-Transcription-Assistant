'use client';

import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { Mic, MicOff, Send, ChevronDown, ChevronUp, BookOpen, Loader2, Microscope, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { consumeNdjson } from '@/lib/ndjson-client';
import TracePanel, { TraceEvent } from '@/components/TracePanel';
import { MarkdownAnswer } from '@/components/MarkdownAnswer';

type Citation = { n: number; id: number; book: string; chapter: string | null; page_start: number | null; page_end: number | null; item_number: string | null; chunk_type: string; similarity: number; preview: string; };
type PlosCitation = { n: number; kind: 'plos'; doi: string; title: string; authors: string[]; year: number; url: string; full_url: string; preview: string; };

// v1.7 Sprint G: chips come from /api/ask/example-questions (rotated per-load + Shuffle)
const DEFAULT_EXAMPLES = [
  'First-line management of HFrEF NYHA III?',
  'Distinguishing IBS from IBD in a 28y with chronic diarrhea',
  'Workup for hyponatremia, serum osmolality 268',
  'Empiric antibiotics for CAP in a 70y with COPD',
];

type SR = { continuous: boolean; interimResults: boolean; lang: string; onresult: ((e: { results: { transcript: string; isFinal?: boolean }[][] & { length: number } }) => void) | null; onerror: ((e: { error?: string }) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void; };
function getRecognition(): SR | null {
  if (typeof window === 'undefined') return null;
  const W = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  const C = W.SpeechRecognition || W.webkitSpeechRecognition;
  if (!C) return null;
  const r = new C(); r.continuous = false; r.interimResults = true; r.lang = 'en-IN';
  return r;
}

function renderWithCitations(text: string, citations: Citation[], onCite: (n: number) => void): React.ReactNode[] {
  if (!text) return [];
  const parts: React.ReactNode[] = [];
  const regex = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  let last = 0; let m: RegExpExecArray | null; let key = 0;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    const nums = m[1].split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    parts.push(<span key={key++} className="inline-flex items-baseline gap-0.5">
      {nums.map((n, i) => {
        const valid = citations.some((c) => c.n === n);
        return <button key={i} onClick={() => valid && onCite(n)}
          className={valid ? 'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-md bg-brand-faint px-1 text-[10px] font-semibold text-brand hover:bg-brand hover:text-white' : 'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-md bg-slate-100 px-1 text-[10px] font-medium text-slate-400'}
          type="button">{n}</button>;
      })}
    </span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<span key={key++}>{text.slice(last)}</span>);
  return parts;
}

// Unified Clarity toggle-pill style (replaces the old rainbow per-toggle colors).
function togCls(active: boolean): string {
  return 'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ' +
    (active ? 'border-brand bg-brand-faint text-brand' : 'border-slate-200 bg-white text-slate-500 hover:border-brand/60 hover:text-slate-700');
}

export default function AskClient() {
  const [question, setQuestion] = useState('');
  const [investigations, setInvestigations] = useState('');
  const [showContext, setShowContext] = useState(false);
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<Citation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [totalMs, setTotalMs] = useState<number | undefined>(undefined);
  const [traceId, setTraceId] = useState<string | null>(null);
  // v1.7 Sprint G: rotating example chips + Shuffle ↻ (locks #21-23)
  const [chips, setChips] = useState<string[]>(DEFAULT_EXAMPLES);
  const loadChips = useCallback(async () => {
    try {
      const r = await fetch('/api/ask/example-questions?n=4');
      if (!r.ok) return;
      const j = await r.json();
      const qs = (j.questions || []).map((x: { question: string }) => x.question).filter(Boolean);
      if (qs.length) setChips(qs);
    } catch {}
  }, []);
  useEffect(() => { loadChips(); }, [loadChips]);
  // v1.8: read ?q= query param on mount (used by /calculators 'Ask deeper' chips)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search).get('q');
    if (q && q.trim()) setQuestion(q.trim());
  }, []);
  const abortRef = useRef<AbortController | null>(null);
  const recRef = useRef<SR | null>(null);
  const sessionId = useMemo(() => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())), []);
  const sourcesRef = useRef<HTMLDivElement | null>(null);
  const [plosCitations, setPlosCitations] = useState<PlosCitation[]>([]);
  const [includePlos, setIncludePlos] = useState(true);
  const [multiQuery, setMultiQuery] = useState(true);
  const [selfCritique, setSelfCritique] = useState(true);
  const [useReranker, setUseReranker] = useState(true);
  const [useSourceWeights, setUseSourceWeights] = useState(true);
  const [critique, setCritique] = useState<{ severity: string; issue_count: number; details: Record<string, unknown> } | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  function toggleVoice() {
    if (voiceActive) { recRef.current?.stop(); return; }
    const r = getRecognition();
    if (!r) { setVoiceSupported(false); return; }
    recRef.current = r;
    let baseline = question;
    r.onresult = (e) => {
      let interim = '', finalText = '';
      for (let i = 0; i < (e.results as unknown as { length: number }).length; i++) {
        const res = (e.results as unknown as { [k: number]: { transcript: string; isFinal?: boolean } })[i];
        if (res.isFinal) finalText += res.transcript; else interim += res.transcript;
      }
      const sep = baseline && !/[\s,.]$/.test(baseline) ? ' ' : '';
      setQuestion(baseline + sep + finalText + interim);
      if (finalText) baseline = baseline + sep + finalText;
    };
    r.onerror = () => setVoiceActive(false);
    r.onend = () => setVoiceActive(false);
    setVoiceActive(true);
    r.start();
  }

  function pushTrace(stage: string, msg: string, ms?: number, done = false, error = false) {
    setTrace((prev) => {
      // v2.0.1: collapse repeating heartbeat messages "<phase> ... (Ns on this phase)"
      // into a single ticking line per phase. The underlying View trace ↗ keeps every
      // heartbeat for forensic audit (server-side logEvent unchanged).
      const HB_RE = /^(.+?) \(\d+s on this phase\)\s*$/;
      const hbMatch = msg.match(HB_RE);
      if (hbMatch && prev.length > 0) {
        const key = hbMatch[1].trim();
        const last = prev[prev.length - 1];
        const lastHb = last.msg.match(HB_RE);
        if (lastHb && lastHb[1].trim() === key) {
          return [...prev.slice(0, -1), { stage, msg, ms, done, error, ts: Date.now() }];
        }
      }
      // Mark prior in-progress events as done if a new stage starts
      const next = prev.map((p, i) => (i === prev.length - 1 && !p.done) ? { ...p, done: true } : p);
      return [...next, { stage, msg, ms, done, error, ts: Date.now() }];
    });
  }

  async function submit(q: string) {
    setQuestion(q); setAnswer(''); setCitations([]); setPlosCitations([]); setCritique(null); setError(null); setExpanded({}); setHighlighted(null); setTraceId(null);
    setTrace([]); setTotalMs(undefined); setLoading(true);
    abortRef.current?.abort();
    const ctrl = new AbortController(); abortRef.current = ctrl;
    const t0 = Date.now();
    let fullAnswer = ''; let citationsLocal: Citation[] = [];
    try {
      const r = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, investigations: investigations.trim() || undefined, includePlos, multiQuery, selfCritique, useReranker, useSourceWeights }), signal: ctrl.signal });
      // v1.7 Sprint D: capture trace ID so the View trace ↗ link can deep-link to it
      const tid = r.headers.get('X-Trace-Id'); if (tid) setTraceId(tid);
      if (!r.ok) { setError(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); setLoading(false); return; }
      await consumeNdjson(r, (ev) => {
        if (ev.type === 'progress') pushTrace(ev.stage, ev.msg, ev.ms);
        else if (ev.type === 'sources') {
          citationsLocal = ev.items as Citation[];
          setCitations(citationsLocal);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const p = (ev as any).plos as PlosCitation[] | undefined;
          if (p) setPlosCitations(p);
        }
        else if (ev.type === 'token') { fullAnswer += ev.content; setAnswer(fullAnswer); }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        else if ((ev as { type: string }).type === 'draft_complete') { /* divider: draft is the current answer */ }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        else if ((ev as { type: string }).type === 'draft_superseded') { fullAnswer = ''; setAnswer(''); /* revision starts; UI clears so the next token stream replaces the draft */ }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        else if ((ev as any).type === 'critique') { const c = ev as unknown as { severity: string; issue_count: number; details: Record<string, unknown> }; setCritique({ severity: c.severity, issue_count: c.issue_count, details: c.details }); }
        else if (ev.type === 'done') { setTotalMs(ev.ms); pushTrace('done', '', ev.ms, true); }
        else if (ev.type === 'error') { setError(ev.message); pushTrace('done', ev.message, undefined, true, true); }
      });
      fetch('/api/log/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feature: 'ask', query_text: q, answer_text: fullAnswer, citation_ids: citationsLocal.map((c) => c.id), duration_ms: Date.now() - t0, session_id: sessionId }) }).catch(() => {});
    } catch (e) { if ((e as Error).name !== 'AbortError') setError(String((e as Error).message)); }
    finally { setLoading(false); }
  }

  function onSubmit(e: React.FormEvent) { e.preventDefault(); const q = question.trim(); if (q) submit(q); }
  function onCite(n: number) {
    setHighlighted(n); setExpanded((p) => ({ ...p, [n]: true }));
    setTimeout(() => document.getElementById(`cite-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    setTimeout(() => setHighlighted((h) => (h === n ? null : h)), 2000);
  }

  return (
    <div>
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="relative">
          <textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask a clinical question…" rows={3}
            className="w-full resize-none rounded-xl border border-slate-300 bg-white p-3 pr-12 text-base shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSubmit(e as unknown as React.FormEvent); }} />
          {voiceSupported && (
            <button type="button" onClick={toggleVoice} aria-label={voiceActive ? 'Stop voice input' : 'Start voice input'}
              className={`absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full border transition ${voiceActive ? 'animate-pulse border-rose-300 bg-rose-50 text-rose-600' : 'border-slate-200 bg-white text-slate-500 hover:border-brand hover:text-brand'}`}>
              {voiceActive ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </button>
          )}
        </div>
        <div>
          <button type="button" onClick={() => setShowContext((v) => !v)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-brand">
            {showContext ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            <Microscope className="h-3.5 w-3.5" /> Add clinical context — investigation findings
            {!showContext && investigations.trim() && <span className="rounded-full bg-brand-faint px-1.5 py-0.5 text-[10px] font-semibold text-brand">added</span>}
          </button>
          {showContext && (
            <>
              <textarea value={investigations} onChange={(e) => setInvestigations(e.target.value)} rows={3}
                placeholder="Investigation results already back — e.g. Troponin I <0.01 at 0h and 3h; ECG no dynamic changes; CXR clear."
                className="mt-2 w-full resize-none rounded-xl border border-slate-300 bg-white p-3 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand" />
              <p className="mt-1 text-[11px] text-slate-400">Optional. CAT interprets these and folds them into the answer — normal results rule down, abnormal results rule in.</p>
            </>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-slate-400">{voiceActive ? 'Listening — speak naturally' : '⌘+Enter to submit'}</span>
          <button type="submit" disabled={loading || !question.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white shadow disabled:cursor-not-allowed disabled:bg-slate-300">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {loading ? 'Thinking…' : 'Ask'}
          </button>
        </div>
      </form>

      {/* Example questions */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">Try</span>
        {chips.map((ex) => (
          <button key={ex} onClick={() => submit(ex)} disabled={loading} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 transition hover:border-brand hover:text-brand disabled:opacity-40">{ex}</button>
        ))}
        <button onClick={loadChips} disabled={loading} title="Show 4 different example questions"
          className="flex items-center justify-center rounded-full border border-slate-200 bg-white p-1.5 text-slate-400 transition hover:border-brand hover:text-brand disabled:opacity-40"
          aria-label="Shuffle example questions"><RefreshCw className="h-3.5 w-3.5" /></button>
      </div>

      {/* Sources & pipeline — collapsed by default; summary shows current state */}
      <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <button type="button" onClick={() => setShowSettings((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
          <SlidersHorizontal className="h-4 w-4 shrink-0 text-slate-400" />
          <span className="text-[13px] font-medium text-slate-700">Sources &amp; pipeline</span>
          {!showSettings && (
            <span className="ml-1 hidden truncate text-[11.5px] text-slate-400 sm:inline">
              Even DB{includePlos ? ' + PLOS' : ''} · {[multiQuery, selfCritique, useReranker, useSourceWeights].filter(Boolean).length}/4 pipeline steps on
            </span>
          )}
          {showSettings ? <ChevronUp className="ml-auto h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-slate-400" />}
        </button>
        {showSettings && (
          <div className="space-y-3 border-t border-slate-100 px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">Sources</span>
              <span className="inline-flex items-center gap-1 rounded-full border border-brand bg-brand-faint px-2.5 py-1 text-[11px] font-medium text-brand">Even Hospital Database</span>
              <button type="button" onClick={() => setIncludePlos((v) => !v)} disabled={loading} aria-pressed={includePlos}
                title={loading ? 'Locked while query is running' : 'Include recent PLOS ONE primary research'} className={togCls(includePlos)}>
                {includePlos ? '✓ ' : ''}PLOS ONE (last 5y, Medicine)
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">Pipeline</span>
              <button type="button" onClick={() => setMultiQuery((v) => !v)} disabled={loading} aria-pressed={multiQuery}
                title={loading ? 'Locked while query is running' : 'Generate 4 query variants for richer recall'} className={togCls(multiQuery)}>
                {multiQuery ? '✓ ' : ''}Multi-query
              </button>
              <button type="button" onClick={() => setSelfCritique((v) => !v)} disabled={loading} aria-pressed={selfCritique}
                title={loading ? 'Locked while query is running' : 'Audit + revise the draft before returning'} className={togCls(selfCritique)}>
                {selfCritique ? '✓ ' : ''}Self-critique
              </button>
              <button type="button" onClick={() => setUseReranker((v) => !v)} disabled={loading} aria-pressed={useReranker}
                title={loading ? 'Locked while query is running' : 'Cross-encoder rerank pool→top-K (better top results)'} className={togCls(useReranker)}>
                {useReranker ? '✓ ' : ''}Reranker
              </button>
              <button type="button" onClick={() => setUseSourceWeights((v) => !v)} disabled={loading} aria-pressed={useSourceWeights}
                title={loading ? 'Locked while query is running' : 'Weight chunks by book tier + chunk type + length'} className={togCls(useSourceWeights)}>
                {useSourceWeights ? '✓ ' : ''}Source weights
              </button>
            </div>
          </div>
        )}
      </div>

      {(trace.length > 0 || loading) && <div className="mt-5"><TracePanel events={trace} totalMs={totalMs} traceId={traceId} surface="ask" askChips={{ useMultiQuery: multiQuery, selfCritique, useReranker, useSourceWeights, includePlos }} /></div>}

      {error && <div className="mt-6 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div>}

      {critique && critique.issue_count > 0 && (
        <details className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 text-xs">
          <summary className="cursor-pointer font-medium text-emerald-900 hover:text-emerald-700">
            ✓ Audit pass found {critique.issue_count} issue{critique.issue_count !== 1 ? 's' : ''} in the draft — revision applied ({critique.severity})
          </summary>
          <div className="mt-2 space-y-1.5 text-emerald-900">
            {(() => {
              const d = critique.details as Record<string, string[]>;
              const sections: { label: string; items: string[] | undefined }[] = [
                { label: 'Unsupported claims', items: d.unsupported_claims },
                { label: 'Missing caveats', items: d.missing_caveats },
                { label: 'Clinical errors', items: d.clinical_errors },
                { label: 'Citation problems', items: d.citation_problems },
                { label: 'Missing evidence', items: d.missing_relevant_evidence },
              ];
              return sections.filter((s) => s.items && s.items.length > 0).map((sec) => (
                <div key={sec.label}>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">{sec.label}</div>
                  <ul className="ml-4 list-disc text-[11px] leading-snug">
                    {sec.items!.map((it, i) => <li key={i}>{it}</li>)}
                  </ul>
                </div>
              ));
            })()}
          </div>
        </details>
      )}

      {(answer || loading) && (
        <article className="mt-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          {answer && <MarkdownAnswer text={answer} onCite={(n) => onCite(parseInt(n.replace('P', ''), 10))} />}
          {loading && !answer && <div className="text-slate-400">…</div>}
          {loading && answer && <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-slate-400" />}
        </article>
      )}

      {citations.length > 0 && (
        <section ref={sourcesRef} className="mt-6">
          <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <BookOpen className="h-3.5 w-3.5" /> Sources ({citations.length})
          </h2>
          <ol className="mt-3 space-y-2">
            {citations.map((c) => {
              const isOpen = !!expanded[c.n]; const isHi = highlighted === c.n;
              return (
                <li key={c.n} id={`cite-${c.n}`} className={`rounded-lg border text-sm shadow-sm transition ${isHi ? 'border-brand bg-brand-faint/40' : 'border-slate-200 bg-white'}`}>
                  <button onClick={() => setExpanded((p) => ({ ...p, [c.n]: !isOpen }))} className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left hover:bg-slate-50">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5"><span className="rounded bg-brand-faint px-1.5 py-0.5 text-[11px] font-semibold text-brand">[{c.n}]</span><span className="truncate font-medium text-slate-800">{c.book}</span></div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        {c.chapter && <span>{c.chapter} · </span>}
                        {c.page_start && <span>p.{c.page_start}{c.page_end && c.page_end !== c.page_start ? `–${c.page_end}` : ''} · </span>}
                        {c.item_number && <span>{c.item_number.startsWith('NBK') ? c.item_number : `Item ${c.item_number}`} · </span>}
                        <span>sim {c.similarity.toFixed(2)}</span>
                      </div>
                    </div>
                    {isOpen ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
                  </button>
                  {isOpen && <div className="border-t border-slate-100 px-3 py-2 text-[13px] leading-relaxed text-slate-700">{c.preview}{c.preview.length >= 600 && <span className="text-slate-400">…</span>}</div>}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {plosCitations.length > 0 && (
        <section className="mt-6">
          <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-700">
            <BookOpen className="h-3.5 w-3.5" /> PLOS ONE primary research ({plosCitations.length})
          </h2>
          <ol className="mt-3 space-y-2">
            {plosCitations.map((p) => {
              const isOpen = !!expanded[`P${p.n}` as unknown as number];
              return (
                <li key={`P${p.n}`} className="rounded-lg border border-amber-200 bg-amber-50/30 text-sm shadow-sm">
                  <button
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onClick={() => setExpanded((prev) => ({ ...prev, [`P${p.n}` as any]: !isOpen }))}
                    className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left hover:bg-amber-50/60"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800">[P{p.n}]</span>
                        <span className="truncate font-medium text-slate-800">{p.title}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        {p.authors.length > 0 && <span>{p.authors.join(', ')}{p.authors.length === 3 ? ' et al.' : ''} · </span>}
                        <span>PLOS ONE {p.year}</span>
                        <span className="mx-1">·</span>
                        <a href={p.full_url} target="_blank" rel="noopener noreferrer" className="text-amber-700 hover:underline" onClick={(e) => e.stopPropagation()}>open article ↗</a>
                      </div>
                    </div>
                    {isOpen ? <ChevronUp className="h-4 w-4 shrink-0 text-amber-500" /> : <ChevronDown className="h-4 w-4 shrink-0 text-amber-500" />}
                  </button>
                  {isOpen && <div className="border-t border-amber-200 px-3 py-2 text-[13px] leading-relaxed text-slate-700">{p.preview}{p.preview.length >= 600 && <span className="text-slate-400">…</span>}</div>}
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
