'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Clock, CheckCircle2, AlertTriangle, XCircle, Timer, BookOpen, GraduationCap, ChevronDown } from 'lucide-react';

type ElementStatus = 'green' | 'amber' | 'red' | 'overdue';
type BundleElement = {
  key: 'lactate' | 'cultures' | 'abx' | 'fluids' | 'vasopressors';
  label: string;
  complete: boolean;
  required: boolean;
  status: ElementStatus;
  why_matters: string;
};
type Banner = { tone: 'amber' | 'red'; text: string; cta?: { label: string; href: string } };
type BundleResult = {
  elapsed_min: number;
  remaining_min: number;
  recognition_iso: string;
  elements: BundleElement[];
  compliance_pct: number;
  required_count: number;
  complete_required_count: number;
  bundle_complete: boolean;
  banner: Banner | null;
  qsofa: number | null;
  sofa: number | null;
};

const ELEMENT_ICON: Record<ElementStatus, typeof CheckCircle2> = {
  green: CheckCircle2, amber: AlertTriangle, red: XCircle, overdue: Timer,
};
const ELEMENT_COLOR: Record<ElementStatus, string> = {
  green:   'border-emerald-300 bg-emerald-50 text-emerald-700',
  amber:   'border-amber-300 bg-amber-50 text-amber-700',
  red:     'border-red-300 bg-red-50 text-red-700',
  overdue: 'border-red-400 bg-red-100 text-red-800',
};

const BACKDATE_PRESETS = [
  { label: 'Now',  minutes: 0 },
  { label: '−5m',  minutes: 5 },
  { label: '−15m', minutes: 15 },
  { label: '−30m', minutes: 30 },
  { label: '−45m', minutes: 45 },
  { label: '−1h',  minutes: 60 },
];

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60000).toISOString();
}
function formatLocalTime(iso: string): string {
  try { return new Date(iso).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }); }
  catch { return iso; }
}

export default function SepsisBundleCalculator() {
  // Inputs
  const [recognitionTime, setRecognitionTime] = useState<string>(() => isoMinutesAgo(0));
  const [weight, setWeight] = useState<string>('');
  const [lactateDone, setLactateDone] = useState(false);
  const [lactateValue, setLactateValue] = useState<string>('');
  const [culturesDone, setCulturesDone] = useState(false);
  const [abxGiven, setAbxGiven] = useState(false);
  const [hypoOrHighLac, setHypoOrHighLac] = useState(false);
  const [fluidsDone, setFluidsDone] = useState(false);
  const [fluidVolumeMl, setFluidVolumeMl] = useState<string>('');
  const [vasopressorsStarted, setVasopressorsStarted] = useState(false);

  // Result
  const [result, setResult] = useState<BundleResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [traceId, setTraceId] = useState<string | null>(null);

  // Live countdown — re-fetches every 30s while a bundle is active
  const liveRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (!result || result.bundle_complete) {
      if (liveRef.current) { clearInterval(liveRef.current); liveRef.current = null; }
      return;
    }
    liveRef.current = setInterval(() => submit(), 30_000);
    return () => { if (liveRef.current) clearInterval(liveRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.recognition_iso, result?.bundle_complete]);

  // Sidebar state
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarContent, setSidebarContent] = useState<string | null>(null);
  const [sidebarLoading, setSidebarLoading] = useState(false);
  const [sidebarCached, setSidebarCached] = useState(false);

  function applyBackdate(minutes: number) {
    setRecognitionTime(isoMinutesAgo(minutes));
  }

  async function submit() {
    setError(null);
    const isFirst = !result;
    if (isFirst) setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        recognition_time: recognitionTime,
        lactate_done: lactateDone,
        cultures_done: culturesDone,
        abx_given: abxGiven,
        hypotension_or_lactate_high: hypoOrHighLac,
        fluids_done: fluidsDone,
        vasopressors_started: vasopressorsStarted,
      };
      if (weight) body.weight_kg = Number(weight);
      if (lactateValue) body.lactate_value = Number(lactateValue);
      if (fluidVolumeMl) body.fluid_volume_ml = Number(fluidVolumeMl);

      const r = await fetch('/api/calculators/sepsis-bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const tid = r.headers.get('x-trace-id'); if (tid) setTraceId(tid);
      const data = await r.json();
      if (!r.ok) { setError(data?.error ?? `HTTP ${r.status}`); return; }
      setResult(data.deterministic as BundleResult);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      if (isFirst) setSubmitting(false);
    }
  }

  async function loadSidebar() {
    if (sidebarContent) { setSidebarOpen((o) => !o); return; }
    setSidebarLoading(true);
    setSidebarOpen(true);
    try {
      const r = await fetch('/api/calculators/sepsis-bundle/sidebar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 1,
          parent_trace_id: traceId,
          bundle_state: result ? {
            elapsed_min: result.elapsed_min,
            compliance_pct: result.compliance_pct,
            missing: result.elements.filter((e) => e.required && !e.complete).map((e) => e.key),
          } : undefined,
        }),
      });
      const data = await r.json();
      setSidebarContent(data?.content ?? '');
      setSidebarCached(!!data?.cached);
    } catch (e) {
      setSidebarContent(`(sidebar unavailable — ${(e as Error).message})`);
    } finally {
      setSidebarLoading(false);
    }
  }

  // Form view
  if (!result) {
    return (
      <div className="space-y-5">
        <header>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Sepsis 1-hour bundle</h1>
          <p className="mt-1 text-sm text-slate-500">
            Live countdown + per-element status against the SSC 2021 1-h bundle. Deterministic compliance math, opt-in educational sidebar (qwen 14b, cached 7 days).
          </p>
        </header>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-5">
          {/* Recognition time + backdate */}
          <fieldset className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
            <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recognition</legend>
            <div className="flex flex-wrap items-center gap-2">
              <Clock className="h-4 w-4 text-slate-400" />
              <span className="text-sm font-medium text-slate-700">t0 = {formatLocalTime(recognitionTime)}</span>
              <div className="ml-auto flex flex-wrap gap-1">
                {BACKDATE_PRESETS.map((p) => (
                  <button key={p.label} type="button" onClick={() => applyBackdate(p.minutes)}
                          className="rounded border border-slate-300 px-2 py-1 text-xs hover:border-brand hover:text-brand">
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer">Custom t0…</summary>
              <input type="datetime-local"
                     onChange={(e) => { if (e.target.value) setRecognitionTime(new Date(e.target.value).toISOString()); }}
                     className="mt-2 rounded border border-slate-300 px-2 py-1 text-sm" />
            </details>
          </fieldset>

          {/* Elements */}
          <fieldset className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
            <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">Bundle elements</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={lactateDone} onChange={(e) => setLactateDone(e.target.checked)} className="mt-0.5"/><div><div>Lactate measured</div><div className="text-xs text-slate-500">{lactateDone && <input type="number" inputMode="decimal" placeholder="value mmol/L" value={lactateValue} onChange={(e) => setLactateValue(e.target.value)} className="mt-1 w-32 rounded border border-slate-300 px-1.5 py-0.5 text-xs"/>}</div></div></label>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={culturesDone} onChange={(e) => setCulturesDone(e.target.checked)} className="mt-0.5"/><span>Blood cultures × 2 drawn (pre-abx)</span></label>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={abxGiven} onChange={(e) => setAbxGiven(e.target.checked)} className="mt-0.5"/><span>Broad-spectrum antibiotics given</span></label>
              <label className="flex items-start gap-2 text-sm sm:col-span-2 rounded bg-slate-50 px-2 py-1"><input type="checkbox" checked={hypoOrHighLac} onChange={(e) => setHypoOrHighLac(e.target.checked)} className="mt-0.5"/><span><span className="font-medium text-slate-800">Hypotension or lactate ≥4 mmol/L</span> <span className="text-xs text-slate-500">— gates the 30 mL/kg fluid requirement and vasopressor consideration</span></span></label>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={fluidsDone} onChange={(e) => setFluidsDone(e.target.checked)} className="mt-0.5" disabled={!hypoOrHighLac}/><div><div className={hypoOrHighLac ? '' : 'text-slate-400'}>30 mL/kg crystalloid given</div><div className="text-xs text-slate-500">{fluidsDone && <input type="number" inputMode="numeric" placeholder="volume mL" value={fluidVolumeMl} onChange={(e) => setFluidVolumeMl(e.target.value)} className="mt-1 w-32 rounded border border-slate-300 px-1.5 py-0.5 text-xs"/>}</div></div></label>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={vasopressorsStarted} onChange={(e) => setVasopressorsStarted(e.target.checked)} className="mt-0.5" disabled={!hypoOrHighLac || !fluidsDone}/><span className={(hypoOrHighLac && fluidsDone) ? '' : 'text-slate-400'}>Vasopressors started <span className="text-xs text-slate-500">(if MAP &lt;65 after bolus)</span></span></label>
              <label className="flex items-start gap-2 text-sm"><span className="text-slate-600">Weight (kg, optional)</span><input type="number" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} className="w-24 rounded border border-slate-300 px-2 py-1 text-sm"/></label>
            </div>
          </fieldset>

          <div className="flex items-center justify-end gap-3 border-t border-slate-200 pt-3">
            <button type="submit" disabled={submitting} className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand/90 disabled:opacity-50">
              {submitting ? 'Computing…' : 'Start bundle tracker'}
            </button>
          </div>
          {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
        </form>
      </div>
    );
  }

  // Result view
  const remainingClass = result.remaining_min === 0 ? 'text-red-700' : result.remaining_min < 15 ? 'text-amber-700' : 'text-slate-700';

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Sepsis 1-hour bundle</h1>
      </header>

      {/* Countdown */}
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Elapsed</div>
            <div className="text-3xl font-bold text-slate-900">{result.elapsed_min} <span className="text-base font-medium text-slate-500">min</span></div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Remaining (1 h window)</div>
            <div className={`text-3xl font-bold ${remainingClass}`}>{result.remaining_min} <span className="text-base font-medium text-slate-500">min</span></div>
          </div>
          <div className="ml-auto text-right">
            <div className="text-xs uppercase tracking-wide text-slate-500">Compliance</div>
            <div className={`text-3xl font-bold ${result.compliance_pct === 100 ? 'text-emerald-700' : result.compliance_pct >= 50 ? 'text-amber-700' : 'text-red-700'}`}>{result.compliance_pct}%</div>
            <div className="text-xs text-slate-500">{result.complete_required_count}/{result.required_count} required</div>
          </div>
        </div>
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
          <div className={`h-full ${result.compliance_pct === 100 ? 'bg-emerald-500' : result.compliance_pct >= 50 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${result.compliance_pct}%` }} />
        </div>
        <div className="mt-2 text-xs text-slate-400">Recognition at {formatLocalTime(result.recognition_iso)} · auto-refresh every 30 s</div>
      </div>

      {/* Auto-banner */}
      {result.banner && (
        <div className={`flex items-start gap-3 rounded-lg border p-4 ${result.banner.tone === 'red' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="flex-1">
            <div className="text-sm font-medium">{result.banner.text}</div>
            {result.banner.cta && (
              <Link href={result.banner.cta.href} className="mt-1 inline-block text-sm font-semibold underline">{result.banner.cta.label} →</Link>
            )}
          </div>
        </div>
      )}

      {/* Per-element grid */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {result.elements.map((el) => {
          const Icon = ELEMENT_ICON[el.status];
          return (
            <div key={el.key} className={`flex items-start gap-3 rounded-lg border p-3 ${ELEMENT_COLOR[el.status]}`}>
              <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
              <div className="flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{el.label}</span>
                  {!el.required && <span className="text-[10px] uppercase tracking-wide opacity-70">not required</span>}
                </div>
                <div className="mt-0.5 text-xs leading-relaxed opacity-80">{el.why_matters}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* qSOFA/SOFA consumption hint */}
      {(result.qsofa !== null || result.sofa !== null) && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Consuming from session: {result.qsofa !== null && <span>qSOFA {result.qsofa}</span>} {result.sofa !== null && <span>· SOFA {result.sofa}</span>}
        </div>
      )}

      {/* Sidebar */}
      <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <button type="button" onClick={loadSidebar}
                className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-50">
          <BookOpen className="h-4 w-4 text-brand" />
          Teach me the evidence
          <ChevronDown className={`ml-auto h-4 w-4 transition ${sidebarOpen ? 'rotate-180' : ''}`} />
          {sidebarCached && <span className="text-[10px] uppercase tracking-wide text-slate-400">(cached)</span>}
        </button>
        {sidebarOpen && (
          <div className="border-t border-slate-200 px-4 py-3 text-sm leading-relaxed text-slate-700">
            {sidebarLoading
              ? <div className="text-slate-400">Generating sidebar with qwen 14b… (typically 15-20 s on first open per week)</div>
              : <div className="whitespace-pre-wrap">{sidebarContent}</div>}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <button type="button" onClick={() => submit()} className="rounded-md border border-brand bg-brand-faint px-3 py-1.5 text-sm text-brand hover:bg-brand hover:text-white">Refresh now</button>
        <Link href="/coach?topic=SSC%20sepsis%20one-hour%20bundle" className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand hover:text-brand">
          <GraduationCap className="h-4 w-4" /> Coach me on the SSC bundle
        </Link>
        <button type="button" onClick={() => { setResult(null); setSidebarOpen(false); setSidebarContent(null); }} className="ml-auto text-sm text-slate-500 hover:text-slate-700">← New bundle</button>
      </div>

      {traceId && <div className="text-xs text-slate-400">Trace: <code className="rounded bg-slate-100 px-1.5 py-0.5">{traceId}</code></div>}
    </div>
  );
}
