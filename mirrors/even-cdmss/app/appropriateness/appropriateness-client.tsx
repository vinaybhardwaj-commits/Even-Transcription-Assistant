'use client';

import { useState, type ChangeEvent, type ReactNode } from 'react';
import { Loader2, Flag, X, ExternalLink, Info, Scale, Lightbulb, BookOpen, AlertTriangle, IndianRupee, Route, Upload, FileText, Lock, ClipboardCheck, FileSearch, Download, type LucideIcon } from 'lucide-react';
import { levelToScore, VALUE_DISCLAIMER, type ValueAnalysis, type ValueIntervention, type Level, type NetValue, type TariffRef } from '@/lib/lvc-value-core';
import PathwayTrace from '@/components/PathwayTrace';
import type { PathwaySkeleton, PathwayEnrichment, SkeletonStage } from '@/lib/pathway-core';
import CaseAuditReport from '@/components/CaseAuditReport';
import ClinicalStatePanel from '@/components/ClinicalStatePanel';
import type { ClinicalStateUiView } from '@/lib/clinical-state/ui-view';
import type { MemberLink } from '@/lib/record-audit-link-store';
import type { ExtractedCase, AuditReport, DocType } from '@/lib/doc-audit-core';
import type { Source } from '@/lib/citations-core';
import { consumeNdjson } from '@/lib/ndjson-client';
import TracePanel, { type TraceEvent } from '@/components/TracePanel';
import { downloadRunsExcel, type ExportRun } from '@/lib/runs-export';

type Mode = 'check' | 'pathway' | 'audit';

// The three Right Care modes mapped to the care timeline (before / during / after),
// so the chooser explains itself at a glance.
const MODE_CARDS: { mode: Mode; name: string; timing: string; useWhen: string; input: string; Icon: LucideIcon }[] = [
  { mode: 'check',   name: 'Order check',  timing: 'Before ordering',   useWhen: 'Deciding whether a test or treatment is worth ordering.', input: 'Type a scenario',     Icon: ClipboardCheck },
  { mode: 'pathway', name: 'Care pathway', timing: 'Planning care',     useWhen: 'Mapping the right next steps for a presentation.',        input: 'Type a presentation', Icon: Route },
  { mode: 'audit',   name: 'Record audit', timing: 'After the episode', useWhen: 'Reviewing a finished episode for value and gaps.',        input: 'Upload a record',     Icon: FileSearch },
];

type CaEdit = {
  docType: DocType | 'auto'; detectedDocType: DocType; confidence: number;
  age: string; sex: string; diagnosis: string; indication: string; procedure: string;
  investigations: string; treatments: string; medications: string;
  courseSummary: string; disposition: string; followUp: string; rawNotes: string;
  // Document-grounded passthroughs (not user-edited): the completeness statuses + stay facts
  // produced by the read, carried so a Re-analyze (which skips re-reading the file) keeps them.
  completeness?: ExtractedCase['completeness']; adminFacts?: ExtractedCase['adminFacts'];
  // PX passthroughs (PRD v1.0 §6.3, likewise not user-edited): without these the prognosis
  // pass would see an empty plan on Re-analyze (found in G0 review).
  riskFactors?: ExtractedCase['riskFactors']; aftercare?: ExtractedCase['aftercare'];
};

const caInputCls = 'mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand focus:bg-white focus:outline-none';

const inr = (n: number) => '₹' + Number(n).toLocaleString('en-IN');

type Region = 'US' | 'CA' | 'IN';
type LvcFlag = {
  id: string;
  statement: string;
  society: string;
  region: Region;
  specialty: string | null;
  rationale: string | null;
  consider_instead: string | null;
  why_it_applies: string;
  confidence: number;
  citation: { url: string | null; doi: string | null; pmid: string | null; year: number | null };
};
type MatchResult = {
  ok: boolean;
  flags: LvcFlag[];
  candidates: { name: string }[];
  considered: number;
  empty: boolean;
  traceId?: string;
  valueAnalysis?: ValueAnalysis | null;
  valueSources?: Source[];
  valueTraceId?: string;
  // Right Care × ClinicalState Slice 1 — additive, present only when CLINICAL_STATE_UI=1
  // server-side. Absent by default → the panel does not render → the page is unchanged.
  clinicalState?: ClinicalStateUiView;
  error?: string;
};

type RegionMode = 'all' | 'india' | 'us' | 'ca';
const REGION_OPTIONS: [RegionMode, string][] = [
  ['all', 'All'], ['india', 'India-first'], ['us', 'US only'], ['ca', 'Canada only'],
];
const REGION_BADGE: Record<Region, string> = {
  US: 'bg-amber-50 text-amber-800',
  CA: 'bg-blue-50 text-blue-800',
  IN: 'bg-teal-50 text-teal-800',
};
const EXAMPLES = [
  '62F, asymptomatic cT1c N0 ER+ breast cancer. Planning staging PET-CT before surgery.',
  '34M, 5 days of non-specific low back pain, no red flags. Considering MRI lumbar spine.',
  'Otherwise-well adult with acute viral URTI for 3 days. Patient requesting antibiotics.',
];

function regionToBody(mode: RegionMode): { regionFilter?: Region[]; preferRegion?: Region } {
  switch (mode) {
    case 'india': return { preferRegion: 'IN' };
    case 'us': return { regionFilter: ['US'] };
    case 'ca': return { regionFilter: ['CA'] };
    default: return {};
  }
}

export default function AppropriatenessClient() {
  const [mode, setMode] = useState<Mode>('check');
  const [scenario, setScenario] = useState('');
  const [orders, setOrders] = useState('');
  const [age, setAge] = useState('');
  const [sex, setSex] = useState('');
  const [region, setRegion] = useState<RegionMode>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const [traces, setTraces] = useState<TraceEvent[]>([]);
  const [totalMs, setTotalMs] = useState<number | undefined>();
  const [runId, setRunId] = useState<string | null>(null);
  const [dlBusy, setDlBusy] = useState(false);

  function pushTrace(stage: string, msg: string, ms?: number, done = false, error = false) {
    setTraces((prev) => {
      const marked = prev.map((t) => (t.done || t.error ? t : { ...t, done: true }));
      return [...marked, { stage, msg, ms, done, error, ts: Date.now() }];
    });
  }

  // Persist a completed run for research retention (anonymous, de-identified). Fire-and-forget.
  // memberLink (audit only, Right Care × ClinicalState Slice 1): the linkage key the extract
  // route's identity-only pass returned — forwarded verbatim so save-run can store it in the
  // SEPARATE record_audit_member_links table. Never merged into input/output.
  async function saveRunRecord(mode: 'check' | 'pathway' | 'audit', scenarioStr: string | null, docType: string | null, input: unknown, output: unknown, memberLink?: MemberLink | null) {
    try {
      const r = await fetch('/api/appropriateness/save-run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, scenario: scenarioStr, docType, input, output, ...(memberLink ? { memberLink } : {}) }),
      });
      const j = await r.json();
      if (j && j.ok && j.runId) setRunId(j.runId);
    } catch { /* retention is best-effort; never blocks the UX */ }
  }

  // Build + download the multi-sheet Excel for the current result.
  async function downloadExcel(mode: 'check' | 'pathway' | 'audit', output: Record<string, unknown>, scenarioStr: string | null) {
    setDlBusy(true);
    try {
      const id = runId || `local-${Date.now()}`;
      const run: ExportRun = { id, mode, created_at: new Date().toISOString(), scenario: scenarioStr, output };
      await downloadRunsExcel([run], `appropriateness-${mode}-${id.slice(0, 8)}.xlsx`);
    } catch (e) {
      setError(`Could not generate the Excel file: ${(e as Error).message}`);
    } finally {
      setDlBusy(false);
    }
  }

  // Pathway & decision mode (Flash skeleton → Pro enrich).
  const [pwLoading, setPwLoading] = useState(false);
  const [pwEnriching, setPwEnriching] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSkeleton, setPwSkeleton] = useState<PathwaySkeleton | null>(null);
  const [pwEnrichment, setPwEnrichment] = useState<PathwayEnrichment | null>(null);
  const [pwSources, setPwSources] = useState<Source[]>([]);
  const [pwSkeletonTraceId, setPwSkeletonTraceId] = useState<string | undefined>();
  const [pwEnrichTraceId, setPwEnrichTraceId] = useState<string | undefined>();
  // Right Care × ClinicalState Slice 1 — additive panels (absent unless CLINICAL_STATE_UI=1).
  const [pwClinicalState, setPwClinicalState] = useState<ClinicalStateUiView | null>(null);

  function patientBody() {
    return { age: age ? Number(age) : undefined, sex: sex || undefined };
  }
  function parseOrders(): string[] {
    return orders.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
  }

  async function runPathway() {
    const s = scenario.trim();
    if (s.length < 3) { setPwError('Enter a clinical scenario.'); return; }
    setPwLoading(true); setPwEnriching(false); setPwError(null);
    setPwSkeleton(null); setPwEnrichment(null); setPwSources([]); setPwSkeletonTraceId(undefined); setPwEnrichTraceId(undefined);
    setPwClinicalState(null);
    setTraces([]); setTotalMs(undefined); setRunId(null);
    try {
      const proposedActions = parseOrders();
      const base: Record<string, unknown> = {
        scenario: s,
        ...(proposedActions.length ? { proposedActions } : {}),
        patient: patientBody(),
      };
      // 1) Fast skeleton — render immediately.
      pushTrace('detecting', 'Detecting stage…');
      const sr = await fetch('/api/pathway/skeleton', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(base),
      });
      const sj = (await sr.json()) as { ok: boolean; skeleton: PathwaySkeleton | null; traceId?: string; clinicalState?: ClinicalStateUiView; error?: string };
      if (!sr.ok || !sj.ok) throw new Error(sj.error || `request failed (${sr.status})`);
      if (!sj.skeleton || sj.skeleton.stages.length === 0) {
        setPwSkeletonTraceId(sj.traceId);
        throw new Error('Could not derive a care path for this scenario. Try adding a bit more detail.');
      }
      setPwSkeleton(sj.skeleton);
      setPwSkeletonTraceId(sj.traceId);
      if (sj.clinicalState) setPwClinicalState(sj.clinicalState);
      setPwLoading(false);
      pushTrace('detecting', 'Care path ready');

      // 2) Enrich each node — streams progress, then merges in on the result event.
      setPwEnriching(true);
      const er = await fetch('/api/pathway/enrich', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...base, workingDiagnosis: sj.skeleton.workingDiagnosis, stages: sj.skeleton.stages }),
      });
      if (!er.ok) throw new Error(`enrich failed (${er.status})`);
      await consumeNdjson(er, (ev) => {
        if (ev.type === 'progress') pushTrace(ev.stage, ev.msg, ev.ms);
        else if (ev.type === 'result') {
          const d = ev.data as { ok: boolean; enrichment: PathwayEnrichment | null; sources?: Source[]; traceId?: string };
          if (d && d.ok) {
            setPwEnrichment(d.enrichment); setPwSources(d.sources ?? []); setPwEnrichTraceId(d.traceId);
            saveRunRecord('pathway', s, null, base, { skeleton: sj.skeleton, enrichment: d.enrichment, sources: d.sources ?? [] });
          }
        } else if (ev.type === 'done') { setTotalMs(ev.ms); pushTrace('done', 'Pipeline complete', ev.ms, true); }
        else if (ev.type === 'error') setPwError(ev.message);
      });
    } catch (e) {
      setPwError((e as Error).message);
    } finally {
      setPwLoading(false); setPwEnriching(false);
    }
  }

  async function run() {
    const s = scenario.trim();
    if (s.length < 3) { setError('Enter a clinical scenario.'); return; }
    setLoading(true); setError(null); setResult(null); setDismissed({}); setTraces([]); setTotalMs(undefined); setRunId(null);
    try {
      const proposedActions = orders
        .split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
      const body: Record<string, unknown> = {
        scenario: s,
        ...(proposedActions.length ? { proposedActions } : {}),
        patient: { age: age ? Number(age) : undefined, sex: sex || undefined },
        ...regionToBody(region),
      };
      const r = await fetch('/api/appropriateness', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`request failed (${r.status})`);
      let gotResult = false;
      await consumeNdjson(r, (ev) => {
        if (ev.type === 'progress') pushTrace(ev.stage, ev.msg, ev.ms);
        else if (ev.type === 'result') {
          const d = ev.data as MatchResult;
          if (d && d.ok) {
            setResult(d); gotResult = true;
            saveRunRecord('check', s, null, body, { valueAnalysis: d.valueAnalysis, valueSources: d.valueSources, flags: d.flags, candidates: d.candidates, considered: d.considered });
          } else setError(d?.error || 'analysis failed');
        } else if (ev.type === 'done') { setTotalMs(ev.ms); pushTrace('done', 'Pipeline complete', ev.ms, true); }
        else if (ev.type === 'error') setError(ev.message);
      });
      if (!gotResult) setError((prev) => prev ?? 'No result received.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // ── Case audit mode (upload → multimodal extract → analyze) ──────────────────
  const [caDocType, setCaDocType] = useState<DocType | 'auto'>('auto');
  const [caContext, setCaContext] = useState('');
  const [caFileName, setCaFileName] = useState('');
  const [caPendingFile, setCaPendingFile] = useState<{ base64: string; mime: string } | null>(null);
  const [caExtractLoading, setCaExtractLoading] = useState(false);
  const [caAnalyzeLoading, setCaAnalyzeLoading] = useState(false);
  const [caError, setCaError] = useState<string | null>(null);
  const [caEdit, setCaEdit] = useState<CaEdit | null>(null);
  const [caReport, setCaReport] = useState<AuditReport | null>(null);
  const [caExtractTraceId, setCaExtractTraceId] = useState<string | undefined>();
  const [caAnalyzeTraceId, setCaAnalyzeTraceId] = useState<string | undefined>();
  // Right Care × ClinicalState Slice 1: the additive state panel (CLINICAL_STATE_UI=1) and the
  // member linkage key from the extract route's identity-only pass (RECORD_AUDIT_LINK=1) — held
  // apart from the de-identified case and forwarded only to save-run.
  const [caClinicalState, setCaClinicalState] = useState<ClinicalStateUiView | null>(null);
  const [caMemberLink, setCaMemberLink] = useState<MemberLink | null>(null);

  function onPickFile(file: File | null) {
    setCaError(null);
    if (!file) { setCaFileName(''); setCaPendingFile(null); return; }
    setCaFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || '');
      const comma = res.indexOf(',');
      setCaPendingFile({ base64: comma >= 0 ? res.slice(comma + 1) : res, mime: file.type || 'application/octet-stream' });
    };
    reader.onerror = () => setCaError('Could not read that file.');
    reader.readAsDataURL(file);
  }

  function editToExtracted(e: CaEdit): Record<string, unknown> {
    const splitList = (s: string) => s.split(/[\n;]+/).map((x) => x.trim()).filter(Boolean);
    return {
      docType: e.docType === 'auto' ? e.detectedDocType : e.docType,
      detectedDocType: e.detectedDocType, confidence: e.confidence,
      patient: { age: e.age ? Number(e.age) : undefined, sex: e.sex || undefined },
      diagnosis: e.diagnosis || null, indication: e.indication || null, procedure: e.procedure || null,
      investigations: splitList(e.investigations), treatments: splitList(e.treatments), medications: splitList(e.medications),
      courseSummary: e.courseSummary, disposition: e.disposition || null, followUp: e.followUp || null, rawNotes: e.rawNotes,
      completeness: e.completeness ?? [], adminFacts: e.adminFacts,
      riskFactors: e.riskFactors ?? [], aftercare: e.aftercare,
    };
  }

  // memberLink is threaded explicitly because runAudit calls this right after setCaMemberLink —
  // the closure would still see the previous render's value. Re-analyze passes the held state.
  async function analyzeExtracted(extracted: Record<string, unknown>, memberLink: MemberLink | null = caMemberLink) {
    setCaAnalyzeLoading(true); setCaError(null); setRunId(null);
    try {
      const r = await fetch('/api/doc-audit/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ extracted }) });
      if (!r.ok) throw new Error(`analysis failed (${r.status})`);
      let got = false;
      await consumeNdjson(r, (ev) => {
        if (ev.type === 'progress') pushTrace(ev.stage, ev.msg, ev.ms);
        else if (ev.type === 'result') {
          const d = ev.data as { ok: boolean; report: AuditReport | null; traceId?: string; clinicalState?: ClinicalStateUiView; error?: string };
          if (d && d.ok && d.report) {
            setCaReport(d.report); setCaAnalyzeTraceId(d.traceId); got = true;
            if (d.clinicalState) setCaClinicalState(d.clinicalState);
            saveRunRecord('audit', null, String(extracted.docType ?? ''), extracted, { report: d.report, extracted }, memberLink);
          } else { setCaAnalyzeTraceId(d?.traceId); setCaError(d?.error || 'analysis failed'); }
        } else if (ev.type === 'done') { setTotalMs(ev.ms); pushTrace('done', 'Pipeline complete', ev.ms, true); }
        else if (ev.type === 'error') setCaError(ev.message);
      });
      if (!got) setCaError((prev) => prev ?? 'No result received.');
    } catch (e) {
      setCaError((e as Error).message);
    } finally {
      setCaAnalyzeLoading(false);
    }
  }

  async function runAudit() {
    if (!caPendingFile) { setCaError('Choose a document to upload.'); return; }
    setCaExtractLoading(true); setCaError(null); setCaReport(null); setCaEdit(null);
    setCaExtractTraceId(undefined); setCaAnalyzeTraceId(undefined);
    setCaClinicalState(null); setCaMemberLink(null);
    setTraces([]); setTotalMs(undefined);
    pushTrace('reading', 'Reading the document…');
    try {
      const r = await fetch('/api/doc-audit/extract', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ base64: caPendingFile.base64, mime: caPendingFile.mime, docTypeHint: caDocType, context: caContext || undefined }),
      });
      const j = await r.json();
      setCaExtractTraceId(j.traceId);
      if (!r.ok || !j.ok || !j.extracted) throw new Error(j.error || `could not read the document (${r.status})`);
      const link = (j.memberLink ?? null) as MemberLink | null;
      setCaMemberLink(link);
      const ex = j.extracted as ExtractedCase;
      const edit: CaEdit = {
        docType: caDocType, detectedDocType: ex.detectedDocType, confidence: ex.confidence,
        age: ex.patient.age != null ? String(ex.patient.age) : '', sex: ex.patient.sex || '',
        diagnosis: ex.diagnosis || '', indication: ex.indication || '', procedure: ex.procedure || '',
        investigations: ex.investigations.join('\n'), treatments: ex.treatments.join('\n'), medications: ex.medications.join('\n'),
        courseSummary: ex.courseSummary, disposition: ex.disposition || '', followUp: ex.followUp || '', rawNotes: ex.rawNotes,
        completeness: ex.completeness ?? [], adminFacts: ex.adminFacts,
        riskFactors: ex.riskFactors ?? [], aftercare: ex.aftercare,
      };
      setCaEdit(edit);
      setCaExtractLoading(false);
      pushTrace('extracting', 'Document read');
      await analyzeExtracted(editToExtracted(edit), link);
    } catch (e) {
      setCaError((e as Error).message);
    } finally {
      setCaExtractLoading(false);
    }
  }

  const visibleFlags = (result?.flags ?? []).filter((f) => !dismissed[f.id]);

  return (
    <div>
      {/* Timeline rail: before → during → after */}
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-slate-400">Before</span>
        <span className="h-px flex-1 bg-slate-200" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-slate-400">During</span>
        <span className="h-px flex-1 bg-slate-200" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-slate-400">After</span>
      </div>
      {/* Mode chooser — each card says what it's for and when to use it */}
      <div className="mb-5 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        {MODE_CARDS.map((c) => {
          const active = mode === c.mode;
          const Icon = c.Icon;
          return (
            <button
              key={c.mode}
              type="button"
              onClick={() => setMode(c.mode)}
              aria-pressed={active}
              className={'flex flex-col rounded-xl border bg-white p-3.5 text-left transition ' +
                (active ? 'border-brand bg-brand-faint/30 ring-1 ring-brand' : 'border-slate-200 hover:border-brand/60')}
            >
              <div className="flex items-center justify-between">
                <span className={'flex h-8 w-8 items-center justify-center rounded-lg ' + (active ? 'bg-brand-faint text-brand' : 'bg-slate-100 text-slate-500')}>
                  <Icon className="h-4 w-4" />
                </span>
                <span className={'rounded-md px-2 py-0.5 text-[9.5px] font-semibold ' + (active ? 'bg-brand-faint text-brand' : 'bg-slate-100 text-slate-500')}>{c.timing}</span>
              </div>
              <span className={'mt-2.5 text-[14px] font-medium ' + (active ? 'text-brand' : 'text-slate-900')}>{c.name}</span>
              <span className="mt-0.5 text-[12px] leading-snug text-slate-500">{c.useWhen}</span>
              <span className="mt-2 text-[10.5px] text-slate-400">{c.input}</span>
            </button>
          );
        })}
      </div>

      {mode !== 'audit' && (
      <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
        <label className="text-xs font-medium text-slate-600">Clinical scenario</label>
        <textarea
          value={scenario}
          onChange={(e) => setScenario(e.target.value)}
          rows={3}
          placeholder="62F, asymptomatic early-stage breast cancer, planning staging PET-CT…"
          className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand focus:bg-white focus:outline-none"
        />

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[2fr_0.7fr_1fr_1.1fr]">
          <div>
            <label className="text-xs font-medium text-slate-600">Proposed order(s) <span className="text-slate-400">· optional</span></label>
            <input
              value={orders}
              onChange={(e) => setOrders(e.target.value)}
              placeholder="staging PET-CT"
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand focus:bg-white focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Age</label>
            <input
              value={age} onChange={(e) => setAge(e.target.value.replace(/[^0-9]/g, ''))}
              inputMode="numeric" placeholder="62"
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand focus:bg-white focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Sex</label>
            <select
              value={sex} onChange={(e) => setSex(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-brand focus:bg-white focus:outline-none"
            >
              <option value="">—</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Region</label>
            <select
              value={region} onChange={(e) => setRegion(e.target.value as RegionMode)}
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-brand focus:bg-white focus:outline-none"
            >
              {REGION_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {mode === 'check' ? (
            <button
              onClick={run} disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              type="button"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Flag className="h-4 w-4" />}
              {loading ? 'Checking…' : 'Run order check'}
            </button>
          ) : (
            <button
              onClick={runPathway} disabled={pwLoading || pwEnriching}
              className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              type="button"
            >
              {(pwLoading || pwEnriching) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Route className="h-4 w-4" />}
              {pwLoading ? 'Mapping…' : pwEnriching ? 'Enriching…' : 'Map the pathway'}
            </button>
          )}
          <span className="text-xs text-slate-400">
            {mode === 'check'
              ? 'Extraction → recall → applicability check; only what applies is shown.'
              : 'Detect stage → trace care path → enrich each step with evidence, value, and tariffs.'}
          </span>
        </div>

        {!scenario && (
          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" onClick={() => setScenario(ex)}
                className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:border-slate-300 hover:bg-slate-50">
                {ex.length > 52 ? ex.slice(0, 52) + '…' : ex}
              </button>
            ))}
          </div>
        )}
      </div>
      )}

      {mode === 'audit' && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
          <label className="text-xs font-medium text-slate-600">Upload a clinical document</label>
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100">
              <Upload className="h-4 w-4" /> Choose file
              <input type="file" accept="application/pdf,image/png,image/jpeg" className="hidden"
                onChange={(e) => onPickFile(e.target.files?.[0] ?? null)} />
            </label>
            {caFileName && <span className="inline-flex items-center gap-1.5 text-sm text-slate-600"><FileText className="h-4 w-4 text-slate-400" /> {caFileName}</span>}
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_2fr]">
            <div>
              <label className="text-xs font-medium text-slate-600">Document type</label>
              <select value={caDocType} onChange={(e) => setCaDocType(e.target.value as DocType | 'auto')} className={caInputCls}>
                <option value="auto">Auto-detect</option>
                <option value="discharge_summary">Discharge summary</option>
                <option value="ot_note">OT / operative note</option>
                <option value="opd_rx">OPD prescription</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600">Context <span className="text-slate-400">· optional</span></label>
              <input value={caContext} onChange={(e) => setCaContext(e.target.value)} placeholder="anything the document doesn't state" className={caInputCls} />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button onClick={runAudit} disabled={caExtractLoading || caAnalyzeLoading || !caPendingFile}
              className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50" type="button">
              {(caExtractLoading || caAnalyzeLoading) ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardCheck className="h-4 w-4" />}
              {caExtractLoading ? 'Reading…' : caAnalyzeLoading ? 'Auditing…' : 'Run record audit'}
            </button>
            <span className="inline-flex items-center gap-1 text-xs text-slate-400"><Lock className="h-3 w-3" /> Processed in-memory · the file isn&apos;t stored.</span>
          </div>
        </div>
      )}

      {mode === 'audit' && caError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{caError}</div>
      )}

      {mode === 'audit' && traces.length > 0 && (
        <div className="mt-4">
          <TracePanel events={traces} totalMs={totalMs} surface="appropriateness-audit" />
        </div>
      )}

      {mode === 'audit' && caEdit && (
        <div className="mt-5 space-y-5">
          <ExtractedPanel edit={caEdit} setEdit={setCaEdit} onReanalyze={() => { setTraces([]); setTotalMs(undefined); analyzeExtracted(editToExtracted(caEdit)); }} busy={caAnalyzeLoading} />
          {caAnalyzeLoading && !caReport && (
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Auditing the case against guidance and NABH standards…
            </div>
          )}
          {/* Right Care × ClinicalState Slice 1 — additive panel; absent unless CLINICAL_STATE_UI=1. */}
          {caClinicalState && <div className="mb-4"><ClinicalStatePanel state={caClinicalState} /></div>}
          {caReport && <CaseAuditReport report={caReport} extractTraceId={caExtractTraceId} analyzeTraceId={caAnalyzeTraceId} />}
          {caReport && (
            <div className="flex items-center justify-end">
              <button type="button" disabled={dlBusy}
                onClick={() => downloadExcel('audit', { report: caReport, extracted: caEdit ? editToExtracted(caEdit) : null }, null)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                {dlBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Download Excel
              </button>
            </div>
          )}
        </div>
      )}

      {mode === 'check' && error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {mode === 'pathway' && pwError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{pwError}</div>
      )}

      {mode === 'pathway' && traces.length > 0 && (
        <div className="mt-4">
          <TracePanel events={traces} totalMs={totalMs} surface="appropriateness-pathway" />
        </div>
      )}

      {/* Right Care × ClinicalState Slice 1 — additive panel; absent unless CLINICAL_STATE_UI=1. */}
      {mode === 'pathway' && pwClinicalState && (
        <div className="mt-4"><ClinicalStatePanel state={pwClinicalState} /></div>
      )}

      {mode === 'pathway' && pwSkeleton && (
        <div className="mt-5">
          <PathwayTrace
            skeleton={pwSkeleton}
            enrichment={pwEnrichment}
            sources={pwSources}
            enriching={pwEnriching}
            skeletonTraceId={pwSkeletonTraceId}
            enrichTraceId={pwEnrichTraceId}
          />
        </div>
      )}

      {mode === 'pathway' && pwEnrichment && (
        <div className="mt-3 flex items-center justify-end">
          <button type="button" disabled={dlBusy}
            onClick={() => downloadExcel('pathway', { skeleton: pwSkeleton, enrichment: pwEnrichment, sources: pwSources }, scenario)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            {dlBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Download Excel
          </button>
        </div>
      )}

      {mode === 'check' && traces.length > 0 && (
        <div className="mt-4">
          <TracePanel events={traces} totalMs={totalMs} surface="appropriateness-value" />
        </div>
      )}

      {mode === 'check' && result && (
        <div className="mt-5 space-y-5">
          {/* Right Care × ClinicalState Slice 1 — additive panel; absent unless CLINICAL_STATE_UI=1. */}
          {result.clinicalState && <ClinicalStatePanel state={result.clinicalState} />}
          <div className="flex items-center justify-end">
            <button type="button" disabled={dlBusy}
              onClick={() => downloadExcel('check', { valueAnalysis: result.valueAnalysis, valueSources: result.valueSources, flags: result.flags, candidates: result.candidates, considered: result.considered }, scenario)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              {dlBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Download Excel
            </button>
          </div>
          {result.valueAnalysis && result.valueAnalysis.interventions.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-xs text-slate-500">
                <Scale className="h-3.5 w-3.5" /> Value analysis
              </div>
              {result.valueAnalysis.tariffs && result.valueAnalysis.tariffs.length > 0 && (
                <TariffBanner tariffs={result.valueAnalysis.tariffs} />
              )}
              <div className="space-y-3">
                {result.valueAnalysis.interventions.map((iv, i) => <ValueCard key={i} iv={iv} sources={result.valueSources} />)}
              </div>
              {result.valueSources && result.valueSources.length > 0 && <SourcesPanel sources={result.valueSources} />}
              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{result.valueAnalysis.disclaimer || VALUE_DISCLAIMER}</p>
            </div>
          )}

          {visibleFlags.length > 0 ? (
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-xs text-slate-500">
                <Flag className="h-3.5 w-3.5" />
                {visibleFlags.length} Choosing Wisely flag{visibleFlags.length === 1 ? '' : 's'}
              </div>
              <div className="space-y-3">
                {visibleFlags.map((f) => (
                  <FlagCard key={f.id} flag={f} onDismiss={() => setDismissed((d) => ({ ...d, [f.id]: true }))} />
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
              {result.valueAnalysis
                ? <>No specific Choosing Wisely list match for this order — the value analysis above is the assessment.</>
                : <><span className="font-medium text-slate-800">No low-value-care flags identified for this scenario.</span> Absence of a flag isn&apos;t an endorsement — it means nothing low-value was matched
                    {result.considered > 0 ? ` (checked ${result.considered} candidate recommendation${result.considered === 1 ? '' : 's'}).` : '.'}</>}
            </div>
          )}

          {(result.valueTraceId || result.traceId) && (
            <div className="flex gap-4 text-xs text-slate-400">
              {result.valueTraceId && (
                <a href={`/admin/observability/${result.valueTraceId}`} className="inline-flex items-center gap-1 hover:text-slate-600">
                  <Info className="h-3 w-3" /> Value trace
                </a>
              )}
              {result.traceId && (
                <a href={`/admin/observability/${result.traceId}`} className="inline-flex items-center gap-1 hover:text-slate-600">
                  <Info className="h-3 w-3" /> Flag trace
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FlagCard({ flag, onDismiss }: { flag: LvcFlag; onDismiss: () => void }) {
  const href = flag.citation.url
    || (flag.citation.doi ? `https://doi.org/${flag.citation.doi}` : null)
    || (flag.citation.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${flag.citation.pmid}/` : null);
  return (
    <div className="rounded-r-xl border border-l-0 border-slate-200 border-l-[3px] border-l-amber-500 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-medium leading-snug text-slate-900">{flag.statement}</div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${REGION_BADGE[flag.region] ?? 'bg-slate-100 text-slate-700'}`}>{flag.region}</span>
          <span className="text-[11px] text-slate-400">conf {flag.confidence.toFixed(2)}</span>
          <button type="button" onClick={onDismiss} aria-label="dismiss" className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
        </div>
      </div>

      {flag.why_it_applies && (
        <p className="mt-2.5 text-[13px] leading-relaxed text-slate-600">
          <span className="font-medium text-slate-900">Why it applies here:</span> {flag.why_it_applies}
        </p>
      )}
      {flag.consider_instead && (
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          <span className="font-medium text-slate-900">Consider instead:</span> {flag.consider_instead}
        </p>
      )}

      <div className="mt-2.5 flex items-center justify-between border-t border-slate-100 pt-2 text-[11.5px] text-slate-400">
        <span>{flag.society}{flag.citation.year ? ` · ${flag.citation.year}` : ''}</span>
        {href && (
          <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
            Source <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

const NET_BADGE: Record<NetValue, string> = {
  'high-value': 'bg-teal-50 text-teal-800',
  'context-dependent': 'bg-amber-50 text-amber-800',
  'low-value': 'bg-red-50 text-red-800',
  uncertain: 'bg-slate-100 text-slate-700',
};
const NET_LABEL: Record<NetValue, string> = {
  'high-value': 'High value', 'context-dependent': 'Context-dependent', 'low-value': 'Low value', uncertain: 'Uncertain',
};

function DimBar({ label, level, tone }: { label: string; level: Level; tone: 'benefit' | 'burden' }) {
  const score = levelToScore(level);
  const fill = tone === 'benefit' ? 'bg-teal-500' : 'bg-amber-500';
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-[11px] text-slate-500">{label}</span>
      <div className="flex gap-1">
        {[1, 2, 3].map((n) => (
          <span key={n} className={`h-2.5 w-7 rounded-sm ${n <= score ? fill : 'bg-slate-200'}`} />
        ))}
      </div>
      <span className="text-[11px] capitalize text-slate-500">{level}</span>
    </div>
  );
}

function DimDetail({ label, d }: { label: string; d: { level: Level; detail: string } }) {
  if (!d.detail) return null;
  return <p><span className="font-medium text-slate-900">{label}:</span> {d.detail}</p>;
}

function ValueCard({ iv, sources }: { iv: ValueIntervention; sources?: Source[] }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-medium leading-snug text-slate-900">{iv.intervention}</div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${NET_BADGE[iv.net_value]}`}>{NET_LABEL[iv.net_value]}</span>
          <span className="text-[11px] text-slate-400">conf {iv.confidence.toFixed(2)}</span>
        </div>
      </div>

      {iv.summary && <p className="mt-2 text-[13px] leading-relaxed text-slate-700">{iv.summary}</p>}

      {iv.citation_ids && iv.citation_ids.length > 0 && sources && sources.length > 0 && (
        <CitationChips ids={iv.citation_ids} sources={sources} />
      )}

      <div className="mt-3 space-y-1.5 rounded-lg bg-slate-50 p-3">
        <DimBar label="Long-term benefit" level={iv.long_term_benefit.level} tone="benefit" />
        <DimBar label="Harms / risks" level={iv.harms_risks.level} tone="burden" />
        <DimBar label="Upfront cost" level={iv.upfront_cost.level} tone="burden" />
        <DimBar label="Long-term care" level={iv.long_term_care.level} tone="burden" />
      </div>

      <div className="mt-3 space-y-2 text-[12.5px] leading-relaxed text-slate-600">
        <DimDetail label="Long-term benefit" d={iv.long_term_benefit} />
        <DimDetail label="Harms / risks" d={iv.harms_risks} />
        <DimDetail label="Upfront cost" d={iv.upfront_cost} />
        <DimDetail label="Long-term care needs" d={iv.long_term_care} />
      </div>

      {iv.alternatives.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Alternatives</div>
          <ul className="mt-1 space-y-1">
            {iv.alternatives.map((a, i) => (
              <li key={i} className="text-[12.5px] text-slate-600"><span className="font-medium text-slate-800">{a.name}</span>{a.note ? ` — ${a.note}` : ''}</li>
            ))}
          </ul>
        </div>
      )}

      {iv.what_would_change.length > 0 && (
        <div className="mt-3 flex gap-2 rounded-lg border border-slate-100 bg-slate-50 p-2.5">
          <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
          <div>
            <div className="text-[11px] font-medium text-slate-500">What would change this</div>
            <ul className="mt-0.5 list-disc pl-4 text-[12.5px] text-slate-600">
              {iv.what_would_change.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        </div>
      )}

      {iv.evidence.length > 0 && (
        <div className="mt-3">
          <div className="flex items-center gap-1 text-[11px] font-medium text-slate-500"><BookOpen className="h-3 w-3" /> Evidence</div>
          <ul className="mt-1 list-disc pl-4 text-[12px] text-slate-600">
            {iv.evidence.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

      {iv.estimates.length > 0 && (
        <div className="mt-3 rounded-lg border border-dashed border-amber-300 bg-amber-50 p-2.5">
          <div className="flex items-center gap-1 text-[11px] font-medium text-amber-700"><AlertTriangle className="h-3 w-3" /> Model estimates — not validated</div>
          <ul className="mt-1 list-disc pl-4 text-[12px] text-amber-900">
            {iv.estimates.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function tariffLine(t: TariffRef): string {
  const parts: string[] = [];
  if (t.kind === 'investigation') {
    if (t.opd != null) parts.push(`${inr(t.opd)} OPD`);
    if (t.general != null) parts.push(`${inr(t.general)} general`);
  } else {
    if (t.general != null) parts.push(`${inr(t.general)} general`);
    if (t.private != null) parts.push(`${inr(t.private)} private`);
    if (t.suite != null) parts.push(`${inr(t.suite)} suite`);
  }
  return parts.join(' · ');
}

function TariffBanner({ tariffs }: { tariffs: TariffRef[] }) {
  return (
    <div className="mb-3 rounded-lg border border-teal-200 bg-teal-50 p-3">
      <div className="flex items-center gap-1 text-[11px] font-medium text-teal-800">
        <IndianRupee className="h-3 w-3" /> EHRC charge master — cited tariff (not an estimate)
      </div>
      <ul className="mt-1.5 space-y-1">
        {tariffs.map((t) => (
          <li key={t.code} className="text-[12.5px] text-teal-900">
            <span className="font-medium">{t.item}</span> <span className="text-teal-700">({t.code})</span>: {tariffLine(t)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CaField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      {children}
    </label>
  );
}

const DOC_LABEL: Record<string, string> = {
  discharge_summary: 'Discharge summary', ot_note: 'OT / operative note', opd_rx: 'OPD prescription',
};

function ExtractedPanel({ edit, setEdit, onReanalyze, busy }: { edit: CaEdit; setEdit: (e: CaEdit) => void; onReanalyze: () => void; busy: boolean }) {
  const upd = (k: keyof CaEdit) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setEdit({ ...edit, [k]: e.target.value });
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-medium text-slate-500">Extracted case · editable</div>
        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-800">{DOC_LABEL[edit.detectedDocType] ?? edit.detectedDocType} · conf {edit.confidence.toFixed(2)}</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <CaField label="Diagnosis"><input value={edit.diagnosis} onChange={upd('diagnosis')} className={caInputCls} /></CaField>
        <CaField label="Procedure"><input value={edit.procedure} onChange={upd('procedure')} className={caInputCls} /></CaField>
        <CaField label="Investigations (one per line)"><textarea rows={3} value={edit.investigations} onChange={upd('investigations')} className={caInputCls} /></CaField>
        <CaField label="Medications (one per line)"><textarea rows={3} value={edit.medications} onChange={upd('medications')} className={caInputCls} /></CaField>
      </div>
      <div className="mt-3">
        <CaField label="Course summary"><textarea rows={2} value={edit.courseSummary} onChange={upd('courseSummary')} className={caInputCls} /></CaField>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button onClick={onReanalyze} disabled={busy} type="button"
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardCheck className="h-4 w-4" />} Re-analyze with edits
        </button>
        <span className="text-xs text-slate-400">Correct any mis-read, then re-run the audit (skips re-reading the file).</span>
      </div>
    </div>
  );
}

function srcLabel(s: Source): string {
  return [
    s.book,
    s.chapter || '',
    s.page_start != null ? `p.${s.page_start}` : '',
    (s.item_number && !s.url) ? `#${s.item_number}` : '',
    s.url ? `PMID ${s.item_number}` : '',
  ].filter(Boolean).join(' · ');
}

function CitationChips({ ids, sources }: { ids: number[]; sources: Source[] }) {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const cited = ids.map((n) => byN.get(n)).filter((s): s is Source => !!s);
  if (cited.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[10.5px] uppercase tracking-wide text-slate-400">Cited</span>
      {cited.map((s) => s.url ? (
        <a key={s.n} href={s.url} target="_blank" rel="noopener noreferrer" title={s.preview}
          className="inline-flex items-center gap-0.5 rounded-full border border-teal-200 bg-teal-50 px-1.5 py-0.5 text-[10.5px] font-medium text-teal-800 hover:bg-teal-100">
          [{s.n}] <ExternalLink className="h-2.5 w-2.5" />
        </a>
      ) : (
        <span key={s.n} title={s.preview}
          className="rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-600">[{s.n}]</span>
      ))}
    </div>
  );
}

function SourcesPanel({ sources }: { sources: Source[] }) {
  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
        <BookOpen className="h-3 w-3" /> Sources ({sources.length}) — retrieved from the CDMSS corpus
      </div>
      <ol className="space-y-1.5">
        {sources.map((s) => (
          <li key={s.n} className="text-[12px] leading-relaxed text-slate-600">
            <span className="font-medium text-slate-700">[{s.n}]</span> {srcLabel(s)}
            {s.url && (
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-brand hover:underline">
                PubMed <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
            {s.preview && <span className="block text-[11px] text-slate-400">{s.preview.slice(0, 160)}{s.preview.length > 160 ? '…' : ''}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
