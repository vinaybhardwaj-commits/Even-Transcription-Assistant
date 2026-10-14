'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import { consumeNdjson } from '@/lib/ndjson-client';
import TracePanel, { TraceEvent } from '@/components/TracePanel';
import ErrorBoundary from '@/components/ErrorBoundary';
import { Send, Loader2, Pill, AlertTriangle, ChevronDown, ChevronUp, BookOpen, Plus, X, Activity } from 'lucide-react';

type Citation = {
  n: number; id: number; book: string; chapter: string | null;
  page_start: number | null; page_end: number | null;
  similarity: number; preview: string;
};

type PK = {
  absorption?: string; distribution?: string; metabolism?: string; excretion?: string;
  half_life?: string; bioavailability?: string; onset?: string; duration?: string;
};
type SpecialPop = {
  pregnancy?: string; pediatric?: string; geriatric?: string; renal_impairment?: string; hepatic_impairment?: string;
};
type LookupResp = {
  input?: string;
  normalized?: string;
  drug_normalized?: string;
  class?: string;
  subclass?: string;
  mechanism_of_action?: string;
  receptors_targets?: string[];
  biochemistry?: string;
  pharmacokinetics?: PK;
  pharmacodynamics?: string;
  indications?: string[];
  formulations?: string[];
  typical_dosing?: string[];
  renal_adjust?: string;
  hepatic_adjust?: string;
  contraindications?: string[];
  adverse_effects?: string[];
  drug_interactions_summary?: string[];
  monitoring?: string[];
  special_populations?: SpecialPop;
  key_pearls?: string[];
  citations?: Citation[];
  duration_ms?: number;
  error?: string;
};

type Pair = {
  drug_a: string;
  drug_b: string;
  severity?: 'contraindicated' | 'major' | 'moderate' | 'minor' | 'none' | string;
  mechanism?: string;
  consequence?: string;
  management?: string;
  citation_ids?: number[];
};
type PubChemFacts = {
  cid: number | null;
  canonical_name: string | null;
  synonyms: string[];
  mesh_pharmacological_actions: string[];
  atc_codes: string[];
  indication: string | null;
  url: string | null;
  fetched_at: string;
};
type ClassOverlapPair = {
  a: string; b: string;
  cid_a: number | null; cid_b: number | null;
  shared_atc3: string[]; shared_atc2: string[]; shared_labels: string[];
};
type InteractionsResp = {
  input?: string[];
  normalized?: string[];
  summary?: string;
  pairs?: Pair[];
  citations?: Citation[];
  class_overlap_pairs?: ClassOverlapPair[];
  pubchem_facts?: Array<{ cid: number | null; canonical_name: string | null; atc_codes: string[]; url: string | null } | null>;
  duration_ms?: number;
  error?: string;
};

const SEVERITY_ORDER: Record<string, number> = {
  contraindicated: 0, major: 1, moderate: 2, minor: 3, none: 4,
};
const SEVERITY_STYLE: Record<string, string> = {
  contraindicated: 'border-rose-300 bg-rose-50',
  major: 'border-orange-300 bg-orange-50',
  moderate: 'border-amber-200 bg-amber-50',
  minor: 'border-slate-200 bg-slate-50',
  none: 'border-slate-100 bg-white',
};
const SEVERITY_PILL: Record<string, string> = {
  contraindicated: 'bg-rose-200 text-rose-900',
  major: 'bg-orange-200 text-orange-900',
  moderate: 'bg-amber-200 text-amber-900',
  minor: 'bg-slate-200 text-slate-700',
  none: 'bg-slate-100 text-slate-500',
};

function SourcesRail({ citations, highlighted, openIds, setOpenIds }: {
  citations: Citation[]; highlighted: number | null;
  openIds: Record<number, boolean>; setOpenIds: (f: (p: Record<number, boolean>) => Record<number, boolean>) => void;
}) {
  if (!citations.length) return null;
  return (
    <section className="mt-6">
      <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <BookOpen className="h-3.5 w-3.5" /> Sources ({citations.length})
      </h2>
      <ol className="space-y-2">
        {citations.map((c) => {
          const isOpen = !!openIds[c.n];
          const isHi = highlighted === c.n;
          return (
            <li
              key={c.n}
              id={`drugs-cite-${c.n}`}
              className={`rounded-lg border text-sm shadow-sm transition ${
                isHi ? 'border-brand bg-brand-faint/40' : 'border-slate-200 bg-white'
              }`}
            >
              <button
                onClick={() => setOpenIds((p) => ({ ...p, [c.n]: !isOpen }))}
                className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left hover:bg-slate-50"
              >
                <div className="min-w-0 flex-1">
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
                {isOpen ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
              </button>
              {isOpen && (
                <div className="border-t border-slate-100 px-3 py-2 text-[13px] leading-relaxed text-slate-700">
                  {c.preview}…
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function LookupPanel() {
  const [drug, setDrug] = useState('');
  const [renalCtxBanner, setRenalCtxBanner] = useState<{ckdepi:number; stage:string; cg:number|null; ts:string} | null>(null);
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem('cdmss_renal_ctx');
      if (!stored) return;
      const ctx = JSON.parse(stored);
      setRenalCtxBanner({
        ckdepi: ctx.ckdepi_2021_ml_min_173 ?? 0,
        stage: ctx.stage ?? '?',
        cg: ctx.cg_crcl_ml_min ?? null,
        ts: ctx.computed_at ?? '',
      });
    } catch {}
  }, []);
  function clearRenalCtx() {
    try { sessionStorage.removeItem('cdmss_renal_ctx'); } catch {}
    setRenalCtxBanner(null);
  }
  const [data, setData] = useState<LookupResp | null>(null);
  const [pubchemFacts, setPubchemFacts] = useState<PubChemFacts | null>(null);
  // v2.0.1: self-critique toggle (default ON) + critique result banner
  const [selfCritique, setSelfCritique] = useState(true);
  const [critique, setCritique] = useState<{ severity: string; issue_count: number; details: Record<string, unknown> } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [openIds, setOpenIds] = useState<Record<number, boolean>>({});
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [totalMs, setTotalMs] = useState<number | undefined>(undefined);
  const [traceId, setTraceId] = useState<string | null>(null);
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
          // Same heartbeat key — REPLACE last event in-place instead of appending.
          return [...prev.slice(0, -1), { stage, msg, ms, done, error, ts: Date.now() }];
        }
      }
      const next = prev.map((p, i) => (i === prev.length - 1 && !p.done) ? { ...p, done: true } : p);
      return [...next, { stage, msg, ms, done, error, ts: Date.now() }];
    });
  }
  const sessionId = useMemo(() => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())), []);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const q = drug.trim();
    if (!q) return;
    setError(null); setData(null); setPubchemFacts(null); setCritique(null); setLoading(true); setOpenIds({});
    setTrace([]); setTotalMs(undefined); setTraceId(null);
    const t0 = Date.now();
    try {
      // CALC.1.3: read renal context from /drugs/egfr push (if active in this session)
      let renalCtx: unknown = null;
      try {
        const stored = sessionStorage.getItem('cdmss_renal_ctx');
        if (stored) renalCtx = JSON.parse(stored);
      } catch {}
      const r = await fetch('/api/drugs/lookup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drug: q, renal_ctx: renalCtx, selfCritique }),
      });
      const tid = r.headers.get('x-trace-id'); if (tid) setTraceId(tid);
      if (!r.ok) { setError(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); return; }
      const dRef: { current: LookupResp | null } = { current: null };
      await consumeNdjson(r, (ev) => {
        if (ev.type === 'progress') pushTrace(ev.stage, ev.msg, ev.ms);
        else if (ev.type === 'result') {
          // MERGE phases, never replace. Each phase emits only its own fields
          // (server whitelist in PHASE_FIELDS), so phase 2's payload doesn't
          // contain phase 1's fields and shallow-merging accumulates the full card.
          // Bug fix: previously setData(ev.data) wiped phase 2 data when phase 3 arrived.
          dRef.current = { ...(dRef.current || {} as LookupResp), ...(ev.data as Partial<LookupResp>) } as LookupResp;
          setData(dRef.current);
        }
        else if (ev.type === 'pubchem_facts') { setPubchemFacts((ev as unknown as { data: PubChemFacts }).data); }
        else if (ev.type === 'done') { setTotalMs(ev.ms); pushTrace('done', '', ev.ms, true); }
        else if (ev.type === 'error') { setError(ev.message); pushTrace('done', ev.message, undefined, true, true); }
      });
      if (!dRef.current) return;
      const d = dRef.current;
      fetch('/api/log/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feature: 'drugs_lookup', query_text: q,
          expanded_query: d.normalized,
          answer_text: JSON.stringify({ class: d.class, indications: d.indications, dosing: d.typical_dosing }),
          citation_ids: (d.citations || []).map((c) => c.id),
          duration_ms: Date.now() - t0, session_id: sessionId,
        }),
      }).catch(() => {});
    } catch (e) { setError(String((e as Error).message)); }
    finally { setLoading(false); }
  }

  function onCite(n: number) {
    setHighlighted(n);
    setOpenIds((p) => ({ ...p, [n]: true }));
    setTimeout(() => document.getElementById(`drugs-cite-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    setTimeout(() => setHighlighted((h) => (h === n ? null : h)), 2000);
  }

  return (
    <div>
      {renalCtxBanner && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <div>
            <span className="font-medium">Renal context active:</span>{' '}
            eGFR {renalCtxBanner.ckdepi} ({renalCtxBanner.stage})
            {renalCtxBanner.cg !== null && <span className="ml-1 text-emerald-700/80">· CG {renalCtxBanner.cg}</span>}
            <span className="ml-2 text-xs text-emerald-700/70">— next lookup will receive renal-adjusted dosing context</span>
          </div>
          <button type="button" onClick={clearRenalCtx} className="text-xs text-emerald-800 hover:underline">Clear ×</button>
        </div>
      )}
      <form onSubmit={submit} className="flex gap-2">
        <input
          value={drug}
          onChange={(e) => setDrug(e.target.value)}
          placeholder="Generic or brand (e.g. metformin, Coumadin, atorvastatin)"
          className="flex-1 rounded-lg border border-slate-300 bg-white p-3 text-base shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
        <button
          type="submit"
          disabled={loading || !drug.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white shadow disabled:bg-slate-300"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {loading ? 'Looking up…' : 'Look up'}
        </button>
      </form>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-400">Try:</span>
        {['metformin', 'warfarin', 'amiodarone', 'lisinopril', 'levetiracetam'].map((d) => (
          <button key={d} onClick={() => { setDrug(d); }} disabled={loading}
            className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 hover:border-brand hover:text-brand disabled:opacity-40">
            {d}
          </button>
        ))}
        {/* v2.0.1: Self-critique killswitch chip (default ON) */}
        <button
          type="button"
          onClick={() => setSelfCritique(!selfCritique)}
          disabled={loading}
          aria-pressed={selfCritique}
          title={loading ? 'Locked while query is running' : (selfCritique ? 'Audit pass on the pharmacology phase is enabled — adds ~2-3 min for higher accuracy' : 'Audit pass disabled — faster but no second-opinion check')}
          className={`ml-auto rounded-full border px-3 py-1 text-xs font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${
            selfCritique
              ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
              : 'border-slate-300 bg-white text-slate-500 hover:border-slate-400'
          }`}
        >
          {selfCritique ? '✓ Self-critique' : 'Self-critique off'}
        </button>
      </div>

      {(trace.length > 0 || loading) && <div className="mt-5"><TracePanel events={trace} totalMs={totalMs} traceId={traceId} surface="drugs" /></div>}
      {error && <div className="mt-6 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div>}

      {/* v2.0.1: critique banner — shows when the pharmacology audit pass flagged + fixed issues */}
      {critique && (critique.issue_count > 0 || critique.severity !== 'none') && (
        <div className={`mt-4 rounded-lg border p-3 text-sm ${
          critique.severity === 'major' ? 'border-rose-300 bg-rose-50 text-rose-900'
            : critique.severity === 'moderate' ? 'border-amber-300 bg-amber-50 text-amber-900'
            : 'border-emerald-300 bg-emerald-50 text-emerald-900'
        }`}>
          <div className="font-medium">
            ✓ Audit pass found {critique.issue_count} issue{critique.issue_count !== 1 ? 's' : ''} in the draft pharmacology JSON — revision applied
            <span className="ml-2 rounded bg-white/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wider">{critique.severity}</span>
          </div>
          {critique.details && (
            <ul className="mt-1.5 space-y-0.5 text-xs">
              {(['missing_critical_info', 'missing_safety_signals', 'incorrect_dosing', 'unsupported_claims', 'citation_problems'] as const).map((k) => {
                const arr = (critique.details as Record<string, string[]>)[k];
                if (!Array.isArray(arr) || arr.length === 0) return null;
                return (
                  <li key={k}><span className="font-semibold">{k.replace(/_/g, ' ')}:</span> {arr.length} item{arr.length !== 1 ? 's' : ''}</li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {loading && !data && (
        <div className="mt-6 rounded-xl border bg-white p-8 text-center text-slate-400 shadow-sm">
          <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin" />
          Looking up…
        </div>
      )}

      {data && (
        <article className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <header className="border-b pb-3">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-xl font-semibold capitalize text-slate-900">{data.drug_normalized || data.normalized}</h2>
              {data.normalized && data.normalized !== data.input && (
                <span className="shrink-0 text-xs text-slate-400">from &quot;{data.input}&quot;</span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm text-slate-500">
              {data.class && <span>{data.class}</span>}
              {data.subclass && <><span className="text-slate-300">·</span><span>{data.subclass}</span></>}
            </div>
            {loading && (
              <div className="mt-2 flex items-center gap-2 rounded-md bg-sky-50 px-2 py-1 text-[11px] text-sky-800">
                <Loader2 className="h-3 w-3 animate-spin" /> Deeper pharmacology sections still loading…
              </div>
            )}
          </header>

          <div className="mt-4 space-y-5 text-sm">
            <Group title="Pharmacology">
              {data.mechanism_of_action && <PlainSection title="Mechanism of action" text={data.mechanism_of_action} />}
              {(data.receptors_targets && data.receptors_targets.length > 0) && <Section title="Molecular targets" items={data.receptors_targets} />}
              {data.biochemistry && <PlainSection title="Biochemistry" text={data.biochemistry} />}
              {data.pharmacokinetics && typeof data.pharmacokinetics === 'object' && Object.values(data.pharmacokinetics).some(Boolean) && (
                <div>
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Pharmacokinetics</h3>
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                    {(['absorption','distribution','metabolism','excretion','half_life','bioavailability','onset','duration'] as const).map((k) => {
                      const v = data.pharmacokinetics?.[k];
                      if (!v) return null;
                      return (
                        <div key={k} className="flex gap-1.5">
                          <dt className="w-24 shrink-0 text-[11px] uppercase tracking-wide text-slate-400">{k.replace('_',' ')}</dt>
                          <dd className="flex-1 text-slate-700">{asText(v)}</dd>
                        </div>
                      );
                    })}
                  </dl>
                </div>
              )}
              {data.pharmacodynamics && <PlainSection title="Pharmacodynamics" text={data.pharmacodynamics} />}
            </Group>

            <Group title="Clinical use">
              {(data.indications && data.indications.length > 0) && <Section title="Indications" items={data.indications} />}
              {(data.typical_dosing && data.typical_dosing.length > 0) && <Section title="Typical dosing" items={data.typical_dosing} />}
              {(data.formulations && data.formulations.length > 0) && <Section title="Formulations" items={data.formulations} />}
              {(data.renal_adjust || data.hepatic_adjust) && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {data.renal_adjust && <PlainSection title="Renal adjustment" text={data.renal_adjust} />}
                  {data.hepatic_adjust && <PlainSection title="Hepatic adjustment" text={data.hepatic_adjust} />}
                </div>
              )}
              {data.special_populations && typeof data.special_populations === 'object' && Object.values(data.special_populations).some(Boolean) && (
                <div>
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Special populations</h3>
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                    {(['pregnancy','pediatric','geriatric','renal_impairment','hepatic_impairment'] as const).map((k) => {
                      const v = data.special_populations?.[k];
                      if (!v) return null;
                      return (
                        <div key={k} className="flex gap-1.5">
                          <dt className="w-24 shrink-0 text-[11px] uppercase tracking-wide text-slate-400">{k.replace('_',' ')}</dt>
                          <dd className="flex-1 text-slate-700">{asText(v)}</dd>
                        </div>
                      );
                    })}
                  </dl>
                </div>
              )}
            </Group>

            <Group title="Safety">
              {(data.contraindications && data.contraindications.length > 0) && <Section title="Contraindications" items={data.contraindications} dangerous />}
              {(data.adverse_effects && data.adverse_effects.length > 0) && <Section title="Adverse effects" items={data.adverse_effects} />}
              {(data.drug_interactions_summary && data.drug_interactions_summary.length > 0) && <Section title="Notable interactions" items={data.drug_interactions_summary} />}
              {(data.monitoring && data.monitoring.length > 0) && <Section title="Monitoring" items={data.monitoring} />}
            </Group>

            {(data.key_pearls && data.key_pearls.length > 0) && (
              <Group title="Pearls">
                <Section title="" items={data.key_pearls} pearls />
              </Group>
            )}
          </div>

          {pubchemFacts && pubchemFacts.cid && (
            <section className="mt-5 rounded-xl border border-sky-200 bg-sky-50/40 p-4">
              <header className="mb-3 flex items-baseline justify-between border-b border-sky-200 pb-2">
                <div>
                  <div className="text-base font-semibold text-sky-900">Identity & Pharmacology</div>
                  <div className="text-xs text-sky-700">{pubchemFacts.canonical_name}{pubchemFacts.atc_codes.length ? ` · ATC ${pubchemFacts.atc_codes.join(', ')}` : ''}</div>
                </div>
                <span className="rounded bg-sky-100 px-2 py-0.5 text-[10px] uppercase tracking-wider text-sky-800">PubChem CID {pubchemFacts.cid}</span>
              </header>
              {pubchemFacts.mesh_pharmacological_actions.length > 0 && (
                <div className="mb-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-sky-700">MeSH pharmacological actions</div>
                  <ul className="ml-4 list-disc space-y-0.5 text-sm text-slate-700">
                    {pubchemFacts.mesh_pharmacological_actions.slice(0, 4).map((m, i) => <li key={i}>{m}</li>)}
                  </ul>
                </div>
              )}
              {pubchemFacts.synonyms.length > 1 && (
                <div className="mb-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-sky-700">Synonyms (incl. brand names)</div>
                  <div className="flex flex-wrap gap-1">
                    {pubchemFacts.synonyms.slice(0, 15).map((s, i) => (
                      <span key={i} className="rounded bg-white border border-sky-200 px-1.5 py-0.5 text-[11px] text-slate-700">{s}</span>
                    ))}
                  </div>
                </div>
              )}
              {pubchemFacts.indication && (
                <div className="mb-3 rounded border border-sky-200 bg-white p-2 text-xs italic text-slate-700">
                  <span className="font-semibold not-italic text-sky-800">Indication: </span>{pubchemFacts.indication}
                </div>
              )}
              {pubchemFacts.url && (
                <div className="flex flex-wrap gap-1.5 border-t border-sky-100 pt-2">
                  <a href={pubchemFacts.url} target="_blank" rel="noopener noreferrer"
                     className="inline-flex items-center gap-1 rounded bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-800 hover:bg-sky-200">
                    View on PubChem ↗
                  </a>
                </div>
              )}
            </section>
          )}

          {data.citations && data.citations.length > 0 && (
            <div className="mt-5 flex flex-wrap items-center gap-1.5 border-t pt-3">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Sources:</span>
              {data.citations.map((c) => (
                <button key={c.n} onClick={() => onCite(c.n)}
                  className="rounded-md bg-brand-faint px-1.5 py-0.5 text-[11px] font-semibold text-brand hover:bg-brand hover:text-white">
                  [{c.n}]
                </button>
              ))}
              <span className="ml-auto text-[11px] text-slate-400">{data.duration_ms}ms</span>
            </div>
          )}
        </article>
      )}

      {data && data.citations && <SourcesRail citations={data.citations} highlighted={highlighted} openIds={openIds} setOpenIds={setOpenIds} />}
    </div>
  );
}

function asText(it: unknown): string {
  if (typeof it === 'string') return it;
  if (it && typeof it === 'object') {
    const o = it as Record<string, unknown>;
    const name = String(o.name ?? o.title ?? o.label ?? '');
    const desc = String(o.description ?? o.detail ?? o.value ?? '');
    if (name && desc) return `${name} — ${desc}`;
    return name || desc || JSON.stringify(o);
  }
  return String(it ?? '');
}

function Section({ title, items, dangerous, pearls }: { title: string; items?: unknown[]; dangerous?: boolean; pearls?: boolean }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      {title && <h3 className={`mb-1 text-[11px] font-semibold uppercase tracking-wide ${dangerous ? 'text-rose-700' : 'text-slate-500'}`}>{title}</h3>}
      <ul className={`ml-4 list-disc space-y-1 ${pearls ? 'text-slate-800 marker:text-brand' : 'text-slate-700'}`}>{items.map((it, i) => <li key={i}>{asText(it)}</li>)}</ul>
    </div>
  );
}

function Group({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-lg border border-slate-200/70 bg-slate-50/40">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-3 py-2 text-left">
        <span className="text-[11px] font-bold uppercase tracking-wider text-brand">{title}</span>
        <span className="text-slate-400">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="space-y-3 border-t border-slate-200/70 px-3 py-3">{children}</div>}
    </section>
  );
}
function PlainSection({ title, text }: { title: string; text: unknown }) {
  return (
    <div>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      <p className="text-slate-700">{asText(text)}</p>
    </div>
  );
}

function InteractionsPanel() {
  const [drugs, setDrugs] = useState<string[]>(['', '']);
  const [data, setData] = useState<InteractionsResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [openIds, setOpenIds] = useState<Record<number, boolean>>({});
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [totalMs, setTotalMs] = useState<number | undefined>(undefined);
  const [traceId, setTraceId] = useState<string | null>(null);
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
          // Same heartbeat key — REPLACE last event in-place instead of appending.
          return [...prev.slice(0, -1), { stage, msg, ms, done, error, ts: Date.now() }];
        }
      }
      const next = prev.map((p, i) => (i === prev.length - 1 && !p.done) ? { ...p, done: true } : p);
      return [...next, { stage, msg, ms, done, error, ts: Date.now() }];
    });
  }
  const sessionId = useMemo(() => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())), []);

  const filled = drugs.filter((d) => d.trim().length > 0).length;

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const list = drugs.map((d) => d.trim()).filter(Boolean);
    if (list.length < 2) { setError('Enter at least 2 drugs'); return; }
    setError(null); setData(null); setLoading(true); setOpenIds({});
    setTrace([]); setTotalMs(undefined); setTraceId(null);
    const t0 = Date.now();
    try {
      const r = await fetch('/api/drugs/interactions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drugs: list }),
      });
      const tid = r.headers.get('x-trace-id'); if (tid) setTraceId(tid);
      if (!r.ok) { setError(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); return; }
      const dRef: { current: InteractionsResp | null } = { current: null };
      await consumeNdjson(r, (ev) => {
        if (ev.type === 'progress') pushTrace(ev.stage, ev.msg, ev.ms);
        else if (ev.type === 'result') { dRef.current = ev.data as InteractionsResp; setData(dRef.current); }
        else if (ev.type === 'done') { setTotalMs(ev.ms); pushTrace('done', '', ev.ms, true); }
        else if (ev.type === 'error') { setError(ev.message); pushTrace('done', ev.message, undefined, true, true); }
      });
      if (!dRef.current) return;
      const d = dRef.current;
      fetch('/api/log/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feature: 'drugs_interactions', query_text: list.join(' + '),
          expanded_query: (d.normalized || []).join(' + '),
          answer_text: JSON.stringify({ summary: d.summary, pair_count: d.pairs?.length }),
          citation_ids: (d.citations || []).map((c) => c.id),
          duration_ms: Date.now() - t0, session_id: sessionId,
        }),
      }).catch(() => {});
    } catch (e) { setError(String((e as Error).message)); }
    finally { setLoading(false); }
  }

  function setDrug(i: number, v: string) {
    const copy = drugs.slice(); copy[i] = v; setDrugs(copy);
  }
  function addRow() { if (drugs.length < 5) setDrugs([...drugs, '']); }
  function removeRow(i: number) { if (drugs.length > 2) setDrugs(drugs.filter((_, idx) => idx !== i)); }

  function onCite(n: number) {
    setHighlighted(n);
    setOpenIds((p) => ({ ...p, [n]: true }));
    setTimeout(() => document.getElementById(`drugs-cite-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    setTimeout(() => setHighlighted((h) => (h === n ? null : h)), 2000);
  }

  const sortedPairs = useMemo(() => {
    if (!data?.pairs) return [];
    return [...data.pairs].sort((a, b) =>
      (SEVERITY_ORDER[a.severity ?? 'none'] ?? 5) - (SEVERITY_ORDER[b.severity ?? 'none'] ?? 5)
    );
  }, [data]);

  return (
    <div>
      <form onSubmit={submit} className="space-y-2">
        {drugs.map((d, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-400">{i + 1}.</span>
            <input
              value={d}
              onChange={(e) => setDrug(i, e.target.value)}
              placeholder={i === 0 ? 'warfarin' : i === 1 ? 'amiodarone' : 'add drug'}
              className="flex-1 rounded-lg border border-slate-300 bg-white p-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
            {drugs.length > 2 && (
              <button type="button" onClick={() => removeRow(i)}
                className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-rose-500">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
        <div className="flex items-center justify-between pt-1">
          <button type="button" onClick={addRow} disabled={drugs.length >= 5}
            className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:border-brand hover:text-brand disabled:opacity-40">
            <Plus className="h-3 w-3" /> Add drug
          </button>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400">{filled}/5 filled</span>
            <button type="submit" disabled={loading || filled < 2}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white shadow disabled:bg-slate-300">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
              {loading ? 'Checking…' : 'Check interactions'}
            </button>
          </div>
        </div>
      </form>

      {(trace.length > 0 || loading) && <div className="mt-5"><TracePanel events={trace} totalMs={totalMs} traceId={traceId} surface="drugs-interactions" /></div>}
      {error && <div className="mt-6 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div>}

      {loading && (
        <div className="mt-6 rounded-xl border bg-white p-8 text-center text-slate-400 shadow-sm">
          <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin" />
          Checking pairs across the corpus…
        </div>
      )}

      {data && !loading && (
        <div className="mt-6 space-y-4">
          {data.class_overlap_pairs && data.class_overlap_pairs.length > 0 && (
            <div className="rounded-xl border border-sky-200 bg-sky-50 p-4">
              <div className="flex items-baseline justify-between border-b border-sky-200 pb-2">
                <h2 className="text-sm font-semibold text-sky-900">Pharmacological class overlap (from PubChem ATC)</h2>
                <span className="text-[10px] uppercase tracking-wider text-sky-700">Deterministic safety net</span>
              </div>
              <div className="mt-2 space-y-1.5">
                {data.class_overlap_pairs.map((cop, i) => (
                  <div key={i} className="flex flex-wrap items-baseline gap-2 text-sm">
                    <span className="font-medium text-sky-900 capitalize">{cop.a}</span>
                    <span className="text-sky-400">↔</span>
                    <span className="font-medium text-sky-900 capitalize">{cop.b}</span>
                    <span className="text-sky-600">shared class:</span>
                    {cop.shared_labels.map((l, j) => (
                      <span key={j} className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] font-semibold text-sky-900">{l}</span>
                    ))}
                  </div>
                ))}
              </div>
              <div className="mt-2 text-[11px] italic text-sky-700">Class overlap means cumulative pharmacodynamic risk even if no specific pairwise interaction is listed below.</div>
            </div>
          )}
          {data.summary && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Summary</h2>
              <p className="mt-1 text-sm leading-relaxed text-slate-800">{data.summary}</p>
            </div>
          )}
          <div className="space-y-2">
            {sortedPairs.map((p, i) => (
              <article key={i} className={`rounded-xl border shadow-sm ${SEVERITY_STYLE[p.severity ?? 'none'] ?? SEVERITY_STYLE.none}`}>
                <header className="flex flex-wrap items-center gap-2 border-b border-current/10 px-4 py-2.5">
                  {(p.severity === 'contraindicated' || p.severity === 'major') && (
                    <AlertTriangle className="h-4 w-4 text-rose-600" />
                  )}
                  <span className="font-semibold capitalize text-slate-900">{p.drug_a}</span>
                  <span className="text-slate-400">+</span>
                  <span className="font-semibold capitalize text-slate-900">{p.drug_b}</span>
                  <span className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${SEVERITY_PILL[p.severity ?? 'none'] ?? SEVERITY_PILL.none}`}>
                    {p.severity ?? 'none'}
                  </span>
                </header>
                <div className="space-y-2 px-4 py-3 text-sm">
                  {p.mechanism && <Row label="Mechanism" text={p.mechanism} />}
                  {p.consequence && <Row label="Consequence" text={p.consequence} />}
                  {p.management && <Row label="Management" text={p.management} />}
                  {p.citation_ids && p.citation_ids.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Sources:</span>
                      {p.citation_ids.map((n) => (
                        <button key={n} onClick={() => onCite(n)}
                          className="rounded-md bg-brand-faint px-1.5 py-0.5 text-[11px] font-semibold text-brand hover:bg-brand hover:text-white">
                          [{n}]
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      {data && data.citations && <SourcesRail citations={data.citations} highlighted={highlighted} openIds={openIds} setOpenIds={setOpenIds} />}
    </div>
  );
}

function Row({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-28 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <span className="text-slate-800">{text}</span>
    </div>
  );
}

export default function DrugsClient() {
  const [tab, setTab] = useState<'lookup' | 'interactions'>('lookup');
  return (
    <div>
      <div className="mb-5 flex gap-1 rounded-lg bg-slate-100 p-1">
        <button
          onClick={() => setTab('lookup')}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition ${
            tab === 'lookup' ? 'bg-white text-brand shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Pill className="h-4 w-4" /> Lookup
        </button>
        <button
          onClick={() => setTab('interactions')}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition ${
            tab === 'interactions' ? 'bg-white text-brand shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Activity className="h-4 w-4" /> Interactions
        </button>
      </div>
      <ErrorBoundary label={tab === 'lookup' ? 'Drug Lookup' : 'Drug Interactions'}>
        {tab === 'lookup' ? <LookupPanel /> : <InteractionsPanel />}
      </ErrorBoundary>
    </div>
  );
}
