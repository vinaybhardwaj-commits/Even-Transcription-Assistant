'use client';

// MemberState clinical-state substrate (member-present/0.2) — the WORKSPACE full panel (mockup v2).
// Read-only render of the frozen, Stage-1-validated MemberStateSnapshot (via /api/care/member-state)
// PLUS a read-only vitals/modality side-channel passed as props by the page loader (Decision C — the
// vitals never enter the snapshot). DETERMINISTIC: every value is computed/provable; NO AI inference.
// Order (mockup v2): confidence header → vitals/stability → needs-attention → problems (tiered) →
// meds → labs (abnormal+trend surfaced, full collapsible) → care gaps → allergies.

import { useEffect, useState } from 'react';
import { Loader2, ShieldCheck, AlertTriangle, Pill, Ban, HeartPulse, Activity, FlaskConical, Repeat, CircleHelp } from 'lucide-react';
import type { MemberStateView, StateTone } from '@/lib/member-state/present-core';
import type { MemberVitals } from '@/lib/member-state/vitals-read';
import { computePictureConfidence, buildVitalsView, type Dot, type ProblemTier } from '@/lib/member-state/present-augment';
import { EMPTY_MODALITY } from '@/lib/member-state/present-augment';

const TONE: Record<StateTone['tone'], string> = {
  ok: 'bg-emerald-50 text-emerald-800',
  active: 'bg-teal-50 text-teal-800',
  uncertain: 'bg-amber-50 text-amber-700',
  stopped: 'bg-slate-100 text-slate-600',
  warn: 'bg-orange-50 text-orange-800',
  critical: 'bg-rose-50 text-rose-800',
  muted: 'bg-slate-100 text-slate-500',
};
export function Badge({ t }: { t: StateTone }) {
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold ${TONE[t.tone]}`}>{t.label}</span>;
}

export function useMemberState(query: string) {
  const [view, setView] = useState<MemberStateView | null>(null);
  const [individualUid, setIndividualUid] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  useEffect(() => {
    let alive = true;
    setState('loading');
    fetch(`/api/care/member-state?${query}`)
      .then(async (r) => (r.ok ? r.json() : { __status: r.status }))
      .then((j) => {
        if (!alive) return;
        if (j?.ok && j.view) { setView(j.view); setIndividualUid(j.individualUid ?? null); setState('ready'); }
        else if (j?.__status === 404) setState('empty');
        else setState('error');
      })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [query]);
  return { view, individualUid, state };
}

// ── small presentational atoms ──
const DOT: Record<Dot, string> = { r: 'bg-rose-500', a: 'bg-amber-400', g: 'bg-emerald-500' };
const LEVEL: Record<string, string> = {
  THIN: 'bg-rose-50 text-rose-700 ring-rose-200',
  PARTIAL: 'bg-amber-50 text-amber-700 ring-amber-200',
  GOOD: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
};
const BAND_TEXT: Record<string, string> = {
  critical: 'text-rose-700', high: 'text-orange-700', low: 'text-amber-700', borderline: 'text-amber-700',
  abnormal: 'text-amber-700', normal: 'text-slate-500',   // 'abnormal' = source-flagged, no invented severity
};
const TIER_LABEL: Record<ProblemTier, string> = { active: 'Active / recent', background: 'Background', historical: 'Historical / incidental' };
const TIER_TAG: Record<ProblemTier, string> = { active: 'bg-teal-50 text-teal-700', background: 'bg-slate-100 text-slate-600', historical: 'bg-slate-50 text-slate-400' };

function SectionHead({ icon: Icon, title, sub }: { icon: typeof Activity; title: string; sub?: string }) {
  return (
    <div className="mb-2 flex items-baseline gap-1.5">
      <Icon className="h-4 w-4 shrink-0 translate-y-0.5 text-slate-400" />
      <span className="text-[13px] font-semibold text-slate-800">{title}</span>
      {sub && <span className="text-[11.5px] font-normal text-slate-400">· {sub}</span>}
    </div>
  );
}

export default function MemberStatePanel({ individualUid, vitals }: { individualUid: string; vitals?: MemberVitals }) {
  const { view, state } = useMemberState(`individual_uid=${encodeURIComponent(individualUid)}`);
  if (state === 'empty' || state === 'error') return null;   // never block the dossier

  const modality = vitals?.modality ?? EMPTY_MODALITY;
  const confidence = view
    ? computePictureConfidence({
        lastContact: view.confidence.lastContact,
        vitalsEver: !!vitals?.latest,
        modalityMix: modality,
        lastLab: view.confidence.lastLab,
        problems: view.confidence.problems,
        encounters: { opd: modality.total, ipd: 0 },
      }, view.confidence.now)
    : null;
  const vitalsView = buildVitalsView(vitals?.latest ?? null, modality);

  const tiers: ProblemTier[] = ['active', 'background', 'historical'];
  const surfacedAnalytes = new Set((view?.flaggedLabs.surfaced ?? []).map((l) => l.analyte));
  const withinRange = (view?.investigations ?? []).filter((iv) => !surfacedAnalytes.has(iv.analyte));

  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-slate-200 px-4 py-3">
        <ShieldCheck className="h-4 w-4 text-teal-600" />
        <span className="text-[14px] font-semibold text-slate-800">Clinical state</span>
        <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-700">validated · advisory</span>
        {view && (
          <span className="ml-auto text-[11px] text-slate-400">
            as of {view.asOf} · {view.versions.reconciliation} · {view.counts.problems}p/{view.counts.medications}m/{view.counts.allergies}a/{view.counts.investigations}i
          </span>
        )}
      </div>

      <div className="space-y-5 px-4 py-4">
        {state === 'loading' && <div className="flex items-center gap-2 py-4 text-[12.5px] text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Building validated clinical state…</div>}

        {view && confidence && (
          <>
            {/* ── Picture confidence ─────────────────────────────────────── */}
            <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12.5px] font-semibold text-slate-700">◐ How complete is this picture?</span>
                <span className="text-[11px] text-slate-400">· computed from what we do and don’t have</span>
                <span className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${LEVEL[confidence.level]}`}>{confidence.level}</span>
                <span className="text-[11px] text-slate-400">{confidence.caption}</span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div className={`h-full rounded-full ${confidence.level === 'GOOD' ? 'bg-emerald-400' : confidence.level === 'PARTIAL' ? 'bg-amber-400' : 'bg-gradient-to-r from-rose-500 to-amber-400'}`} style={{ width: `${confidence.barPct}%` }} />
              </div>
              <div className="mt-2.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {confidence.factors.map((f) => (
                  <div key={f.key} className="flex items-center gap-2 text-[11.5px] text-slate-600">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${f.counted ? DOT[f.dot] : 'bg-slate-300'}`} />
                    {f.label}
                  </div>
                ))}
              </div>
            </div>

            {/* ── Vitals & stability ─────────────────────────────────────── */}
            <div>
              <SectionHead icon={HeartPulse} title="💓 Vitals & stability" sub={vitalsView.hasVitals ? `measured ${vitalsView.measuredAt}` : 'none measured for this member'} />
              {vitalsView.hasVitals ? (
                <>
                  <div className="flex flex-wrap gap-2">
                    {vitalsView.items.map((it, i) => (
                      <div key={i} className={`min-w-[92px] rounded-lg border px-2.5 py-1.5 ${it.flag ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-slate-50/60'}`}>
                        <div className="text-[10px] uppercase tracking-wide text-slate-400">{it.label}</div>
                        <div className={`text-[13.5px] font-semibold ${it.flag ? 'text-rose-700' : 'text-slate-700'}`}>{it.value} {it.flag && <span className="text-[11px]">⚑</span>}</div>
                        {it.tag && <div className="text-[10px] text-slate-400">{it.tag.toLowerCase()}</div>}
                      </div>
                    ))}
                  </div>
                  {vitalsView.ews && (
                    <div className={`mt-2.5 flex items-start gap-2.5 rounded-lg border px-3 py-2 ${vitalsView.ews.high ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-slate-50'}`}>
                      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md text-[16px] font-bold ${vitalsView.ews.high ? 'bg-rose-600 text-white' : 'bg-slate-200 text-slate-700'}`}>{vitalsView.ews.score}</span>
                      <span className="text-[11.5px] leading-snug text-slate-600">
                        <b className={vitalsView.ews.high ? 'text-rose-700' : 'text-slate-700'}>Early-warning score {vitalsView.ews.score}{vitalsView.ews.tag ? ` · ${vitalsView.ews.tag}` : ''}</b>{' '}
                        computed upstream from these vitals — the panel surfaces it, it does not re-derive.{vitalsView.ews.desc ? ` ${vitalsView.ews.desc}` : ''}
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/50 px-3 py-2.5 text-[12px] leading-relaxed text-slate-500">
                  {vitalsView.absentNote}{vitalsView.modalityNote ? ` ${vitalsView.modalityNote}` : ''}
                </div>
              )}
            </div>

            {/* ── Needs attention ────────────────────────────────────────── */}
            {view.attentionFlags.length > 0 && (
              <div>
                <SectionHead icon={AlertTriangle} title="⚑ Needs attention" sub="computed flags" />
                <div className="space-y-1.5">
                  {view.attentionFlags.map((f, i) => (
                    <div key={i} className={`flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[12px] ${f.severity === 'safety' ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
                      <span className="mt-px shrink-0">▲</span><span>{f.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Problems (tiered) ──────────────────────────────────────── */}
            {view.problems.length > 0 && (
              <div>
                <SectionHead icon={Activity} title="🩻 Problems" sub={`${view.problems.length} · grouped by recency & recurrence`} />
                <div className="space-y-2.5">
                  {tiers.map((tier) => {
                    const rows = view.problems.filter((p) => p.tier === tier);
                    if (!rows.length) return null;
                    return (
                      <div key={tier}>
                        <div className="mb-1 text-[10.5px] font-bold uppercase tracking-wide text-slate-400">{TIER_LABEL[tier]}</div>
                        <div className="space-y-1">
                          {rows.map((p, i) => (
                            <div key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]">
                              <span className={`rounded px-1 py-0.5 text-[10px] font-semibold ${TIER_TAG[tier]}`}>{p.code ?? '—'}</span>
                              <span className="font-medium text-slate-700">{p.label}</span>
                              <span className="text-[11px] text-slate-400">{p.dateLabel} · {p.descriptor}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Medications ────────────────────────────────────────────── */}
            {view.medications.length > 0 && (
              <div>
                <SectionHead icon={Pill} title="💊 Medications" sub={`${view.medications.length} · current reconciled status`} />
                <div className="space-y-1">
                  {view.medications.map((m, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-slate-700">
                      <span className="font-medium">{m.concept}</span>
                      <Badge t={m.currentness} />
                      {m.caption && <span className="text-[11px] italic text-slate-400">{m.caption}</span>}
                      <span className="text-[11px] text-slate-400">{m.latestDose ? `${m.latestDose} · ` : ''}{m.occurrences}×</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Investigations: abnormal & trend surfaced; full collapsible ── */}
            {view.counts.investigations > 0 && (
              <div>
                <SectionHead icon={FlaskConical} title="🧪 Investigations" sub={`${view.counts.investigations} results · abnormal & trending surfaced`} />
                <div className="space-y-1">
                  {view.flaggedLabs.surfaced.map((l, i) => (
                    <div key={i} className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                      <span className="font-medium text-slate-700">{l.analyte}</span>
                      <span className={`font-semibold ${BAND_TEXT[l.band] ?? 'text-slate-600'}`}>{l.latestValue}{l.unit ? ` ${l.unit}` : ''}{l.direction && l.direction !== 'flat' ? (l.direction === 'up' ? ' ↑' : ' ↓') : ''}</span>
                      <span className="text-[11px] text-slate-400">{l.refText}{l.abnormal ? ` · ${l.band}` : l.readings > 1 ? ` · ${l.readings} readings` : ''}</span>
                    </div>
                  ))}
                  {view.flaggedLabs.surfaced.length === 0 && <div className="text-[12px] text-slate-500">All results within range.</div>}
                </div>
                {withinRange.length > 0 && (
                  <details className="mt-1.5 text-[12px]">
                    <summary className="cursor-pointer text-[11.5px] text-slate-500 hover:text-slate-700">Full panel · {view.counts.investigations} results · remainder within range</summary>
                    <div className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
                      {withinRange.map((iv, i) => (
                        <div key={i} className="flex justify-between gap-2 text-slate-600">
                          <span>{iv.analyte}</span>
                          <span className="text-slate-500">{iv.latest ?? '—'}{iv.unit ? ` ${iv.unit}` : ''}{iv.mixedUnits ? ' · mixed units' : ''}</span>
                        </div>
                      ))}
                    </div>
                    {view.flaggedLabs.normalCount > withinRange.length && (
                      <div className="mt-1 text-[11px] italic text-slate-400">…and {view.flaggedLabs.normalCount - withinRange.length} more, within range.</div>
                    )}
                  </details>
                )}
              </div>
            )}

            {/* ── Care gaps ──────────────────────────────────────────────── */}
            {view.careGaps.length > 0 && (
              <div>
                <SectionHead icon={Repeat} title="🔁 Care gaps" sub="abnormal or on-treatment, not followed up" />
                <div className="space-y-1">
                  {view.careGaps.map((g, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-[12px] text-slate-600">
                      <span className={g.severity === 'safety' ? 'text-rose-500' : 'text-amber-500'}>○</span>
                      <span><b className="font-medium text-slate-700">{g.analyte}</b> {g.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Allergies ──────────────────────────────────────────────── */}
            <div>
              <SectionHead icon={Ban} title="⛔ Allergies" sub={String(view.counts.allergies)} />
              {view.allergies.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {view.allergies.map((a, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-[12.5px] text-slate-700">
                      <span className="font-medium">{a.substance}</span> <Badge t={a.status} />
                      {a.conflicted && <span className="rounded bg-rose-50 px-1 py-0.5 text-[10px] font-bold text-rose-700">conflict</span>}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-[12px] text-slate-500"><CircleHelp className="h-3.5 w-3.5" /> No allergy status on record.</div>
              )}
            </div>

            <div className="inline-flex items-center gap-1.5 rounded-lg bg-slate-50 px-2.5 py-1 text-[11px] text-slate-500">
              Read-only reconciled state · deterministic substrate · not a substitute for the record.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
