import Link from 'next/link';
import type { ReactNode } from 'react';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { featureMeta, eventMeta, type EventTone } from '@/lib/observability-meta';
import { fingerprintRows, stageRollupRows, type EnvelopeEventRow } from '@/lib/reasoning/registry-core';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Trace · Admin' };

const APP = process.env.APP_SOURCE || 'standalone';

type Trace = { trace_id: string; feature: string; status: string; started_at: string; total_ms: number | null; question_preview: string | null; severity: string | null; final_answer_text: string | null; error_message: string | null; model_summary: unknown };
type Ev = { seq: number; ts: string; kind: string; stage: string | null; payload: Record<string, unknown> | null; latency_ms: number | null };
type Hit = { n?: number; id?: number; book?: string; chapter?: string; section?: string; page_start?: number; chunk_type?: string; similarity?: number; rerank_score?: number; text?: string; doi?: string; title?: string; year?: number };

const ms = (v: number | null | undefined) => (v == null ? '' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);

// Tone → colour for the pipeline node + accents.
const TONE: Record<EventTone, string> = {
  llm: '#0f766e', retrieval: '#0e7490', source: '#534ab7', cost: '#b45309',
  critique: '#d97706', result: '#16a34a', phi: '#9a4827', flag: '#b45309', error: '#dc2626', neutral: '#a8a08f',
};

function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
function obj(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') { try { return JSON.parse(v) as Record<string, unknown>; } catch { return {}; } }
  return {};
}
function Pre({ children }: { children: string }) {
  return <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-[11px] leading-snug text-slate-700">{children}</pre>;
}

export default async function TraceDetail({ params }: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await params;
  if (!(await isAdminUnlocked())) {
    return <div><h1 className="font-serif text-2xl font-semibold text-slate-900">Locked</h1><p className="mt-2 text-sm text-slate-500"><Link className="text-brand underline" href="/admin/observability">Unlock the observability surface</Link> to view traces.</p></div>;
  }

  const traceRows = (await sql`SELECT trace_id, feature, status, to_char(started_at,'YYYY-MM-DD HH24:MI:SS') AS started_at, total_ms, question_preview, severity, final_answer_text, error_message, model_summary FROM traces WHERE trace_id = ${traceId} AND app_source = ${APP} LIMIT 1`.catch(() => [])) as Trace[];
  const tr = traceRows[0];
  if (!tr) return <div><Link href="/admin/observability?tab=queries" className="text-sm text-brand">← Runs</Link><p className="mt-4 text-sm text-slate-500">Trace not found.</p></div>;
  const events = (await sql`SELECT seq, to_char(ts,'HH24:MI:SS') AS ts, kind, stage, payload, latency_ms FROM trace_events WHERE trace_id = ${traceId} ORDER BY seq ASC`.catch(() => [])) as Ev[];

  // ── Reasoning fingerprint (Stage 2) — INFERRED read of the Stage-1 envelope columns, in a
  // SEPARATE soft query: pre-migration (or on pre-Stage-1 rows) it fails/returns nothing and
  // the panels simply don't render; the main trace view above is never at risk.
  const envRows = (await sql`SELECT seq, stage, prompt_id, prompt_version, prompt_hash, rubric_versions, output_schema_version, call_model, call_provider, gen_params, tokens_in, tokens_out, latency_ms FROM trace_events WHERE trace_id = ${traceId} AND (prompt_id IS NOT NULL OR call_model IS NOT NULL) ORDER BY seq ASC`.catch(() => [])) as EnvelopeEventRow[];
  const fps = fingerprintRows(envRows);
  const rollup = stageRollupRows(envRows);
  const modelSummary = obj(tr.model_summary);
  const modelSummaryEntries = Object.entries(modelSummary).filter(([, v]) => typeof v === 'string') as Array<[string, string]>;

  const fm = featureMeta(tr.feature);
  const visible = events.filter((e) => e.kind !== 'stream_event');

  // ── Integrity summary (the "audit the audit" strip), computed from events ──
  const llmEvents = events.filter((e) => e.kind === 'llm_request');
  const models = Array.from(new Set(llmEvents.map((e) => String(obj(e.payload).model || '')).filter(Boolean)));
  const providers = Array.from(new Set(events.filter((e) => e.kind === 'llm_request' || e.kind === 'llm_response' || e.kind === 'llm_response_stream_complete').map((e) => String(obj(e.payload).provider || '')).filter(Boolean)));
  const fellBack = events.some((e) => e.kind === 'provider_fallback');
  const hadError = events.some((e) => e.kind === 'llm_error') || tr.status === 'error';
  const critiqueEv = events.find((e) => e.kind === 'critique_parsed' || e.kind.endsWith('_critique'));
  const cp = critiqueEv ? obj(critiqueEv.payload) : null;
  const isPhi = tr.feature.startsWith('doc_audit');
  let tokens = 0;
  for (const e of events) { const p = obj(e.payload); const t = Number((p.usage as Record<string, unknown>)?.total_tokens ?? p.total_tokens ?? 0); if (Number.isFinite(t)) tokens += t; }
  const sourcesEv = events.find((e) => e.kind.endsWith('_sources') || e.kind === 'retrieval_hydrated');
  const sourceCount = sourcesEv ? Number(obj(sourcesEv.payload).count ?? obj(sourcesEv.payload).hit_count ?? ((obj(sourcesEv.payload).hits as unknown[])?.length ?? 0)) : 0;

  const retr = events.find((e) => e.kind === 'retrieval_hydrated');
  const hits = ((obj(retr?.payload).hits as Hit[]) || []);
  const plos = events.find((e) => e.kind === 'plos_search');
  const plosHits = ((obj(plos?.payload).hits as Hit[]) || []);
  const finalEv = events.find((e) => e.kind === 'final_answer');
  const finalText = tr.final_answer_text || asText(obj(finalEv?.payload).answer_text) || '';
  const citeTokens = Array.from(new Set((finalText.match(/\[(P?\d+)\]/g) || []).map((s) => s.slice(1, -1))));
  function sourceLabel(tok: string): string {
    if (tok[0] === 'P') { const i = Number(tok.slice(1)) - 1; const h = plosHits[i]; return h ? `PLOS · ${h.title || h.doi || '?'}${h.year ? ` (${h.year})` : ''}` : 'PLOS source (not found)'; }
    const k = Number(tok); const h = hits.find((x) => x.n === k) || hits[k - 1];
    return h ? `${h.book || '?'}${h.chapter ? ' · ' + h.chapter : ''}${h.section ? ' · ' + h.section : ''}${typeof h.similarity === 'number' ? ` (sim ${h.similarity.toFixed(2)})` : ''}` : 'source (not found)';
  }

  const statusColor = tr.status === 'error' ? 'text-red-700' : tr.status === 'success' ? 'text-teal-700' : 'text-amber-700';

  return (
    <div>
      <Link href="/admin/observability?tab=queries" className="text-sm text-brand hover:underline">← Runs</Link>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded-md px-2 py-0.5 text-[11px] font-medium" style={{ background: fm.color + '1f', color: fm.color }}>{fm.label}</span>
        <h1 className="font-serif text-[22px] font-semibold leading-tight text-slate-900">{tr.question_preview || '(no preview)'}</h1>
      </div>
      <div className="mt-1 font-mono text-[11px] text-slate-400">{tr.trace_id} · {tr.started_at} · {visible.length} events</div>
      {tr.error_message && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">{tr.error_message}</div>}

      {/* ── Integrity strip ── */}
      <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 sm:grid-cols-3 lg:grid-cols-6">
        <Cell label="Status" value={tr.status} valueClass={statusColor} />
        <Cell label="Total latency" value={ms(tr.total_ms) || '—'} />
        <Cell label="LLM calls" value={String(llmEvents.length)} sub={models.join(', ') || undefined} />
        <Cell label="Provider" value={fellBack ? 'fell back' : (providers[0] || '—')} valueClass={fellBack ? 'text-red-700' : undefined} sub={fellBack ? 'Vertex → Ollama' : undefined} />
        <Cell label="Self-critique" value={cp ? String(cp.severity ?? 'run') : '—'} sub={cp && cp.issue_count != null ? `${cp.issue_count} issue${cp.issue_count === 1 ? '' : 's'}` : undefined} valueClass={cp && cp.severity && cp.severity !== 'none' ? 'text-amber-700' : undefined} />
        {isPhi
          ? <Cell label="PHI" value="de-identified" valueClass="text-teal-700" sub="name/UHID stripped" />
          : <Cell label={tokens > 0 ? 'Tokens' : 'Retrieved'} value={tokens > 0 ? tokens.toLocaleString() : String(sourceCount || '—')} sub={tokens > 0 ? undefined : 'candidate pool'} />}
      </div>
      {hadError && <div className="mt-2 text-[11px] text-red-600">Pipeline reported an error — see the timeline below.</div>}

      {/* ── Reasoning fingerprint (Stage 2) — from the Stage-1 envelope columns ── */}
      {fps.length > 0 && (
        <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50/40 p-3">
          <div className="mb-2 text-[13px] font-medium text-slate-800">Reasoning fingerprint</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {fps.map((f) => (
              <div key={f.promptId} className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-indigo-100 bg-indigo-100 sm:grid-cols-4">
                <Cell label="prompt" value={f.shortId} valueClass="font-mono text-[12px] normal-case text-slate-900" sub={f.version} />
                <Cell label="prompt hash" value={f.sha12 + '…'} valueClass="font-mono text-[12px] normal-case text-slate-700" />
                <Cell label="rubric" value={f.rubrics.length ? f.rubrics.join(', ') : '—'} valueClass="text-[12px] normal-case text-slate-700" sub={f.schema ? `schema ${f.schema}` : undefined} />
                <Cell label="model" value={f.model ?? '—'} valueClass="text-[12px] normal-case text-slate-700" sub={[f.provider, f.temperature != null ? `temp ${f.temperature}` : null, f.maxTokens != null ? `max ${f.maxTokens}` : null].filter(Boolean).join(' · ') || undefined} />
              </div>
            ))}
          </div>
          <div className="mt-1.5 text-[10.5px] text-slate-400">Promoted from payload JSONB to queryable columns (migration 0012) — stamped from the prompt registry at the tracedChat choke point.</div>
        </div>
      )}

      {/* ── Per-stage LLM rollup (Stage 2) ── */}
      {rollup.length > 0 && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3">
          <div className="mb-2 text-[13px] font-medium text-slate-800">LLM calls — per-stage rollup ({rollup.length})</div>
          <table className="w-full text-left text-[12px]">
            <thead className="text-[10.5px] uppercase tracking-wide text-slate-400">
              <tr><th className="py-1 pr-3 font-medium">stage</th><th className="py-1 pr-3 font-medium">prompt</th><th className="py-1 pr-3 font-medium">model</th><th className="py-1 pr-3 text-right font-medium">tok in</th><th className="py-1 pr-3 text-right font-medium">tok out</th><th className="py-1 text-right font-medium">latency</th></tr>
            </thead>
            <tbody>
              {rollup.map((r, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="py-1 pr-3 text-slate-700">{r.stage}</td>
                  <td className="py-1 pr-3 font-mono text-[11px] text-slate-600">{r.promptShortId ?? '—'}</td>
                  <td className="py-1 pr-3 text-slate-600">{r.model ?? '—'}</td>
                  <td className="py-1 pr-3 text-right tabular-nums text-slate-600">{r.tokensIn?.toLocaleString() ?? '—'}</td>
                  <td className="py-1 pr-3 text-right tabular-nums text-slate-600">{r.tokensOut?.toLocaleString() ?? '—'}</td>
                  <td className="py-1 text-right tabular-nums text-slate-500">{r.latencyMs != null ? ms(r.latencyMs) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Model summary (Stage 2) — the previously-unrendered traces.model_summary ── */}
      {modelSummaryEntries.length > 0 && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3">
          <div className="mb-1.5 text-[13px] font-medium text-slate-800">Model summary</div>
          <div className="flex flex-wrap gap-1.5">
            {modelSummaryEntries.map(([k, v]) => (
              <span key={k} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600"><span className="text-slate-400">{k}</span> → {v}</span>
            ))}
          </div>
        </div>
      )}

      {citeTokens.length > 0 && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3">
          <div className="mb-2 text-[13px] font-medium text-slate-800">Citation attribution ({citeTokens.length})</div>
          <div className="space-y-1">
            {citeTokens.map((t) => (<div key={t} className="flex gap-2 text-[12px]"><span className="font-mono text-slate-500">[{t}]</span><span className="text-slate-700">{sourceLabel(t)}</span></div>))}
          </div>
        </div>
      )}

      <div className="mt-5 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400">Pipeline — {visible.length} stages</div>
      <ol className="relative mt-3 space-y-2.5 pl-7">
        <span className="absolute left-[10px] top-2 bottom-2 w-px bg-slate-200" aria-hidden />
        {visible.length === 0
          ? <li className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">No pipeline events recorded{tr.status === 'running' ? ' yet (still running).' : '.'}</li>
          : visible.map((e) => <EventCard key={e.seq} e={e} />)}
      </ol>
    </div>
  );
}

function Cell({ label, value, sub, valueClass }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="bg-white px-3 py-2.5">
      <div className="text-[10.5px] text-slate-400">{label}</div>
      <div className={`text-[14px] font-medium capitalize ${valueClass || 'text-slate-900'}`}>{value}</div>
      {sub && <div className="truncate text-[10px] text-slate-400" title={sub}>{sub}</div>}
    </div>
  );
}

const SCALAR_KEYS = ['model', 'provider', 'severity', 'issue_count', 'count', 'hit_count', 'char_count', 'finish_reason', 'intended_model', 'fallback_model'];
function scalarChips(p: Record<string, unknown>) {
  const chips: { k: string; v: string }[] = [];
  for (const k of SCALAR_KEYS) {
    const v = p[k];
    if (v != null && (typeof v === 'string' || typeof v === 'number')) chips.push({ k, v: String(v) });
  }
  return chips;
}

function EventCard({ e }: { e: Ev }) {
  const p = obj(e.payload);
  const meta = eventMeta(e.kind);
  const color = TONE[meta.tone];
  const lat = e.latency_ms != null ? ms(e.latency_ms) : '';

  // Rich renderers for the well-known Ask/DDx event shapes.
  let body: ReactNode = null;
  if (e.kind === 'request_received') {
    body = <><div className="mt-1 text-[11px] text-slate-500">raw input</div><Pre>{asText(p.body ?? p).slice(0, 4000)}</Pre></>;
  } else if (e.kind === 'retrieval_hydrated') {
    const hh = (p.hits as Hit[]) || []; const variants = (p.variants as string[]) || [];
    body = <>
      {variants.length > 0 && <div className="mt-1 text-[11px] text-slate-500">query variants: {variants.map((v, i) => <span key={i} className="mr-1 rounded bg-slate-100 px-1">{v}</span>)}</div>}
      <div className="mt-2 space-y-1">{hh.slice(0, 12).map((h, i) => (
        <details key={i} className="rounded bg-slate-50 p-1.5">
          <summary className="cursor-pointer text-[12px] text-slate-700">[{h.n ?? i + 1}] {h.book || '?'}{h.chapter ? ' · ' + h.chapter : ''} <span className="text-slate-400">{typeof h.similarity === 'number' ? `sim ${h.similarity.toFixed(2)}` : ''}{typeof h.rerank_score === 'number' ? ` · rr ${Number(h.rerank_score).toFixed(2)}` : ''}</span></summary>
          <div className="mt-1 text-[11px] text-slate-600">{(h.text || '').slice(0, 600)}</div>
        </details>))}
      </div></>;
  } else if (e.kind === 'plos_search') {
    const hh = (p.hits as Hit[]) || [];
    body = <div className="mt-1 space-y-0.5 text-[11px] text-slate-600">{hh.slice(0, 8).map((h, i) => <div key={i}>[P{i + 1}] {h.title || h.doi}{h.year ? ` (${h.year})` : ''}</div>)}</div>;
  } else if (e.kind === 'llm_request') {
    const msgs = (p.messages as Array<{ role: string; content: string }>) || [];
    body = <details className="mt-1"><summary className="cursor-pointer text-[11px] text-slate-500">prompt ({msgs.length} messages)</summary>{msgs.map((m, i) => (<div key={i} className="mt-1"><div className="text-[11px] font-medium text-slate-500">{m.role}</div><Pre>{String(m.content || '').slice(0, 6000)}</Pre></div>))}</details>;
  } else if (e.kind === 'llm_response' || e.kind === 'llm_response_stream_complete') {
    const content = asText(p.content);
    body = <details className="mt-1"><summary className="cursor-pointer text-[11px] text-slate-500">response ({String(p.char_count ?? content.length)} chars)</summary><Pre>{content.slice(0, 8000)}</Pre></details>;
  } else if (e.kind === 'final_answer') {
    body = <Pre>{asText(p.answer_text).slice(0, 8000)}</Pre>;
  } else {
    // Generic + Right Care: scalar chips + a payload viewer (open for the meaty stages).
    const openByDefault = meta.tone === 'result' || meta.tone === 'critique' || meta.tone === 'phi';
    body = <details className="mt-1" open={openByDefault}><summary className="cursor-pointer text-[11px] text-slate-500">payload</summary><Pre>{asText(p).slice(0, 8000)}</Pre></details>;
  }

  return (
    <li className="relative">
      <span className="absolute -left-7 top-2 h-[15px] w-[15px] rounded-full border-2 bg-white" style={{ borderColor: color }} aria-hidden />
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-[13px] font-medium text-slate-800">{meta.label}</span>
          <span className="text-[11px] text-slate-400">{e.ts}{e.stage ? ` · ${e.stage}` : ''}{lat ? ` · ${lat}` : ''}</span>
          <span className="ml-auto flex flex-wrap gap-1">
            {scalarChips(p).map((c) => (
              <span key={c.k} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600"><span className="text-slate-400">{c.k}</span> {c.v}</span>
            ))}
          </span>
        </div>
        {body}
      </div>
    </li>
  );
}
