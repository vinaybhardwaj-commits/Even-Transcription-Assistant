'use client';

import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { consumeNdjson } from '@/lib/ndjson-client';
import TracePanel, { TraceEvent } from '@/components/TracePanel';
import { Send, Loader2, AlertTriangle, ChevronDown, ChevronUp, ClipboardList, BookOpen, Microscope, CheckCircle2, MinusCircle, FlaskConical, SlidersHorizontal, RefreshCw, HelpCircle } from 'lucide-react';
import { MarkdownAnswer } from '@/components/MarkdownAnswer';
import ClinicalStatePanel, { FLAG_STYLE, FLAG_LABEL } from '@/components/ClinicalStatePanel';
import type { ClinicalStateUiView } from '@/lib/clinical-state/ui-view';

// Unified Clarity toggle-pill style (shared look with /ask).
function togCls(active: boolean): string {
  return 'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ' +
    (active ? 'border-brand bg-brand-faint text-brand' : 'border-slate-200 bg-white text-slate-500 hover:border-brand/60 hover:text-slate-700');
}

type Citation = {
  n: number; id: number; book: string; chapter: string | null;
  page_start: number | null; page_end: number | null;
  item_number: string | null; chunk_type: string;
  similarity: number; preview: string;
};
type PlosCitation = {
  n: number; kind: 'plos'; doi: string; title: string;
  authors: string[]; year: number; url: string; full_url: string; preview: string;
};
type Dx = {
  diagnosis: string;
  likelihood?: 'low' | 'moderate' | 'high';
  why_consider?: string;
  distinguishing_features?: string[];
  investigations?: string[];
  investigation_fit?: string;
  citation_ids?: number[];
  plos_citation_ids?: string[];
  // Cross-axis flags set server-side (lib/ddx-constraints crossLinkDdxBuckets) when
  // the same diagnosis appears on BOTH axes — so we cross-link the two cards as one
  // diagnosis viewed two ways, instead of two cards that look like separate dups.
  also_cannot_miss?: boolean;   // on a most_likely card: also a cannot-miss
  also_most_likely?: boolean;   // on a cannot_miss card: also the leading diagnosis
};
type InvestigationFinding = {
  test: string; value: string; unit?: string | null;
  flag: 'low' | 'normal' | 'high' | 'critical' | 'abnormal' | 'indeterminate';
  category: 'lab' | 'imaging' | 'ecg' | 'micro' | 'pathology' | 'vital' | 'other';
  note?: string | null;
};
type DdxResponse = {
  summary?: string;
  missing_info?: string[];
  cannot_miss?: Dx[];
  most_likely?: Dx[];
  other?: Dx[];
  citations?: Citation[];
  plos_citations?: PlosCitation[];
  presentation?: string;
  investigations?: { findings: InvestigationFinding[]; summary?: string; structured?: boolean };
  duration_ms?: number;
  error?: string;
  detail?: string;
  // Build 1c — additive, present only when CLINICAL_STATE_UI=1 server-side. Absent by default
  // → the panel below does not render → /ddx is unchanged.
  clinicalState?: ClinicalStateUiView;
};

const EXAMPLES = [
  { age: 58, sex: 'F', cc: 'Sudden onset chest pain radiating to left arm × 30 min', history: 'HTN, hyperlipidemia, smoker', exam: 'Diaphoretic, anxious, lungs clear', vitals: 'HR 112, BP 145/95, RR 22, SpO2 95% RA', investigations: 'ECG: 1 mm ST depression II, III, aVF. Troponin I 0.42 ng/mL (ref <0.04).' },
  { age: 32, sex: 'M', cc: 'Severe headache "worst of my life" × 1 hour', history: 'No prior headaches; smokes', exam: 'Photophobia, neck stiffness, GCS 15', vitals: 'HR 96, BP 168/98, RR 18, T 37.2°C', investigations: 'CT head non-contrast: no acute haemorrhage. Bloods unremarkable.' },
  { age: 72, sex: 'F', cc: 'Confusion and falls × 2 days', history: 'CKD stage 3, T2DM on metformin + glipizide', exam: 'Lethargic, dry mucosa', vitals: 'HR 105, BP 100/60, RR 22, T 37.8°C, glucose 48', investigations: 'Glucose 48 mg/dL. Na 130. Creatinine 2.1 mg/dL. WBC 13.' },
];

const LIKELIHOOD_COLORS: Record<string, string> = {
  high: 'bg-emerald-100 text-emerald-800',
  moderate: 'bg-amber-100 text-amber-900',
  low: 'bg-slate-100 text-slate-600',
};

function DxCard({ dx, idx, danger, onCite, onPlosCite }: { dx: Dx; idx: number; danger?: boolean; onCite: (n: number) => void; onPlosCite: (label: string) => void }) {
  const [open, setOpen] = useState(idx === 0);
  const lk = (dx.likelihood ?? 'moderate').toLowerCase();
  return (
    <article className={`rounded-xl border bg-white shadow-sm ${danger ? 'border-rose-200' : 'border-slate-200'}`}>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50"
      >
        <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${danger ? 'bg-rose-100 text-rose-700' : 'bg-brand-faint text-brand'}`}>
          {idx + 1}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-slate-900">{dx.diagnosis}</h3>
          <div className="mt-1 flex items-center gap-2 text-xs">
            <span className={`rounded-full px-2 py-0.5 font-semibold ${LIKELIHOOD_COLORS[lk] ?? LIKELIHOOD_COLORS.moderate}`}>
              {lk} likelihood
            </span>
            {dx.also_cannot_miss && (
              <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 font-semibold text-rose-700" title="This is also flagged as a cannot-miss — see the Cannot-miss section.">
                <AlertTriangle className="h-3 w-3" /> also cannot-miss
              </span>
            )}
            {dx.also_most_likely && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-800" title="This is also your leading diagnosis — see the Most likely section.">
                <CheckCircle2 className="h-3 w-3" /> also most-likely
              </span>
            )}
            {(() => {
              const totalCites = (dx.citation_ids?.length || 0) + (dx.plos_citation_ids?.length || 0);
              return totalCites > 0 ? (
                <span className="text-slate-400">
                  {totalCites} citation{totalCites !== 1 ? 's' : ''}
                </span>
              ) : null;
            })()}
          </div>
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-100 px-4 py-3 text-sm">
          {dx.why_consider && (
            <div className="leading-relaxed text-slate-700"><MarkdownAnswer text={dx.why_consider} onCite={(n) => { const num = parseInt(String(n), 10); if (!isNaN(num)) onCite(num); }} /></div>
          )}
          {dx.investigation_fit && dx.investigation_fit.trim() && (() => {
            const fit = dx.investigation_fit!.trim();
            const lower = fit.toLowerCase();
            const against = /(against|lower|lowers|exclude|argue|reduce|rule.{0,4}down|inconsistent|does not support|doesn't support|unlikely|refute)/.test(lower);
            const supports = !against && /(support|consistent|fits|rule.{0,4}in|confirm|raise|favou?r|in keeping|compatible)/.test(lower);
            const tone = supports ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : against ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-slate-200 bg-slate-50 text-slate-700';
            const Icon = supports ? CheckCircle2 : against ? MinusCircle : Microscope;
            return (
              <div className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 ${tone}`}>
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div className="text-[12.5px] leading-snug"><span className="font-semibold">Fit with results: </span>{fit}</div>
              </div>
            );
          })()}
          {dx.distinguishing_features && dx.distinguishing_features.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <ClipboardList className="h-3 w-3" /> Distinguishing features
              </div>
              <ul className="ml-4 list-disc space-y-0.5 text-slate-700">
                {dx.distinguishing_features.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
          )}
          {dx.investigations && dx.investigations.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <Microscope className="h-3 w-3" /> Suggested workup
              </div>
              <ul className="ml-4 list-disc space-y-0.5 text-slate-700">
                {dx.investigations.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
          )}
          {dx.citation_ids && dx.citation_ids.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Textbook:</span>
              {dx.citation_ids.map((n) => (
                <button
                  key={n}
                  onClick={() => onCite(n)}
                  className="rounded-md bg-brand-faint px-1.5 py-0.5 text-[11px] font-semibold text-brand hover:bg-brand hover:text-white"
                >
                  [{n}]
                </button>
              ))}
            </div>
          )}
          {dx.plos_citation_ids && dx.plos_citation_ids.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">PLOS:</span>
              {dx.plos_citation_ids.map((label) => (
                <button
                  key={label}
                  onClick={() => onPlosCite(label)}
                  className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-500 hover:text-white"
                >
                  [{label}]
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// Build 1c ClinicalState panel: moved to components/ClinicalStatePanel.tsx (verbatim) so
// the Right Care client renders the identical view. Imported above.

export default function DdxClient() {
  const [multiQuery, setMultiQuery] = useState(true);
  const [selfCritique, setSelfCritique] = useState(true);
  const [hypothesisFirst, setHypothesisFirst] = useState(true);  // default ON: reasoning-first dx proposal then per-candidate retrieval (catches clue-based dx e.g. leishmaniasis)
  const [showSettings, setShowSettings] = useState(false);
  const [critique, setCritique] = useState<{ severity: string; issue_count: number; details: Record<string, unknown> } | null>(null);
  const [age, setAge] = useState('');
  const [sex, setSex] = useState('?');
  const [cc, setCc] = useState('');
  const [history, setHistory] = useState('');
  const [exam, setExam] = useState('');
  const [vitals, setVitals] = useState('');
  const [investigations, setInvestigations] = useState('');
  const [data, setData] = useState<DdxResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [openCites, setOpenCites] = useState<Record<number, boolean>>({});
  const [plosOpenCites, setPlosOpenCites] = useState<Record<string, boolean>>({});
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [totalMs, setTotalMs] = useState<number | undefined>(undefined);
  const [traceId, setTraceId] = useState<string | null>(null);
  // v1.7b S2: rotating example chips with Shuffle ↻ (surface=ddx)
  const DEFAULT_CHIPS = [
    '62y M with sudden-onset RLQ pain, fever, anorexia x 18hr',
    '45y F with painless rectal bleeding x 3 months, mild anaemia',
    '72y M with sudden right hemiparesis + aphasia 90 min ago',
  ];
  const [chips, setChips] = useState<string[]>(DEFAULT_CHIPS);
  const loadChips = useCallback(async () => {
    try {
      const r = await fetch('/api/ask/example-questions?surface=ddx&n=4');
      if (!r.ok) return;
      const j = await r.json();
      const qs = (j.questions || []).map((x: { question: string }) => x.question).filter(Boolean);
      if (qs.length) setChips(qs);
    } catch {}
  }, []);
  useEffect(() => { loadChips(); }, [loadChips]);

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
  const sourcesRef = useRef<HTMLDivElement | null>(null);
  const sessionId = useMemo(() => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())), []);

  function loadExample(ex: typeof EXAMPLES[number]) {
    setAge(String(ex.age)); setSex(ex.sex); setCc(ex.cc);
    setHistory(ex.history); setExam(ex.exam); setVitals(ex.vitals);
    setInvestigations(ex.investigations || '');
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!cc.trim()) { setError('Chief complaint is required'); return; }
    setError(null); setData(null); setLoading(true); setOpenCites({});
    setTrace([]); setTotalMs(undefined); setTraceId(null);
    const t0 = Date.now();
    try {
      const r = await fetch('/api/ddx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          age: age ? Number(age) : undefined,
          sex: sex !== '?' ? sex : undefined,
          cc: cc.trim(),
          history: history.trim() || undefined,
          exam: exam.trim() || undefined,
          vitals: vitals.trim() || undefined,
          investigations: investigations.trim() || undefined, multiQuery, selfCritique, engine: hypothesisFirst ? 'hypothesis' : 'classic', includePlos: true }),
      });
      const tid = r.headers.get('X-Trace-Id');
      if (tid) setTraceId(tid);
      if (!r.ok) {
        const t = await r.text();
        setError(`HTTP ${r.status}: ${t.slice(0, 200)}`);
        return;
      }
      const dRef: { current: DdxResponse | null } = { current: null };
      await consumeNdjson(r, (ev) => {
        if (ev.type === 'progress') pushTrace(ev.stage, ev.msg, ev.ms);
        else if (ev.type === 'sources') { /* citations come with result */ }
        else if ((ev as { type: string }).type === 'critique') { const c = ev as unknown as { severity: string; issue_count: number; details: Record<string, unknown> }; setCritique({ severity: c.severity, issue_count: c.issue_count, details: c.details }); }
        else if (ev.type === 'result') { dRef.current = ev.data as DdxResponse; setData(dRef.current); }
        else if (ev.type === 'done') { setTotalMs(ev.ms); pushTrace('done', '', ev.ms, true); }
        else if (ev.type === 'error') { setError(ev.message); pushTrace('done', ev.message, undefined, true, true); }
      });
      if (!dRef.current) return;
      const d = dRef.current;
      // Fire-and-forget log
      fetch('/api/log/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feature: 'ddx',
          query_text: `${age || '?'}/${sex} ${cc.trim()}`,
          expanded_query: d.presentation,
          answer_text: JSON.stringify({ summary: d.summary, cannot_miss: d.cannot_miss?.map((x) => x.diagnosis), most_likely: d.most_likely?.map((x) => x.diagnosis), other: d.other?.map((x) => x.diagnosis) }),
          citation_ids: (d.citations || []).map((c) => c.id),
          duration_ms: Date.now() - t0,
          session_id: sessionId,
        }),
      }).catch(() => {});
    } catch (err) {
      setError(String((err as Error).message));
    } finally { setLoading(false); }
  }

  function onCite(n: number) {
    setHighlighted(n);
    setOpenCites((p) => ({ ...p, [n]: true }));
    setTimeout(() => {
      document.getElementById(`ddx-cite-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
    setTimeout(() => setHighlighted((h) => (h === n ? null : h)), 2000);
  }
  function onPlosCite(label: string) {
    // label is 'P1', 'P2', etc.
    setPlosOpenCites((p) => ({ ...p, [label]: true }));
    setTimeout(() => {
      document.getElementById(`ddx-plos-cite-${label}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  }

  const cannot = data?.cannot_miss ?? [];
  const likely = data?.most_likely ?? [];
  const other = data?.other ?? [];

  return (
    <div>
      <form onSubmit={submit} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex gap-3">
          <div className="w-20">
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Age</label>
            <input
              type="number" min="0" max="120"
              value={age} onChange={(e) => setAge(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              placeholder="58"
            />
          </div>
          <div className="flex-1">
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Sex</label>
            <select
              value={sex} onChange={(e) => setSex(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            >
              <option value="?">—</option>
              <option value="M">Male</option>
              <option value="F">Female</option>
              <option value="O">Other</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Chief complaint <span className="text-rose-500">*</span>
          </label>
          <textarea
            value={cc} onChange={(e) => setCc(e.target.value)}
            rows={2} required
            placeholder="Sudden onset chest pain radiating to left arm × 30 min"
            className="mt-1 w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Key history</label>
          <textarea
            value={history} onChange={(e) => setHistory(e.target.value)}
            rows={2}
            placeholder="HTN, hyperlipidemia, smoker"
            className="mt-1 w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Exam findings</label>
          <textarea
            value={exam} onChange={(e) => setExam(e.target.value)}
            rows={2}
            placeholder="Diaphoretic, anxious, lungs clear"
            className="mt-1 w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Vitals</label>
          <input
            value={vitals} onChange={(e) => setVitals(e.target.value)}
            placeholder="HR 112, BP 145/95, RR 22, SpO2 95% RA, T 37.0°C"
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>

        <div>
          <label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand">
            <Microscope className="h-3 w-3" /> Investigation findings / results
          </label>
          <textarea
            value={investigations} onChange={(e) => setInvestigations(e.target.value)}
            rows={2}
            placeholder="ECG: ST elevation V2–V4. Troponin I 0.84. Na 131. CT head: no bleed."
            className="mt-1 w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
          <p className="mt-1 text-[11px] text-slate-400">Results already back — labs, imaging, ECG, micro, any format. CAT interprets them and reconciles each diagnosis against them.</p>
        </div>

        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-slate-400">Chief complaint is required. Other fields refine the differential.</span>
          <button
            type="submit"
            disabled={loading || !cc.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white shadow disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {loading ? 'Reasoning…' : 'Generate DDx'}
          </button>
        </div>
      </form>

      {/* v1.7b S2: rotating chips from EHRC case-mix DDx bank + Shuffle */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-400">Try a case:</span>
        {chips.map((stem, i) => (
          <button
            key={`${i}-${stem.slice(0, 20)}`}
            type="button"
            onClick={() => setCc(stem)}
            disabled={loading}
            className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 hover:border-brand hover:text-brand disabled:opacity-40"
            title={stem}
          >
            {stem.length > 56 ? stem.slice(0, 53) + '…' : stem}
          </button>
        ))}
        <button
          type="button"
          onClick={loadChips}
          disabled={loading}
          aria-label="Shuffle case examples"
          className="flex items-center justify-center rounded-full border border-slate-200 bg-white p-1.5 text-slate-400 transition hover:border-brand hover:text-brand disabled:opacity-40"
          title="Show different examples"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* Rich form-fill examples kept as a secondary row */}
      <div className="mt-2 flex flex-wrap gap-2">
        <span className="text-xs text-slate-400">Or a full preset:</span>
        {EXAMPLES.map((ex, i) => (
          <button
            key={i}
            type="button"
            onClick={() => loadExample(ex)}
            disabled={loading}
            className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 hover:border-brand hover:text-brand disabled:opacity-40"
          >
            {ex.age}/{ex.sex} {ex.cc.split(' ').slice(0, 4).join(' ')}…
          </button>
        ))}
      </div>

      {/* Pipeline settings — collapsed by default; unified Clarity toggles. PLOS stays on for /ddx. */}
      <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <button type="button" onClick={() => setShowSettings((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
          <SlidersHorizontal className="h-4 w-4 shrink-0 text-slate-400" />
          <span className="text-[13px] font-medium text-slate-700">Pipeline</span>
          {!showSettings && (
            <span className="ml-1 hidden truncate text-[11.5px] text-slate-400 sm:inline">
              {[multiQuery, selfCritique, hypothesisFirst].filter(Boolean).length}/3 steps on
            </span>
          )}
          {showSettings ? <ChevronUp className="ml-auto h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-slate-400" />}
        </button>
        {showSettings && (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-3 py-3">
            <button type="button" onClick={() => setMultiQuery((v) => !v)} disabled={loading} aria-pressed={multiQuery}
              title={loading ? 'Locked while query is running' : 'Generate 4 query variants for richer recall'} className={togCls(multiQuery)}>
              {multiQuery ? '✓ ' : ''}Multi-query
            </button>
            <button type="button" onClick={() => setSelfCritique((v) => !v)} disabled={loading} aria-pressed={selfCritique}
              title={loading ? 'Locked while query is running' : 'Audit + revise the DDx before returning'} className={togCls(selfCritique)}>
              {selfCritique ? '✓ ' : ''}Self-critique
            </button>
            <button type="button" onClick={() => setHypothesisFirst((v) => !v)} disabled={loading} aria-pressed={hypothesisFirst}
              title={loading ? 'Locked while query is running' : 'Reason the differential first, then retrieve evidence per candidate diagnosis (broader, less anchored). Slower.'} className={togCls(hypothesisFirst)}>
              {hypothesisFirst ? '✓ ' : ''}Hypothesis-first <span className="ml-0.5 opacity-60">{hypothesisFirst ? 'default' : 'off'}</span>
            </button>
          </div>
        )}
      </div>

      {(trace.length > 0 || loading) && <div className="mt-5"><TracePanel events={trace} totalMs={totalMs} traceId={traceId} surface="ddx" askChips={{ useMultiQuery: multiQuery, selfCritique, useReranker: true, useSourceWeights: true, includePlos: true }} /></div>}

      {error && (
        <div className="mt-6 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div>
      )}

      {loading && (
        <div className="mt-6 rounded-xl border bg-white p-8 text-center text-slate-400 shadow-sm">
          <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin" />
          Reasoning across MKSAP, StatPearls, and UpToDate…
        </div>
      )}

      {data && !loading && (
        <div className="mt-6 space-y-6">
          {/* Build 1c — ClinicalState panel: renders only when the server included the additive
              clinicalState field (CLINICAL_STATE_UI=1). Absent by default → /ddx unchanged. */}
          {data.clinicalState && <ClinicalStatePanel state={data.clinicalState} />}
          {data.investigations && data.investigations.findings.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <FlaskConical className="h-3.5 w-3.5" /> Investigations interpreted
                <span className="ml-1 font-normal normal-case tracking-normal text-slate-400">how CAT read your results</span>
              </h2>
              {data.investigations.summary && (
                <p className="mb-2 text-[13px] text-slate-600">{data.investigations.summary}</p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {data.investigations.findings.map((f, i) => (
                  <span key={i} className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] ${FLAG_STYLE[f.flag] ?? FLAG_STYLE.abnormal}`}>
                    <span className="font-medium">{f.test}{f.value ? ` ${f.value}` : ''}{f.unit ? ` ${f.unit}` : ''}</span>
                    <span className="opacity-70">{FLAG_LABEL[f.flag] ?? f.flag}</span>
                  </span>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-slate-400">Interpreted by AI from your free text — verify against the source results.</p>
            </div>
          )}
          {data.summary && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Summary</h2>
              <p className="mt-1 text-sm leading-relaxed text-slate-800">{data.summary}</p>
            </div>
          )}

          {data.missing_info && data.missing_info.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-amber-900">Missing info that would refine this DDx</h2>
              <ul className="mt-1 ml-4 list-disc space-y-0.5 text-sm text-amber-900">
                {data.missing_info.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}

          {cannot.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-rose-700">
                <AlertTriangle className="h-4 w-4" /> Cannot-miss · rule out first
              </h2>
              <div className="space-y-2">
                {cannot.map((dx, i) => <DxCard key={i} dx={dx} idx={i} danger onCite={onCite} onPlosCite={onPlosCite} />)}
              </div>
            </section>
          )}

          {likely.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-700">Most likely</h2>
              <div className="space-y-2">
                {likely.map((dx, i) => <DxCard key={i} dx={dx} idx={i} onCite={onCite} onPlosCite={onPlosCite} />)}
              </div>
            </section>
          )}

          {other.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Other considerations</h2>
              <div className="space-y-2">
                {other.map((dx, i) => <DxCard key={i} dx={dx} idx={i} onCite={onCite} onPlosCite={onPlosCite} />)}
              </div>
            </section>
          )}

          {data.citations && data.citations.length > 0 && (
            <section ref={sourcesRef}>
              <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <BookOpen className="h-3.5 w-3.5" /> Sources ({data.citations.length})
              </h2>
              <ol className="space-y-2">
                {data.citations.map((c) => {
                  const isOpen = !!openCites[c.n];
                  const isHi = highlighted === c.n;
                  return (
                    <li
                      key={c.n}
                      id={`ddx-cite-${c.n}`}
                      className={`rounded-lg border text-sm shadow-sm transition ${
                        isHi ? 'border-brand bg-brand-faint/40' : 'border-slate-200 bg-white'
                      }`}
                    >
                      <button
                        onClick={() => setOpenCites((p) => ({ ...p, [c.n]: !isOpen }))}
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
          )}
          {data?.plos_citations && data.plos_citations.length > 0 && (
            <section className="mt-6">
              <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-700">
                <BookOpen className="h-3.5 w-3.5" /> PLOS ONE primary research ({data.plos_citations.length})
              </h2>
              <ol className="space-y-2">
                {data.plos_citations.map((p) => {
                  const label = `P${p.n}`;
                  const isOpen = !!plosOpenCites[label];
                  return (
                    <li
                      key={label}
                      id={`ddx-plos-cite-${label}`}
                      className="rounded-lg border border-amber-200 bg-amber-50/30 text-sm shadow-sm"
                    >
                      <button
                        onClick={() => setPlosOpenCites((prev) => ({ ...prev, [label]: !isOpen }))}
                        className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left hover:bg-amber-50/60"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-1.5">
                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800">[{label}]</span>
                            <span className="truncate font-medium text-slate-800">{p.title}</span>
                          </div>
                          <div className="mt-0.5 text-[11px] text-slate-500">
                            {p.authors.length > 0 && <span>{p.authors.join(', ')}{p.authors.length === 3 ? ' et al.' : ''} · </span>}
                            <span>PLOS ONE {p.year}</span>
                            <span className="mx-1">·</span>
                            <a href={p.full_url} target="_blank" rel="noopener noreferrer" className="text-amber-700 hover:underline" onClick={(e) => e.stopPropagation()}>open ↗</a>
                          </div>
                        </div>
                        {isOpen ? <ChevronUp className="h-4 w-4 shrink-0 text-amber-500" /> : <ChevronDown className="h-4 w-4 shrink-0 text-amber-500" />}
                      </button>
                      {isOpen && <div className="border-t border-amber-200 px-3 py-2 text-[13px] leading-relaxed text-slate-700">{p.preview}…</div>}
                    </li>
                  );
                })}
              </ol>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
