'use client';

// ── 5. commentary, generated on demand (PRD decision 35, V 2026-09-03) ───────────────────────
//
// Pass B no longer runs in the audit pipeline: it cost a third of IPNO-416's 314 s wall for output
// that scores nothing and is only ever read here. So the FIRST open of an episode whose commentary
// is null asks the server to write one, and every later open reads the cached text.
//
// TWO THINGS THIS COMPONENT MUST NOT DO, both of them ways of lying about the engine:
//  · It must not present a missing commentary as a broken episode. A null commentary is a normal
//    state of a complete, scorable audit — the scores above it stand on their own.
//  · It must not fire twice. React 18 mounts twice in development; the ref guard is what stops a
//    second POST, and the route's `WHERE commentary IS NULL` write is what stops two browsers.
import { useEffect, useRef, useState } from 'react';
import { OUTCOME_AWARE_NOTICE } from '../ui';

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v == null ? '' : String(v));

function CommentaryBody({ commentary, findings }: { commentary: Row; findings: Row[] }) {
  const ctx = Array.isArray(commentary.findings_context) ? (commentary.findings_context as Row[]) : [];
  const byId = new Map(findings.map((f) => [s(f.finding_id), f]));
  return (
    <div className="mt-3 space-y-3 text-[13px] leading-relaxed text-slate-700">
      {commentary.narrative ? <p className="whitespace-pre-wrap">{s(commentary.narrative)}</p> : null}
      {commentary.outcome_context ? (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">What the outcome adds</div>
          <p className="mt-0.5 whitespace-pre-wrap">{s(commentary.outcome_context)}</p>
        </div>
      ) : null}
      {ctx.length ? (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Notes on individual findings</div>
          <ul className="mt-1 space-y-1">
            {ctx.map((c, i) => (
              <li key={i} className="text-[12.5px]">
                <span className="text-slate-400">{s(c.finding_id)}</span>
                {byId.has(s(c.finding_id))
                  ? <span className="text-slate-500"> · {s(byId.get(s(c.finding_id))!.statement).slice(0, 120)}</span>
                  : null}
                <div className="text-slate-700">{s(c.note)}</div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function CommentaryPanel({ auditId, commentary, findings }: {
  auditId: string; commentary: Row | null; findings: Row[];
}) {
  const [current, setCurrent] = useState<Row | null>(commentary);
  const [state, setState] = useState<'idle' | 'generating' | 'failed'>(commentary ? 'idle' : 'generating');
  const [error, setError] = useState<string | null>(null);
  const fired = useRef(false);

  useEffect(() => {
    if (commentary || fired.current) return;
    fired.current = true;
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/ipd-episode/commentary?id=${encodeURIComponent(auditId)}`, { method: 'POST' });
        const j = await res.json();
        if (!live) return;
        if (j?.commentary) { setCurrent(j.commentary as Row); setState('idle'); }
        else { setError(s(j?.error) || 'the commentary pass returned nothing'); setState('failed'); }
      } catch (e) {
        if (!live) return;
        setError(String((e as Error).message)); setState('failed');
      }
    })();
    return () => { live = false; };
  }, [auditId, commentary]);

  return (
    <details className="mt-6 rounded-xl border border-amber-200 bg-amber-50/40 px-4 py-3" open={state === 'generating'}>
      <summary className="cursor-pointer text-[13px] font-semibold text-slate-800">Outcome-aware commentary</summary>
      {/* PRD §10 item 5 — verbatim, and it stays above the block whatever state it is in. */}
      <p className="mt-2 rounded-md bg-amber-100/70 px-3 py-2 text-[12px] font-medium text-amber-900">{OUTCOME_AWARE_NOTICE}</p>
      {current ? <CommentaryBody commentary={current} findings={findings} /> : state === 'generating' ? (
        <p className="mt-3 text-[12.5px] text-slate-500">
          <span className="inline-block animate-pulse">Generating commentary…</span>
          <span className="ml-2 text-slate-400">This runs once and is saved with the episode.</span>
        </p>
      ) : (
        <p className="mt-3 text-[12.5px] text-slate-500">
          No commentary is stored for this episode{error ? `: ${error}` : '.'}
          <span className="mt-1 block text-slate-400">The scores above do not depend on it.</span>
        </p>
      )}
    </details>
  );
}
