'use client';

/**
 * v1.7 Sprint D — per-user trace viewer (non-admin).
 *
 * Renders a subset of the admin trace UI:
 *   - Question + status + timing header
 *   - Final answer
 *   - Audit summary if any
 *   - Collapsible timeline of stage events (no raw prompts unless admin)
 * Uses cookie-session auth via the trace-detail API which checks user_id match.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';

type Trace = {
  trace_id: string; user_id: number; feature: string; status: string; severity: string | null;
  question_preview: string | null; started_at: string; finished_at: string | null; total_ms: number | null;
  final_answer_text: string | null; input: { question?: string } | null; error_message: string | null;
};
type Event = { seq: number; kind: string; stage: string | null; payload: Record<string, unknown> | null; latency_ms: number | null; created_at: string };

function fmt(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function UserTraceClient({ traceId }: { traceId: string }) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // No Authorization header → server falls through to cookie-session match
        const r = await fetch(`/api/admin/traces/${traceId}`);
        if (r.status === 401) throw new Error('You can only view your own traces. (Log in if you submitted this query.)');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        setTrace(j.trace); setEvents(j.events || []);
      } catch (e) { setError(String((e as Error).message)); }
      finally { setLoading(false); }
    })();
  }, [traceId]);

  if (loading) return <div className="text-sm text-slate-500">Loading your trace…</div>;
  if (error) return (
    <div>
      <Link href="/ask" className="text-xs text-brand hover:underline">← Back to Ask</Link>
      <div className="mt-3 rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>
    </div>
  );
  if (!trace) return <div className="text-sm text-slate-500">Not found.</div>;

  const finalEv = events.find((e) => e.kind === 'final_answer');
  const critiqueEv = events.find((e) => e.kind === 'critique_parsed');
  const finalAnswer = (finalEv?.payload as { answer?: string })?.answer || trace.final_answer_text || '';
  const issues = (critiqueEv?.payload as { issue_count?: number; severity?: string })?.issue_count || 0;
  const severity = (critiqueEv?.payload as { severity?: string })?.severity;
  const question = trace.input?.question || trace.question_preview || '(no question)';

  return (
    <div>
      <Link href="/ask" className="text-xs text-brand hover:underline">← Back to Ask</Link>
      <h1 className="mt-2 text-xl font-semibold text-slate-900">Your trace</h1>
      <div className="mt-1 text-sm text-slate-500">
        <span className="font-medium text-slate-700">{question}</span>
      </div>
      <div className="mt-1 text-xs text-slate-500">
        {new Date(trace.started_at).toLocaleString('en-IN')} · {fmt(trace.total_ms)} · {trace.status}
        {severity && <span className={`ml-2 rounded px-1.5 py-0.5 ${severity === 'none' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>audit {severity}</span>}
      </div>

      <h2 className="mt-6 text-sm font-semibold text-slate-700">Final answer</h2>
      <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-800">{finalAnswer || '(no final answer captured)'}</pre>

      {issues > 0 && (
        <details className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 text-xs">
          <summary className="cursor-pointer font-medium text-emerald-900">Audit found {issues} issue{issues !== 1 ? 's' : ''} — revision was applied</summary>
          <pre className="mt-2 text-emerald-900 whitespace-pre-wrap">{JSON.stringify((critiqueEv?.payload as { critique?: unknown })?.critique, null, 2)}</pre>
        </details>
      )}

      <h2 className="mt-6 text-sm font-semibold text-slate-700">Pipeline timeline</h2>
      <div className="mt-2 space-y-1">
        {events.filter((e) => !['stream_event', 'llm_request', 'request_received'].includes(e.kind)).map((e) => (
          <div key={e.seq} className="rounded border border-slate-200 bg-white px-3 py-2 text-xs">
            <span className="font-mono text-slate-400">#{e.seq}</span>{' '}
            <span className="font-medium text-slate-800">{e.kind}</span>
            {e.stage && <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">{e.stage}</span>}
            {e.latency_ms != null && <span className="ml-2 text-slate-500">{fmt(e.latency_ms)}</span>}
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-slate-400">Detailed prompt + chunk view is available to admins at /even-admin/traces/{traceId.slice(0, 8)}…</p>
    </div>
  );
}
