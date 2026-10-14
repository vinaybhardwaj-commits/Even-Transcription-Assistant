'use client';

import { useState, useRef } from 'react';
import Link from 'next/link';
import { Beaker, Stethoscope, ListChecks, AlertOctagon, GraduationCap, ArrowRightCircle, Scale, Droplet } from 'lucide-react';
import { consumeNdjson } from '@/lib/ndjson-client';

type VolumeStatus = 'hypovolemic' | 'euvolemic' | 'hypervolemic' | 'unsure';
type MedFlag = 'thiazide' | 'ssri' | 'carbamazepine' | 'mdma' | 'nsaid' | 'ace_arb' | 'ppi' | 'desmopressin';

const MED_OPTIONS: Array<{ value: MedFlag; label: string }> = [
  { value: 'thiazide',      label: 'Thiazide diuretic' },
  { value: 'ssri',          label: 'SSRI' },
  { value: 'carbamazepine', label: 'Carbamazepine' },
  { value: 'mdma',          label: 'MDMA / amphetamine' },
  { value: 'nsaid',         label: 'NSAID' },
  { value: 'ace_arb',       label: 'ACE-I / ARB' },
  { value: 'ppi',           label: 'PPI' },
  { value: 'desmopressin',  label: 'Desmopressin' },
];

type Section = {
  section: string;
  text?: string;
  tonicity?: string;
  volume_status?: string;
  pseudohyponatremia_flag?: boolean;
  ods_risk?: boolean;
  ods_risk_factors_present?: string[];
  ceiling_24h_meq_l?: number;
  ods_ceiling_24h_meq_l?: number;
  fluid_type_indicated?: string;
  items?: Array<{ name?: string; likelihood?: string; key_discriminator?: string; test?: string; rationale?: string }>;
  citations?: Array<{ chunk_id: number }>;
};

type Deterministic = {
  corrected_na: number;
  pseudohyponatremia_flag: boolean;
  tonicity: string;
  serum_osm_estimated: number | null;
  volume_status: string;
  free_water_deficit_l: number | null;
  ods_risk: boolean;
  ods_risk_factors: string[];
  correction_ceiling_24h_meq_l: number;
  ods_ceiling_24h_meq_l: number;
  severity_label: string;
};

type Source = { n: number; id: number; book: string; chapter?: string; page_start?: number; similarity: number };

const SECTION_LABEL: Record<string, { title: string; Icon: typeof Beaker }> = {
  classification:           { title: 'Classification',         Icon: Stethoscope },
  severity_acuity:          { title: 'Severity & ODS risk',    Icon: AlertOctagon },
  correction_rate_guidance: { title: 'Correction-rate guidance', Icon: Scale },
  differential:             { title: 'Differential',           Icon: ListChecks },
  next_workup:              { title: 'Next workup',            Icon: ArrowRightCircle },
  discriminating_signs:     { title: 'Discriminating signs',   Icon: Droplet },
};
const SECTION_ORDER = ['classification', 'severity_acuity', 'correction_rate_guidance', 'differential', 'next_workup', 'discriminating_signs'];
const LIKELIHOOD_COLOR: Record<string, string> = { high: 'bg-red-100 text-red-700', medium: 'bg-amber-100 text-amber-700', low: 'bg-slate-100 text-slate-600' };

export default function HyponatremiaCalculator() {
  // Form state
  const [na, setNa] = useState<string>('');
  const [serumOsm, setSerumOsm] = useState<string>('');
  const [glucose, setGlucose] = useState<string>('');
  const [urineNa, setUrineNa] = useState<string>('');
  const [urineOsm, setUrineOsm] = useState<string>('');
  const [volumeStatus, setVolumeStatus] = useState<VolumeStatus>('unsure');
  const [meds, setMeds] = useState<MedFlag[]>([]);
  const [recentIvf, setRecentIvf] = useState(false);
  const [tsh, setTsh] = useState<string>('');
  const [cortisol, setCortisol] = useState<string>('');
  const [suspectAdrenal, setSuspectAdrenal] = useState(false);
  const [k, setK] = useState<string>('');
  const [weight, setWeight] = useState<string>('');
  const [sex, setSex] = useState<'F' | 'M' | ''>('');

  // Result state
  const [submitting, setSubmitting] = useState(false);
  const [deterministic, setDeterministic] = useState<Deterministic | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [streamingMsg, setStreamingMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const elapsedRef = useRef<NodeJS.Timeout | null>(null);

  function toggleMed(m: MedFlag) {
    setMeds((prev) => prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]);
  }

  function loadSiadhSample() {
    setNa('128'); setSerumOsm('268'); setGlucose('105');
    setUrineNa('45'); setUrineOsm('380');
    setVolumeStatus('euvolemic'); setMeds(['ssri']); setRecentIvf(false);
    setTsh('2.1'); setCortisol('18');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    setDeterministic(null); setSections([]); setSources([]); setTraceId(null);
    setElapsed(0);
    if (elapsedRef.current) clearInterval(elapsedRef.current);
    const t0 = Date.now();
    elapsedRef.current = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);

    const body: Record<string, unknown> = {
      na: Number(na),
      glucose: Number(glucose),
      volume_status: volumeStatus,
      meds,
      recent_ivf: recentIvf,
    };
    if (serumOsm) body.serum_osm = Number(serumOsm);
    if (urineNa) body.urine_na = Number(urineNa);
    if (urineOsm) body.urine_osm = Number(urineOsm);
    if (tsh) body.tsh = Number(tsh);
    if (cortisol) body.cortisol = Number(cortisol);
    if (suspectAdrenal) body.suspect_adrenal_insuff = true;
    if (k) body.k = Number(k);
    if (weight) body.weight_kg = Number(weight);
    if (sex) body.sex = sex;

    try {
      const r = await fetch('/api/calculators/hyponatremia', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
        if (ev.type === 'progress') setStreamingMsg(ev.msg);
        else if (ev.type === 'sources') setSources(ev.items as Source[]);
        else if (ev.type === 'result') {
          const d = ev.data as { phase: string } & Record<string, unknown>;
          if (d.phase === 'deterministic') setDeterministic(d.deterministic as Deterministic);
          else if (d.phase === 'section') {
            const sec = d as unknown as Section;
            setSections((prev) => {
              const i = prev.findIndex((s) => s.section === sec.section);
              if (i >= 0) { const next = [...prev]; next[i] = sec; return next; }
              return [...prev, sec];
            });
          }
        } else if (ev.type === 'error') setError(ev.message);
      });
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setSubmitting(false);
      setStreamingMsg(null);
      if (elapsedRef.current) clearInterval(elapsedRef.current);
    }
  }

  const sortedSections = [...sections].sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Hyponatremia workup synthesizer</h1>
        <p className="mt-1 text-sm text-slate-500">
          Deterministic math (Katz/Hillier glucose correction, tonicity, FW excess, ODS-risk ceiling) + qwen 14b synthesis grounded in MKSAP/StatPearls/UpToDate.
        </p>
      </header>

      {!deterministic && (
        <form onSubmit={submit} className="space-y-5">
          {/* Required + chemistry */}
          <fieldset className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
            <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">Chemistry</legend>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <label className="space-y-1 text-xs"><span className="font-medium text-slate-700">Na (mEq/L) *</span>
                <input type="number" inputMode="decimal" required min={100} max={180} value={na} onChange={(e) => setNa(e.target.value)} className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"/></label>
              <label className="space-y-1 text-xs"><span className="font-medium text-slate-700">Serum osm</span>
                <input type="number" inputMode="decimal" min={200} max={400} value={serumOsm} onChange={(e) => setSerumOsm(e.target.value)} className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"/></label>
              <label className="space-y-1 text-xs"><span className="font-medium text-slate-700">Glucose (mg/dL) *</span>
                <input type="number" inputMode="decimal" required min={20} max={1500} value={glucose} onChange={(e) => setGlucose(e.target.value)} className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"/></label>
              <label className="space-y-1 text-xs"><span className="font-medium text-slate-700">K (mEq/L)</span>
                <input type="number" inputMode="decimal" min={1.5} max={8.5} value={k} onChange={(e) => setK(e.target.value)} className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"/></label>
              <label className="space-y-1 text-xs"><span className="font-medium text-slate-700">Urine Na</span>
                <input type="number" inputMode="decimal" min={5} max={300} value={urineNa} onChange={(e) => setUrineNa(e.target.value)} className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"/></label>
              <label className="space-y-1 text-xs"><span className="font-medium text-slate-700">Urine osm</span>
                <input type="number" inputMode="decimal" min={20} max={1500} value={urineOsm} onChange={(e) => setUrineOsm(e.target.value)} className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"/></label>
              <label className="space-y-1 text-xs"><span className="font-medium text-slate-700">TSH (mIU/L)</span>
                <input type="number" inputMode="decimal" min={0.01} max={100} value={tsh} onChange={(e) => setTsh(e.target.value)} className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"/></label>
              <label className="space-y-1 text-xs"><span className="font-medium text-slate-700">AM cortisol (µg/dL)</span>
                <input type="number" inputMode="decimal" min={0.5} max={80} value={cortisol} onChange={(e) => setCortisol(e.target.value)} className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"/></label>
            </div>
          </fieldset>

          {/* Clinical */}
          <fieldset className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
            <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">Clinical</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs"><span className="font-medium text-slate-700">Volume status *</span>
                <select required value={volumeStatus} onChange={(e) => setVolumeStatus(e.target.value as VolumeStatus)} className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand">
                  <option value="unsure">Unsure / re-assess</option>
                  <option value="hypovolemic">Hypovolemic (dry MM, ↓BP, ↑HR)</option>
                  <option value="euvolemic">Euvolemic (no edema, normal MM/JVD)</option>
                  <option value="hypervolemic">Hypervolemic (edema, ↑JVD, S3)</option>
                </select>
              </label>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <label className="space-y-1"><span className="font-medium text-slate-700">Weight (kg)</span>
                  <input type="number" inputMode="decimal" min={25} max={300} value={weight} onChange={(e) => setWeight(e.target.value)} className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"/></label>
                <label className="space-y-1"><span className="font-medium text-slate-700">Sex</span>
                  <select value={sex} onChange={(e) => setSex(e.target.value as 'F' | 'M' | '')} className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand">
                    <option value="">—</option><option value="F">F</option><option value="M">M</option>
                  </select></label>
                <div className="space-y-1"><span className="block font-medium text-slate-700">Other</span>
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={recentIvf} onChange={(e) => setRecentIvf(e.target.checked)} className="rounded"/><span>Recent IVF</span></label>
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={suspectAdrenal} onChange={(e) => setSuspectAdrenal(e.target.checked)} className="rounded"/><span>Susp. adrenal insuff.</span></label>
                </div>
              </div>
            </div>
            <div>
              <span className="block text-xs font-medium text-slate-700">Current medications (tick all that apply)</span>
              <div className="mt-1 flex flex-wrap gap-2">
                {MED_OPTIONS.map((m) => (
                  <label key={m.value} className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs cursor-pointer transition ${meds.includes(m.value) ? 'border-brand bg-brand-faint text-brand' : 'border-slate-200 hover:border-brand'}`}>
                    <input type="checkbox" checked={meds.includes(m.value)} onChange={() => toggleMed(m.value)} className="sr-only"/>
                    <span>{m.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </fieldset>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3">
            <button type="button" onClick={loadSiadhSample} className="text-xs text-brand hover:underline">Try with example (classic SIADH) →</button>
            <button type="submit" disabled={submitting} className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand/90 disabled:opacity-50">
              {submitting ? 'Synthesizing…' : 'Interpret panel'}
            </button>
          </div>
          {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
        </form>
      )}

      {deterministic && (
        <div className="space-y-5">
          {/* Deterministic banner */}
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
              <span className="text-2xl font-bold text-slate-900">{deterministic.tonicity}</span>
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{deterministic.volume_status}</span>
              {deterministic.pseudohyponatremia_flag && (
                <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">PSEUDO — not true hypoNa</span>
              )}
              {deterministic.ods_risk && (
                <span className="rounded-md bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">ODS risk</span>
              )}
              <span className="ml-auto text-xs text-slate-500">corrected Na {deterministic.corrected_na} · {deterministic.severity_label}</span>
            </div>
            {deterministic.free_water_deficit_l !== null && (
              <div className="mt-2 text-xs text-slate-500">Free water excess estimate: <span className="font-medium text-slate-700">{deterministic.free_water_deficit_l} L</span></div>
            )}
            <div className="mt-1 text-xs text-slate-500">Safe correction ceiling 24 h: <span className="font-medium text-slate-700">{deterministic.correction_ceiling_24h_meq_l} mEq/L</span> (≤{deterministic.ods_ceiling_24h_meq_l} if ODS risk)</div>
          </div>

          {streamingMsg && (
            <div className="rounded-md border border-brand/30 bg-brand-faint/50 px-3 py-2 text-xs text-brand">
              {streamingMsg} {elapsed > 0 && <span className="text-brand/70">({elapsed}s)</span>}
            </div>
          )}

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
                    {sec.citations && sec.citations.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {sec.citations.map((c, i) => (<span key={i} className="rounded bg-brand-faint px-1.5 py-0.5 text-[10px] text-brand">[{c.chunk_id}]</span>))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="h-12 rounded bg-slate-100" aria-busy="true" />
                )}
              </div>
            );
          })}

          {sources.length > 0 && (
            <details className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <summary className="cursor-pointer text-xs font-medium text-slate-600">Sources ({sources.length})</summary>
              <ul className="mt-2 space-y-1.5">
                {sources.slice(0, 12).map((s) => (
                  <li key={s.id} className="text-xs text-slate-600">
                    <span className="text-slate-400">[{s.id}]</span> <span className="font-medium">{s.book}</span>
                    {s.chapter && <span> · {s.chapter}</span>}{s.page_start && <span> · p.{s.page_start}</span>}
                    <span className="text-slate-400"> · sim {s.similarity}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            <Link href={`/coach?topic=${encodeURIComponent('hyponatremia workup ' + deterministic.tonicity)}`} className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand hover:text-brand">
              <GraduationCap className="h-4 w-4" /> Coach me on hyponatremia workup
            </Link>
            <Link href={`/ask?q=${encodeURIComponent('Explain my hyponatremia interpretation: ' + deterministic.tonicity + ' ' + deterministic.volume_status)}`} className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand hover:text-brand">
              Ask: explain further
            </Link>
            <button type="button" onClick={() => { setDeterministic(null); setSections([]); setSources([]); setTraceId(null); }} className="ml-auto text-sm text-slate-500 hover:text-slate-700">← New panel</button>
          </div>

          {traceId && <div className="text-xs text-slate-400">Trace: <code className="rounded bg-slate-100 px-1.5 py-0.5">{traceId}</code></div>}
        </div>
      )}
    </div>
  );
}
