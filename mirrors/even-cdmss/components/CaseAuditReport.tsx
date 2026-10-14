'use client';

import {
  Info, AlertTriangle, IndianRupee, ListChecks, ClipboardCheck, Route, Scale, BookOpen, ShieldAlert,
} from 'lucide-react';
import type { AuditReport, AuditFinding, FieldStatus, PrognosisReport } from '@/lib/doc-audit-core';
import type { PxNetStatus, PxLikelihood, PxSeverity } from '@/lib/prognosis-core';
import type { Source } from '@/lib/citations-core';
import { stripRetiredEvenCitations } from '@/lib/even-ground-core';
import { DOMAIN_SHORT, type ValueScorecard, type Band } from '@/lib/value-score-core';
import {
  inr, MetricCard, Collapsible, SectionTitle, TariffBlock, EvidenceList, EstimatesList,
  CitationChips, SourcesPanel, NET_BADGE, NET_LABEL,
} from '@/components/right-care/kit';

const STATUS_BADGE: Record<FieldStatus, string> = {
  present: 'bg-teal-50 text-teal-800',
  partial: 'bg-amber-50 text-amber-800',
  missing: 'bg-red-50 text-red-800',
  na: 'bg-slate-100 text-slate-500',
};
const STATUS_LABEL: Record<FieldStatus, string> = { present: 'Present', partial: 'Partial', missing: 'Missing', na: 'N/A' };
const STATUS_ORDER: Record<FieldStatus, number> = { missing: 0, partial: 1, na: 2, present: 3 };
/** The six discharge-summary sections (PRD §2.9), plus the OPD/OT ones, rendered plainly. */
const SECTION_LABEL: Record<string, string> = {
  identifiers: 'Identifiers', clinical: 'Clinical', course: 'Course of care',
  followup: 'Follow-up', outcome: 'Outcome', signoff: 'Sign-off',
  documentation: 'Documentation', obstetric: 'Obstetric', continuity: 'Continuity', other: 'Other',
};

const BAND_STYLE: Record<Band, { ring: string; text: string; bg: string; label: string }> = {
  A: { ring: '#0d9488', text: 'text-teal-700', bg: 'bg-teal-50', label: 'Excellent value' },
  B: { ring: '#16a34a', text: 'text-green-700', bg: 'bg-green-50', label: 'Good value' },
  C: { ring: '#d97706', text: 'text-amber-700', bg: 'bg-amber-50', label: 'Mixed value' },
  D: { ring: '#ea580c', text: 'text-orange-700', bg: 'bg-orange-50', label: 'Low value' },
  E: { ring: '#dc2626', text: 'text-red-700', bg: 'bg-red-50', label: 'Poor value' },
};
const barColor = (s: number) => s >= 85 ? 'bg-teal-500' : s >= 70 ? 'bg-green-500' : s >= 55 ? 'bg-amber-500' : s >= 40 ? 'bg-orange-500' : 'bg-red-500';

export default function CaseAuditReport({
  report, extractTraceId, analyzeTraceId, findingActions, retiredEvenIds,
  weightsVersion, weightedCompletenessPct, reviewPanel,
}: {
  report: AuditReport;
  extractTraceId?: string;
  analyzeTraceId?: string;
  /** OPTIONAL per-finding action slot (IPD adjudication). Rendered at the foot of each
   *  FindingCard when provided; when absent the component is byte-identical for every
   *  existing caller (Case-Audit Mode 3 etc.). */
  findingActions?: (f: AuditFinding, i: number) => React.ReactNode;
  /** Retire display-filter (CDMSS-EVEN-LVC-GROUNDING-WORKER §6): ids of retired Even assertions whose
   *  `even-lvc` citations must be hidden. Passed by a data parent that can reach it; omitted/empty ⇒
   *  byte-identical render (no filtering). */
  retiredEvenIds?: string[];
  /** PRD §8.3 / §6.5 — the weights version the displayed documentation number was scored under
   *  (`nabh-weights/discharge_summary/3`). Absent ⇒ the header renders exactly as before. */
  weightsVersion?: string | null;
  /** PRD §6.5 — the WEIGHTED documentation percentage, when the caller has recomputed it. Absent ⇒
   *  the stored `coverage` is shown, i.e. today's behaviour. */
  weightedCompletenessPct?: number | null;
  /** PRD §6.4 — optional "Your review" panel, composed by the caller (a server page cannot pass a
   *  client component's handlers, so this mirrors the existing `findingActions` slot). */
  reviewPanel?: React.ReactNode;
}) {
  // Hide retired Even-LVC citations at render (display-time only; stored citation_ids are untouched).
  // Short-circuits to the original arrays when nothing is retired, so existing callers are unaffected.
  const filtered = retiredEvenIds?.length
    ? stripRetiredEvenCitations(report.findings as never[], (report.sources ?? []) as never[], retiredEvenIds)
    : { findings: report.findings, sources: report.sources };
  const renderFindings = filtered.findings as AuditFinding[];
  const renderSources = filtered.sources as Source[] | undefined;
  const c = report.completeness;
  const sc = report.valueScore;
  const flagged = report.findings.filter((f) => f.verdict === 'low-value' || f.verdict === 'context-dependent').length;
  const presentCount = c.items.filter((i) => i.status === 'present' || i.status === 'na').length;
  const avoidable = (sc?.lowValueSpend ?? 0) + (sc?.excessBedDayCost ?? 0);
  const overuse = report.diff.filter((d) => d.kind === 'overuse');
  const gaps = report.diff.filter((d) => d.kind === 'gap');
  const fixes = [...report.suggestions].sort((a, b) => a.priority - b.priority);
  const pct = Math.round(c.coverage * 100);
  // §6.5 — the weighted number when the caller supplies one, else exactly today's value.
  const shownPct = weightedCompletenessPct == null ? pct : weightedCompletenessPct;
  // The unweighted gap count. `missingMandatory` is the engine's own list; fall back to counting
  // `missing` items so this is right even on an older stored report that lacks the field.
  const gapCount = c.missingMandatory?.length ?? c.items.filter((i) => i.status === 'missing').length;
  // Group by the item's own `section`, preserving first-seen order (the rubric's order).
  const sections = (() => {
    const order: string[] = [];
    const map = new Map<string, typeof c.items>();
    for (const it of c.items) {
      const key = it.section || 'other';
      if (!map.has(key)) { map.set(key, [] as unknown as typeof c.items); order.push(key); }
      (map.get(key) as unknown as typeof c.items[number][]).push(it);
    }
    return order.map((section) => ({
      section,
      // Within a section, worst first — the same STATUS_ORDER the flat list used.
      rows: [...(map.get(section) as unknown as typeof c.items[number][])].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]),
    }));
  })();

  return (
    <div className="space-y-4">
      {/* ── Verdict header: read the bottom line in two seconds ── */}
      {sc ? (
        <VerdictHeader sc={sc} avoidable={avoidable} flagged={flagged} pct={shownPct} extractTraceId={extractTraceId} analyzeTraceId={analyzeTraceId} />
      ) : (
        <TraceRow extractTraceId={extractTraceId} analyzeTraceId={analyzeTraceId} />
      )}

      {/* ── Key-number strip: money first ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard
          label="Avoidable spend"
          value={avoidable > 0 ? inr(avoidable) : '—'}
          sub={avoidable > 0 ? costParts(sc) : 'none tariffed'}
          tone={avoidable > 0 ? 'bad' : 'good'}
        />
        <MetricCard label="Completeness" value={`${shownPct}%`} sub={`${presentCount}/${c.items.length} fields · ${gapCount} mandatory gap${gapCount === 1 ? '' : 's'}`} tone={shownPct >= 85 ? 'good' : shownPct >= 60 ? 'warn' : 'bad'} />
        <MetricCard label="Flagged decisions" value={String(flagged)} sub="appropriateness / low-value" tone={flagged === 0 ? 'good' : 'bad'} />
        <MetricCard label="Idealised gaps" value={String(report.diff.length)} sub={`${overuse.length} over-use · ${gaps.length} missed`} tone="neutral" />
      </div>

      {/* Stay facts (non-identifying) */}
      {report.adminFacts && (report.adminFacts.lengthOfStayDays != null || report.adminFacts.admissionType || report.adminFacts.careSetting) && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-slate-500">
          <span className="font-medium text-slate-600">Stay facts</span>
          {report.adminFacts.lengthOfStayDays != null && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5">Length of stay: {report.adminFacts.lengthOfStayDays} day{report.adminFacts.lengthOfStayDays === 1 ? '' : 's'}</span>
          )}
          {report.adminFacts.admissionType && <span className="rounded-full bg-slate-100 px-2 py-0.5 capitalize">{report.adminFacts.admissionType}</span>}
          {report.adminFacts.careSetting && <span className="rounded-full bg-slate-100 px-2 py-0.5 capitalize">{report.adminFacts.careSetting.replace(/_/g, ' ')}</span>}
          <span className="text-slate-400">· informs the value findings, not stored as dates</span>
        </div>
      )}

      {/* ── Care-Value breakdown: radar + per-domain bars + cost detail ── */}
      {sc && <BreakdownPanel sc={sc} />}

      {/* ── Top fixes: the actionable punchline, elevated ── */}
      {fixes.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-teal-200">
          <div className="flex items-center gap-1.5 border-b border-teal-100 bg-teal-50/70 px-3.5 py-2 text-[12.5px] font-medium text-teal-800">
            <ListChecks className="h-3.5 w-3.5" /> Top fixes — highest priority first
          </div>
          <ol className="divide-y divide-slate-100 bg-white">
            {fixes.map((s, i) => (
              <li key={i} className="flex gap-2.5 px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-700">
                <span className="font-medium text-teal-700">{i + 1}</span>
                <span className="flex-1">{s.text}{s.ref ? <span className="text-[11px] text-slate-400"> · {s.ref}</span> : null}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* ── Flagged decisions ── */}
      {report.findings.length > 0 && (
        <section>
          <SectionTitle icon={<AlertTriangle className="h-3.5 w-3.5" />} text="Appropriateness & low-value decisions" />
          <div className="space-y-3">
            {renderFindings.map((f, i) => <FindingCard key={i} f={f} sources={renderSources} actions={findingActions?.(f, i)} />)}
          </div>
        </section>
      )}

      {/* ── PX: Foreseeable outcomes & safety-netting (PRD v1.0) — absent on old runs / flag off ── */}
      {report.prognosis && <PrognosisSection px={report.prognosis} sources={renderSources} />}

      {/* ── Idealised course vs actual ── */}
      <section>
        <SectionTitle icon={<Route className="h-3.5 w-3.5" />} text="Idealised course vs actual" />
        {report.idealisedSummary && <p className="mb-2 text-[13px] leading-relaxed text-slate-700">{report.idealisedSummary}</p>}
        {report.idealisedStages && report.idealisedStages.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {report.idealisedStages.map((s) => (
              <span key={s.id} className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11.5px] text-slate-600">{s.title}</span>
            ))}
          </div>
        )}
        {report.diff.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <DiffCol title="Done — not needed" tone="bad" items={overuse} />
            <DiffCol title="Ideal — but missing" tone="warn" items={gaps} />
          </div>
        )}
      </section>

      {/* ── §6.5 — the field list Dr. Binita could not find. Grouped by the six NABH sections,
             carrying the extractor's note, with BOTH headline numbers side by side. ── */}
      <Collapsible title="Documentation completeness (NABH AAC.14)" icon={<ClipboardCheck className="h-3.5 w-3.5" />} count={`${presentCount}/${c.items.length}`}>
        <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12.5px]">
          <span className="font-semibold text-slate-900">Documentation {shownPct}%</span>
          {weightsVersion && <span className="text-[11.5px] text-slate-400">(weighted, <span className="font-mono">{weightsVersion}</span>)</span>}
          <span className="text-slate-300">·</span>
          {/* The UNWEIGHTED count, deliberately alongside: weighting moves the percentage, it never
              changes how many mandatory fields are actually absent. */}
          <span className="font-semibold text-slate-900">NABH mandatory gaps: {gapCount} of {c.mandatoryTotal}</span>
        </div>
        {sections.map(({ section, rows }) => (
          <div key={section} className="mb-2.5 last:mb-0">
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-slate-400">{SECTION_LABEL[section] ?? section}</div>
            <div className="overflow-hidden rounded-lg border border-slate-200">
              {rows.map((it, i) => (
                <div key={it.key} className={`px-3 py-2 ${i ? 'border-t border-slate-100' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-[13px] text-slate-800">
                      {it.label} <span className="ml-0.5 rounded border border-slate-200 px-1 py-px text-[10px] text-slate-400">{it.ref}</span>
                    </span>
                    <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_BADGE[it.status]}`}>{STATUS_LABEL[it.status]}</span>
                  </div>
                  {it.note && <div className="mt-0.5 text-[11.5px] leading-relaxed text-slate-500">{it.note}</div>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </Collapsible>

      {reviewPanel}

      {renderSources && renderSources.length > 0 && (
        <Collapsible title="Sources — retrieved from the CDMSS corpus" icon={<BookOpen className="h-3.5 w-3.5" />} count={renderSources.length}>
          <SourcesPanel sources={renderSources} />
        </Collapsible>
      )}

      <p className="text-[11px] leading-relaxed text-slate-400">{report.disclaimer}</p>
    </div>
  );
}

function costParts(sc?: ValueScorecard): string {
  if (!sc) return '';
  const p: string[] = [];
  if (sc.excessBedDayCost) p.push('bed-days');
  if (sc.lowValueSpend) p.push('low-value');
  return p.length ? p.join(' + ') : 'tariffed';
}

function TraceRow({ extractTraceId, analyzeTraceId }: { extractTraceId?: string; analyzeTraceId?: string }) {
  if (!extractTraceId && !analyzeTraceId) return null;
  return (
    <div className="flex gap-4 text-xs text-slate-400">
      {extractTraceId && <a href={`/admin/observability/${extractTraceId}`} className="inline-flex items-center gap-1 hover:text-slate-600"><Info className="h-3 w-3" /> Extract trace</a>}
      {analyzeTraceId && <a href={`/admin/observability/${analyzeTraceId}`} className="inline-flex items-center gap-1 hover:text-slate-600"><Info className="h-3 w-3" /> Audit trace</a>}
    </div>
  );
}

function VerdictHeader({ sc, avoidable, flagged, pct, extractTraceId, analyzeTraceId }: {
  sc: ValueScorecard; avoidable: number; flagged: number; pct: number; extractTraceId?: string; analyzeTraceId?: string;
}) {
  const b = BAND_STYLE[sc.band];
  return (
    <section className={`rounded-xl border border-slate-200 ${b.bg} p-4`}>
      <div className="flex items-start gap-4">
        <div className="flex h-[68px] w-[68px] shrink-0 flex-col items-center justify-center rounded-full border-4 bg-white" style={{ borderColor: b.ring }}>
          <span className={`text-[22px] font-semibold leading-none ${b.text}`}>{sc.headline}</span>
          <span className="text-[10px] text-slate-400">/ 100</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Scale className={`h-4 w-4 ${b.text}`} />
            <span className={`text-[17px] font-semibold leading-tight ${b.text}`}>Band {sc.band} · {b.label}</span>
            <span className="rounded-full bg-white/70 px-2 py-0.5 text-[10.5px] font-medium text-slate-500">{sc.confidence} confidence</span>
            {(extractTraceId || analyzeTraceId) && (
              <span className="ml-auto flex items-center gap-3 text-[11px] text-slate-400">
                {extractTraceId && <a href={`/admin/observability/${extractTraceId}`} className="inline-flex items-center gap-1 hover:text-slate-600"><Info className="h-3 w-3" /> Extract</a>}
                {analyzeTraceId && <a href={`/admin/observability/${analyzeTraceId}`} className="inline-flex items-center gap-1 hover:text-slate-600"><Info className="h-3 w-3" /> Trace</a>}
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-slate-600">
            {avoidable > 0 && (
              <span className="inline-flex items-center gap-1"><IndianRupee className="h-3.5 w-3.5 text-red-600" /><span className="font-semibold text-red-700">{inr(avoidable)}</span> potentially avoidable</span>
            )}
            {avoidable > 0 && <span className="text-slate-300">·</span>}
            <span>{flagged} flagged decision{flagged === 1 ? '' : 's'}</span>
            <span className="text-slate-300">·</span>
            <span>completeness {pct}%</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function ValueRadar({ sc }: { sc: ValueScorecard }) {
  const size = 168, cx = size / 2, cy = size / 2, R = 58;
  const doms = sc.domains;
  const n = doms.length;
  const pt = (i: number, r: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  };
  const ring = (frac: number) => doms.map((_, i) => pt(i, R * frac).join(',')).join(' ');
  const shape = doms.map((d, i) => pt(i, R * Math.max(0, Math.min(100, d.score)) / 100).join(',')).join(' ');
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="shrink-0">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <polygon key={f} points={ring(f)} fill="none" stroke="#e5e7eb" strokeWidth="1" />
      ))}
      {doms.map((_, i) => { const [x, y] = pt(i, R); return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="#e5e7eb" strokeWidth="1" />; })}
      <polygon points={shape} fill="#0d948833" stroke="#0d9488" strokeWidth="1.5" />
      {doms.map((d, i) => {
        const [x, y] = pt(i, R + 12);
        return <text key={d.domain} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className="fill-slate-500" style={{ fontSize: 8.5 }}>{DOMAIN_SHORT[d.domain]}</text>;
      })}
    </svg>
  );
}

function BreakdownPanel({ sc }: { sc: ValueScorecard }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <SectionTitle icon={<Scale className="h-3.5 w-3.5" />} text="Care-Value breakdown" />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="mx-auto sm:mx-0"><ValueRadar sc={sc} /></div>
        <div className="flex-1 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {sc.domains.map((d) => (
            <div key={d.domain}>
              <div className="flex items-baseline justify-between text-[12px]">
                <span className="text-slate-700">{d.label}</span>
                <span className="font-medium text-slate-900">{Math.round(d.score)}</span>
              </div>
              <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div className={`h-full rounded-full ${barColor(d.score)}`} style={{ width: `${Math.max(0, Math.min(100, d.score))}%` }} />
              </div>
              <div className="mt-0.5 text-[10.5px] text-slate-400">{d.basis}</div>
            </div>
          ))}
        </div>
      </div>

      {(sc.lowValueSpend != null || sc.excessBedDayCost != null || sc.roomCategoryInflation != null) && (
        <div className="mt-3 space-y-0.5 border-t border-slate-100 pt-2.5 text-[11.5px]">
          {sc.lowValueSpend != null && (
            <div className="inline-flex items-center gap-1 text-slate-600"><IndianRupee className="h-3 w-3" />{inr(sc.lowValueSpend)} tariffed low-value spend</div>
          )}
          {sc.excessBedDayCost != null && (
            <div className="text-amber-700">+ {inr(sc.excessBedDayCost)} {sc.costNote ? `· ${sc.costNote}` : 'avoidable bed-days'}</div>
          )}
          {sc.roomCategoryInflation != null && (
            <div className="text-slate-500">+ {inr(sc.roomCategoryInflation)} vs general-ward rates for the same orders{sc.roomTier ? ` · ${sc.roomTier} category` : ''} <span className="text-slate-400">(informational)</span></div>
          )}
        </div>
      )}

      <p className="mt-3 text-[10.5px] leading-relaxed text-slate-400">{sc.caveat}</p>
    </section>
  );
}

function FindingCard({ f, sources, actions }: { f: AuditFinding; sources?: Source[]; actions?: React.ReactNode }) {
  const border = f.verdict === 'low-value' ? 'border-l-red-500' : f.verdict === 'context-dependent' ? 'border-l-amber-500' : 'border-l-slate-300';
  return (
    <div className={`rounded-r-xl border border-l-[3px] border-slate-200 bg-white p-4 ${border}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-medium leading-snug text-slate-900">{f.subject}</div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${NET_BADGE[f.verdict]}`}>{NET_LABEL[f.verdict]}</span>
          <span className="text-[11px] text-slate-400">conf {f.confidence.toFixed(2)}</span>
        </div>
      </div>
      {f.rationale && <p className="mt-2 text-[13px] leading-relaxed text-slate-700">{f.rationale}</p>}
      {f.citation_ids && f.citation_ids.length > 0 && sources && sources.length > 0 && <CitationChips ids={f.citation_ids} sources={sources} />}
      {f.tariffs && f.tariffs.length > 0 && <TariffBlock tariffs={f.tariffs} />}
      <EvidenceList items={f.evidence} />
      <EstimatesList items={f.estimates} />
      {actions}
    </div>
  );
}

// ── PX: Foreseeable outcomes & safety-netting ─────────────────────────────────

const PX_STATUS_BADGE: Record<PxNetStatus, string> = {
  mitigated: 'bg-teal-50 text-teal-800',
  partially_mitigated: 'bg-amber-50 text-amber-800',
  unmitigated: 'bg-red-100 text-red-800',
  not_assessable: 'bg-slate-100 text-slate-500',
};
const PX_STATUS_LABEL: Record<PxNetStatus, string> = {
  mitigated: 'Mitigated', partially_mitigated: 'Partially mitigated', unmitigated: 'Unmitigated', not_assessable: 'Not assessable',
};
const PX_LIKELIHOOD_BADGE: Record<PxLikelihood, string> = {
  common: 'bg-red-50 text-red-700', uncommon: 'bg-amber-50 text-amber-800', rare: 'bg-slate-100 text-slate-500',
};
const PX_SEVERITY_LABEL: Record<PxSeverity, string> = { minor: 'minor', moderate: 'moderate', serious: 'serious' };

function PrognosisSection({ px, sources }: { px: PrognosisReport; sources?: Source[] }) {
  return (
    <section className="overflow-hidden rounded-xl border border-indigo-200">
      <div className="border-b border-indigo-100 bg-indigo-50/70 px-3.5 py-2">
        <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-indigo-900">
          <ShieldAlert className="h-3.5 w-3.5" /> Foreseeable outcomes & safety-netting
          {px.n_unmitigated > 0 && <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10.5px] font-semibold text-red-800">{px.n_unmitigated} unmitigated</span>}
        </div>
        <div className="mt-0.5 text-[11.5px] text-indigo-900/70">{px.summary}</div>
      </div>
      <div className="space-y-4 bg-white p-3.5">

        {px.complications.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-slate-400">Anticipated complications · ranked by likelihood × severity</div>
            <div className="space-y-2">
              {px.complications.map((c, i) => (
                <div key={i} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-slate-900">{c.complication}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${PX_LIKELIHOOD_BADGE[c.likelihood]}`}>{c.likelihood}</span>
                    <span className="text-[10.5px] text-slate-400">{PX_SEVERITY_LABEL[c.severity]}{c.horizon ? ` · ${c.horizon}` : ''}</span>
                    {c.incidence_note && <span className="text-[10.5px] text-slate-500">{c.incidence_note}</span>}
                  </div>
                  {c.modifiers.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {c.modifiers.map((m, j) => (
                        <span key={j} className={`rounded-full px-2 py-0.5 text-[10.5px] ${m.direction === 'raises' ? 'bg-red-50 text-red-700' : 'bg-teal-50 text-teal-700'}`}>
                          {m.direction === 'raises' ? '↑' : '↓'} {m.factor}
                        </span>
                      ))}
                    </div>
                  )}
                  {c.citation_ids.length > 0 && sources && sources.length > 0 && <CitationChips ids={c.citation_ids} sources={sources} />}
                  <EvidenceList items={c.evidence} />
                  <EstimatesList items={c.estimates} />
                </div>
              ))}
            </div>
          </div>
        )}

        {px.benefit && (
          <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-slate-400">Expected benefit — and what failure looks like</div>
            <div className="text-[13px] leading-relaxed text-slate-700">
              {px.benefit.intended_benefit}
              {px.benefit.time_to_benefit ? <span className="text-slate-500"> · typically {px.benefit.time_to_benefit}</span> : null}
              {px.benefit.success_rate_note ? <span className="text-slate-500"> · {px.benefit.success_rate_note}</span> : null}
            </div>
            {px.benefit.failure_signature && (
              <div className="mt-1.5 text-[12.5px] text-slate-700"><span className="font-medium text-amber-800">Failure signature · </span>{px.benefit.failure_signature}</div>
            )}
            <div className="mt-1.5 text-[11.5px]">
              <span className="text-slate-500">Recovery expectations documented for the patient: </span>
              <span className={`rounded-full px-2 py-0.5 font-medium ${px.benefit.documented_expectation_setting === 'present' ? 'bg-teal-50 text-teal-800' : px.benefit.documented_expectation_setting === 'partial' ? 'bg-amber-50 text-amber-800' : 'bg-red-100 text-red-800'}`}>{px.benefit.documented_expectation_setting}</span>
            </div>
            {px.benefit.citation_ids.length > 0 && sources && sources.length > 0 && <CitationChips ids={px.benefit.citation_ids} sources={sources} />}
            <EvidenceList items={px.benefit.evidence} />
            <EstimatesList items={px.benefit.estimates} />
          </div>
        )}

        {px.safetyNet.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-slate-400">Safety-net audit · fitness, not presence — a mitigation counts only if it matches the named risk</div>
            <div className="overflow-hidden rounded-lg border border-slate-200">
              {px.safetyNet.map((r, i) => (
                <div key={i} className={`px-3 py-2.5 ${i ? 'border-t border-slate-100' : ''} ${r.status === 'unmitigated' ? 'bg-red-50/50' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-[13px] font-medium text-slate-900">{r.risk}</span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${PX_STATUS_BADGE[r.status]}`}>{PX_STATUS_LABEL[r.status]}</span>
                  </div>
                  <div className="mt-1 grid gap-x-6 gap-y-0.5 text-[12px] sm:grid-cols-2">
                    <div><span className="text-slate-400">Expected: </span><span className="text-slate-600">{r.expected_mitigation}</span></div>
                    <div><span className="text-slate-400">In document: </span><span className={r.found_in_document ? 'text-slate-600' : 'italic text-red-700'}>{r.found_in_document ?? 'nothing matching'}</span></div>
                  </div>
                  {r.note && <div className="mt-0.5 text-[11px] text-slate-500">{r.note}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="text-[10.5px] leading-relaxed text-slate-400">{px.disclaimer}</p>
      </div>
    </section>
  );
}

function DiffCol({ title, tone, items }: { title: string; tone: 'bad' | 'warn'; items: { text: string; ref?: string }[] }) {
  const cls = tone === 'bad' ? 'border-red-200 bg-red-50 text-red-900' : 'border-amber-200 bg-amber-50 text-amber-900';
  const head = tone === 'bad' ? 'text-red-700' : 'text-amber-700';
  return (
    <div className={`rounded-xl border ${cls} p-3`}>
      <div className={`mb-1.5 text-[11px] font-medium ${head}`}>{title}</div>
      {items.length === 0 ? (
        <div className="text-[12px] text-slate-500">None identified.</div>
      ) : (
        <ul className="list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed">
          {items.map((d, i) => <li key={i}>{d.text}{d.ref ? <span className="text-[11px] opacity-70"> · {d.ref}</span> : null}</li>)}
        </ul>
      )}
    </div>
  );
}
