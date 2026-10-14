'use client';

import { useState, useRef } from 'react';
import Link from 'next/link';
import { Activity, Beaker, Stethoscope, ListChecks, AlertOctagon, GraduationCap, ArrowRightCircle } from 'lucide-react';
import { consumeNdjson } from '@/lib/ndjson-client';

// Field config
type FieldKey = 'pH' | 'paco2' | 'hco3' | 'pao2' | 'fio2' | 'na' | 'cl' | 'albumin' | 'lactate' | 'k';
type Field = { key: FieldKey; label: string; unit: string; required: boolean; min: number; max: number; step: string; help: string };

const FIELDS: Field[] = [
  { key: 'pH',      label: 'pH',        unit: '',       required: true,  min: 6.8, max: 7.8, step: '0.01', help: 'Normal 7.35-7.45.' },
  { key: 'paco2',   label: 'PaCO2',     unit: 'mmHg',   required: true,  min: 10,  max: 100, step: '0.1',  help: 'Normal 35-45.' },
  { key: 'hco3',    label: 'HCO3',      unit: 'mEq/L',  required: true,  min: 4,   max: 50,  step: '0.1',  help: 'Normal 22-26.' },
  { key: 'na',      label: 'Na',        unit: 'mEq/L',  required: false, min: 100, max: 180, step: '1',    help: 'Required for AG.' },
  { key: 'cl',      label: 'Cl',        unit: 'mEq/L',  required: false, min: 70,  max: 130, step: '1',    help: 'Required for AG.' },
  { key: 'albumin', label: 'Albumin',   unit: 'g/dL',   required: false, min: 0.5, max: 6,   step: '0.1',  help: 'Corrects AG if <4.0.' },
  { key: 'pao2',    label: 'PaO2',      unit: 'mmHg',   required: false, min: 30,  max: 600, step: '1',    help: 'For P/F + A-a.' },
  { key: 'fio2',    label: 'FiO2',      unit: '',       required: false, min: 0.21, max: 1.0, step: '0.01', help: '0.21 = room air; 1.0 = 100% O2.' },
  { key: 'lactate', label: 'Lactate',   unit: 'mmol/L', required: false, min: 0.2, max: 25,  step: '0.1',  help: '>4 = sepsis red flag.' },
  { key: 'k',       label: 'K',         unit: 'mEq/L',  required: false, min: 1.5, max: 8.5, step: '0.1',  help: 'Narrows differential.' },
];

type Section = {
  section: string;
  text?: string;
  expected_range?: string;
  ag_value?: number;
  corrected_ag?: number;
  delta_delta?: number;
  items?: Array<{ name?: string; likelihood?: string; key_discriminator?: string; test?: string; rationale?: string }>;
  citations?: Array<{ chunk_id: number }>;
};

type Deterministic = {
  primary_disorder_label: string;
  compensation: { verdict: string; expected_range: string; measured: number | null; formula: string | null };
  anion_gap: { state: string; ag_value: number | null; corrected_ag: number | null; albumin_correction_applied: boolean };
  delta_delta: { ratio: number | null; interpretation: string | null };
  oxygenation: { pf_ratio: number | null; pf_band: string | null; aa_gradient: number | null };
};

type Source = { n: number; id: number; book: string; chapter?: string; page_start?: number; similarity: number; preview: string };

const SECTION_LABEL: Record<string, { title: string; Icon: typeof Activity }> = {
  primary_disorder: { title: 'Primary disorder',  Icon: Stethoscope },
  compensation:     { title: 'Compensation',      Icon: Activity },
  anion_gap:        { title: 'Anion gap',         Icon: Beaker },
  differential:     { title: 'Differential',      Icon: ListChecks },
  next_workup:      { title: 'Next workup',       Icon: ArrowRightCircle },
  red_flags:        { title: 'Red flags',         Icon: AlertOctagon },
};
const SECTION_ORDER = ['primary_disorder', 'compensation', 'anion_gap', 'differential', 'next_workup', 'red_flags'];

const LIKELIHOOD_COLOR: Record<string, string> = {
  high:   'bg-red-100 text-red-700',
  medium: 'bg-amber-100 text-amber-700',
  low:    'bg-slate-100 text-slate-600',
};

export default function AbgCalculator() {
  const [values, setValues] = useState<Partial<Record<FieldKey, number>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [deterministic, setDeterministic] = useState<Deterministic | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [streamingMsg, setStreamingMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const elapsedRef = useRef<NodeJS.Timeout | null>(null);
  const [elapsed, setElapsed] = useState(0);

  function setField(k: FieldKey, v: string) {
    if (v === '') setValues((prev) => { const n = { ...prev }; delete n[k]; return n; });
    else setValues((prev) => ({ ...prev, [k]: Number(v) }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    setDeterministic(null);
    setSections([]);
    setSources([]);
    setTraceId(null);
    setElapsed(0);
    if (elapsedRef.current) clearInterval(elapsedRef.current);
    const t0 = Date.now();
    elapsedRef.current = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);

    try {
      const r = await fetch('/api/calculators/abg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const tid = r.headers.get('x-trace-id'); if (tid) setTraceId(tid);
      if (!r.ok) {
        const t = await r.text();
        setError(`HTTP ${r.status}: ${t.slice(0, 200)}`);
        setSubmitting(false);
        if (elapsedRef.current) clearInterval(elapsedRef.current);
        return;
      }

      await consumeNdjson(r, (ev) => {
        if (ev.type === 'progress') {
          setStreamingMsg(ev.msg);
        } else if (ev.type === 'sources') {
          setSources(ev.items as Source[]);
        } else if (ev.type === 'result') {
          const d = ev.data as { phase: string } & Record<string, unknown>;
          if (d.phase === 'deterministic') {
            setDeterministic(d.deterministic as Deterministic);
          } else if (d.phase === 'section') {
            const sec = d as unknown as Section;
            setSections((prev) => {
              const existing = prev.findIndex((s) => s.section === sec.section);
              if (existing >= 0) {
                const next = [...prev];
                next[existing] = sec;
                return next;
              }
              return [...prev, sec];
            });
          }
        } else if (ev.type === 'error') {
          setError(ev.message);
        }
      });
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setSubmitting(false);
      setStreamingMsg(null);
      if (elapsedRef.current) clearInterval(elapsedRef.current);
    }
  }

  function loadSample() {
    setValues({ pH: 7.21, paco2: 22, hco3: 9, na: 138, cl: 96, albumin: 4.0 });
  }

  const sortedSections = [...sections].sort((a, b) =>
    SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section),
  );

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">ABG / acid-base interpreter</h1>
        <p className="mt-1 text-sm text-slate-500">
          Deterministic math (Winters', AG, delta-delta, P/F, A-a) + qwen 14b synthesis grounded in MKSAP/StatPearls/UpToDate.
        </p>
      </header>

      {!deterministic && (
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {FIELDS.map((f) => (
              <div key={f.key} className="space-y-1">
                <label className="block text-xs font-medium text-slate-700">
                  {f.label} {f.unit && <span className="text-slate-400">({f.unit})</span>}
                  {f.required && <span className="text-red-500"> *</span>}
                </label>
                <input
                  type="number"
                  inputMode="decimal"
                  step={f.step}
                  min={f.min}
                  max={f.max}
                  value={values[f.key] ?? ''}
                  onChange={(e) => setField(f.key, e.target.value)}
                  required={f.required}
                  className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
                <div className="text-[10px] text-slate-400">{f.help}</div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3">
            <button type="button" onClick={loadSample} className="text-xs text-brand hover:underline">
              Try with example (high-AG met acid) →
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand/90 disabled:opacity-50"
            >
              {submitting ? 'Synthesizing…' : 'Interpret ABG'}
            </button>
          </div>
          {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
        </form>
      )}

      {deterministic && (
        <div className="space-y-5">
          {/* Deterministic banner */}
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-2 flex flex-wrap items-baseline gap-2">
              <span className="text-lg font-semibold text-slate-900">{deterministic.primary_disorder_label}</span>
              {deterministic.anion_gap.state === 'high' && (
                <span className="rounded-md bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">AG {deterministic.anion_gap.albumin_correction_applied ? deterministic.anion_gap.corrected_ag : deterministic.anion_gap.ag_value} (high)</span>
              )}
              {deterministic.delta_delta.ratio !== null && (
                <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-600">Δ-Δ {deterministic.delta_delta.ratio}</span>
              )}
              {deterministic.oxygenation.pf_band && (
                <span className={`rounded-md px-2 py-0.5 text-xs ${deterministic.oxygenation.pf_band === 'severe' ? 'bg-red-100 text-red-700' : deterministic.oxygenation.pf_band === 'moderate' ? 'bg-orange-100 text-orange-700' : deterministic.oxygenation.pf_band === 'mild' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                  P/F {deterministic.oxygenation.pf_ratio} ({deterministic.oxygenation.pf_band})
                </span>
              )}
            </div>
            {deterministic.compensation.formula && (
              <div className="text-xs text-slate-500">{deterministic.compensation.formula} → expected {deterministic.compensation.expected_range}; measured {deterministic.compensation.measured} → <span className={deterministic.compensation.verdict === 'appropriate' ? 'text-emerald-700' : 'text-amber-700'}>{deterministic.compensation.verdict.replace(/_/g, ' ')}</span></div>
            )}
          </div>

          {/* Streaming msg */}
          {streamingMsg && (
            <div className="rounded-md border border-brand/30 bg-brand-faint/50 px-3 py-2 text-xs text-brand">
              {streamingMsg} {elapsed > 0 && <span className="text-brand/70">({elapsed}s)</span>}
            </div>
          )}

          {/* Sections — render in fixed order; skeleton for not-yet-arrived */}
          {SECTION_ORDER.map((key) => {
            const sec = sortedSections.find((s) => s.section === key);
            const { title, Icon } = SECTION_LABEL[key];
            return (
              <div key={key} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-2 flex items-center gap-2">
                  <Icon className="h-4 w-4 text-brand" />
                  <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
                  {!sec && submitting && <span className="text-xs text-slate-400 animate-pulse">waiting…</span>}
                </div>
                {sec ? (
                  <>
                    <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{sec.text}</div>
                    {sec.items && sec.items.length > 0 && (
                      <ul className="mt-3 space-y-2">
                        {sec.items.map((it, i) => (
                          <li key={i} className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-sm">
                            {it.name && <div className="flex items-baseline gap-2"><span className="font-medium text-slate-800">{it.name}</span>{it.likelihood && <span className={`rounded px-1.5 text-[10px] uppercase ${LIKELIHOOD_COLOR[it.likelihood] ?? ''}`}>{it.likelihood}</span>}</div>}
                            {it.test && <div className="font-medium text-slate-800">{it.test}</div>}
                            {it.key_discriminator && <div className="text-xs text-slate-600 mt-0.5">{it.key_discriminator}</div>}
                            {it.rationale && <div className="text-xs text-slate-600 mt-0.5">{it.rationale}</div>}
                          </li>
                        ))}
                      </ul>
                    )}
                    {sec.items && sec.items.length === 0 && key === 'differential' && (
                      <div className="text-xs italic text-slate-500">No etiology to differentiate; verify clinical context if disorder suspected on other grounds.</div>
                    )}
                    {sec.citations && sec.citations.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {sec.citations.map((c, i) => (
                          <span key={i} className="rounded bg-brand-faint px-1.5 py-0.5 text-[10px] text-brand">[{c.chunk_id}]</span>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="h-12 rounded bg-slate-100" aria-busy="true" />
                )}
              </div>
            );
          })}

          {/* Sources panel */}
          {sources.length > 0 && (
            <details className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <summary className="cursor-pointer text-xs font-medium text-slate-600">Sources ({sources.length})</summary>
              <ul className="mt-2 space-y-1.5">
                {sources.slice(0, 12).map((s) => (
                  <li key={s.id} className="text-xs text-slate-600">
                    <span className="text-slate-400">[{s.id}]</span>{' '}
                    <span className="font-medium">{s.book}</span>
                    {s.chapter && <span> · {s.chapter}</span>}
                    {s.page_start && <span> · p.{s.page_start}</span>}
                    <span className="text-slate-400"> · sim {s.similarity}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-2">
            <Link
              href={`/coach?topic=${encodeURIComponent(deterministic.primary_disorder_label)}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand hover:text-brand"
            >
              <GraduationCap className="h-4 w-4" /> Coach me on {deterministic.primary_disorder_label.toLowerCase()}
            </Link>
            <Link
              href={`/ask?q=${encodeURIComponent('Explain my ABG interpretation in more detail: ' + deterministic.primary_disorder_label)}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand hover:text-brand"
            >
              Ask: explain further
            </Link>
            <button
              type="button"
              onClick={() => { setDeterministic(null); setSections([]); setSources([]); setTraceId(null); }}
              className="ml-auto text-sm text-slate-500 hover:text-slate-700"
            >
              ← New ABG
            </button>
          </div>

          {traceId && (
            <div className="text-xs text-slate-400">
              Trace: <code className="rounded bg-slate-100 px-1.5 py-0.5">{traceId}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
