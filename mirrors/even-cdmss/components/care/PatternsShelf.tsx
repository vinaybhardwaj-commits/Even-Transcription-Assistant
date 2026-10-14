'use client';

/**
 * Low-value patterns shelf (LVP-L1 kickoff §4.2–§4.4). Anatomy in the kickoff's exact order:
 * crumb · title + pill · lede · honesty banner · three-step strip · tabs (Suggested/Hidden) ·
 * hint · cards · footer. ONE control per Suggested card (Hide this kind); Hidden gets Unhide.
 * Empty Suggested is a SUCCESS state. A degraded read renders the empty state with a quiet
 * one-line notice. Styling matches the live CAT conventions (max-w-3xl / rounded-2xl /
 * text-[12.5px] / system-ui — LvcBoard/TriageBoard idiom).
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Layers, EyeOff, Eye, Moon, Sunrise, Hand } from 'lucide-react';

type Suggested = {
  pattern_id: string; concept_id: string; direction: string; action: string; target: string;
  title: string; why: string; pill: string; volume_week: number; doctor_count: number | null;
  first_seen: string | null; examples: string[]; generated_at: string; model: string;
};
type Hidden = {
  pattern_id: string; concept_id: string | null; title: string; cm_user: string;
  reason: string | null; hidden_at: string | null;
};
type Shelf = { ok: boolean; suggested: Suggested[]; hidden: Hidden[]; degraded?: boolean; error?: string };

export default function PatternsShelf() {
  const [shelf, setShelf] = useState<Shelf | null>(null);
  const [tab, setTab] = useState<'suggested' | 'hidden'>('suggested');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch('/api/care/patterns/list');
      const j = (await r.json()) as Shelf;
      if (!r.ok || !j.ok) throw new Error(String(j.error || `status ${r.status}`));
      setShelf(j);
    } catch (e) { setErr(String((e as Error).message)); setShelf({ ok: true, suggested: [], hidden: [], degraded: true }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (patternId: string, op: 'hide' | 'unhide') => {
    setBusy(patternId); setErr(null);
    try {
      const r = await fetch('/api/care/patterns/hide', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pattern_id: patternId, op }),
      });
      const j = (await r.json().catch(() => ({}))) as Shelf;
      if (!r.ok || !j.ok) throw new Error(String(j.error || `status ${r.status}`));
      setShelf(j);
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(null); }
  };

  const suggested = shelf?.suggested ?? [];
  const hidden = shelf?.hidden ?? [];

  return (
    <div className="mx-auto max-w-3xl px-5 py-8" style={{ fontFamily: 'system-ui, sans-serif' }}>
      {/* 1 · crumb */}
      <nav className="text-[12px] text-slate-400">
        <Link href="/care" className="hover:text-slate-600">Managed Care</Link>
        <span className="mx-1.5">›</span>
        <span className="text-slate-500">Low-value patterns</span>
      </nav>

      {/* 2 · title row */}
      <div className="mt-2 flex items-center gap-2">
        <Layers className="h-5 w-5 text-amber-500" />
        <h1 className="text-[19px] font-semibold text-slate-900">Low-value patterns</h1>
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">Shelf · not a finding</span>
      </div>

      {/* 3 · lede */}
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-500">
        What the operator clustered from last night&apos;s notes. Leaving these is the job. Hide a kind only
        if it&apos;s noise. Nothing here is a finding, and nothing here can be routed to a doctor.
      </p>

      {/* 4 · honesty banner */}
      <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/60 px-3.5 py-2.5 text-[12px] leading-relaxed text-amber-900">
        Nothing here changes an audit score. Nothing here enters OPD Audit Triage. Hide compiles so the
        class does not recur. Promote-to-rule is a separate, rare act — not this page.
      </div>

      {/* 5 · three-step strip (static, not a wizard) */}
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {[
          { icon: Moon, label: '1 · Night — Operator clusters', line: 'Overnight, the operator groups last night’s stamped low-value findings into kinds.' },
          { icon: Sunrise, label: '2 · Morning — They appear here', line: 'Each kind shows up as a suggestion card — a count, not an argument, never a finding.' },
          { icon: Hand, label: '3 · You, if needed — Hide this kind', line: 'If a kind is noise, hide it and the operator stops re-suggesting it. Leaving it is fine.' },
        ].map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.label} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-slate-700">
                <Icon className="h-3.5 w-3.5 text-slate-400" />{s.label}
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-slate-500">{s.line}</p>
            </div>
          );
        })}
      </div>

      {/* 6 · tabs */}
      <div className="mt-5 flex items-center gap-2">
        {([['suggested', `Suggested (${suggested.length})`], ['hidden', `Hidden (${hidden.length})`]] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition ${
              tab === key ? 'bg-slate-900 text-white' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {err && <p className="mt-3 text-[12px] text-red-600">{err}</p>}
      {loading && !shelf && <p className="mt-6 text-[13px] text-slate-400">Loading…</p>}

      {tab === 'suggested' && (
        <section className="mt-3">
          {/* 7 · hint */}
          <p className="text-[11.5px] text-slate-400">Sorted by volume. You do not have to clear this.</p>

          {shelf?.degraded && (
            <p className="mt-2 text-[11.5px] text-slate-400">Live data unavailable right now — showing an empty shelf.</p>
          )}

          {!loading && suggested.length === 0 && (
            <p className="mt-5 text-[13px] text-slate-500">Nothing suggested. That is fine.</p>
          )}

          {/* 8 · pattern cards */}
          <div className="mt-3 space-y-3">
            {suggested.map((p) => (
              <div key={p.pattern_id} className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Suggestion</span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{p.pill}</span>
                  <span className="ml-auto text-[11.5px] text-slate-500">
                    ×{p.volume_week} this week{p.first_seen ? ` · since ${p.first_seen}` : ''}
                  </span>
                </div>
                {p.doctor_count != null && (
                  <p className="mt-1 text-[11.5px] text-slate-500">{p.doctor_count} doctors</p>
                )}
                <p className="mt-2 text-[14px] font-medium leading-snug text-slate-900">{p.title}</p>
                <p className="mt-0.5 font-mono text-[11px] text-slate-400">{p.pattern_id}</p>
                <p className="mt-2 text-[12px] leading-relaxed text-slate-500">{p.why}</p>
                {p.examples.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {p.examples.map((ex, i) => (
                      <p key={i} className="rounded-md bg-slate-50 px-2 py-1 text-[11.5px] text-slate-500">{ex}</p>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex items-center gap-2.5">
                  <button onClick={() => act(p.pattern_id, 'hide')} disabled={busy === p.pattern_id}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[12.5px] text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
                    <EyeOff className="h-3.5 w-3.5" />Hide this kind
                  </button>
                  <span className="text-[11.5px] text-slate-400">Leaving it is fine. It still cannot reach a doctor.</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 9 · hidden tab */}
      {tab === 'hidden' && (
        <section className="mt-3">
          <p className="text-[11.5px] text-slate-400">
            Compiled suppressions. The operator will not re-suggest these. Unhide brings them back to the
            shelf only — still never a finding, still never Triage.
          </p>
          {!loading && hidden.length === 0 && (
            <p className="mt-5 text-[13px] text-slate-500">Nothing hidden.</p>
          )}
          <div className="mt-3 space-y-3">
            {hidden.map((h) => (
              <div key={h.pattern_id} className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Hidden</span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">compiled</span>
                  <span className="ml-auto text-[11.5px] text-slate-500">
                    {h.cm_user}{h.hidden_at ? ` · ${h.hidden_at}` : ''}
                  </span>
                </div>
                <p className="mt-2 text-[14px] font-medium leading-snug text-slate-900">{h.title}</p>
                <p className="mt-0.5 font-mono text-[11px] text-slate-400">{h.pattern_id}</p>
                {h.reason && <p className="mt-1.5 text-[12px] italic text-slate-500">{h.reason}</p>}
                <div className="mt-3">
                  <button onClick={() => act(h.pattern_id, 'unhide')} disabled={busy === h.pattern_id}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[12.5px] text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
                    <Eye className="h-3.5 w-3.5" />Unhide
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 10 · footer */}
      <p className="mt-8 text-[11.5px] leading-relaxed text-slate-400">
        Replaces Concept coder and the retired adjudication room as the care-manager surface. The dictionary
        still stamps in the background. Grounding does not live on this page. Triage is unchanged: last
        night&apos;s real findings, Valid / Bug / Route.
      </p>
    </div>
  );
}
