'use client';

// MemberState clinical-state substrate (member-present/0.2) — the SINGLE-ENCOUNTER card (mockup v1).
// Anchored to ONE OPD visit, not the whole member. Leads with THIS visit (dx / vitals-if-any /
// assessment completeness / what wasn't captured), then a CONDENSED longitudinal strip (currentness
// conflict, active/background chips, care-gap one-liners, one labs line, a picture-confidence bar).
// Full panel is one click away in the workspace. DETERMINISTIC — vitals read for display (props),
// never folded into the snapshot. Collapses to nothing on empty/error.

import Link from 'next/link';
import { AlertTriangle, ShieldCheck, ArrowUpRight } from 'lucide-react';
import { useMemberState, Badge } from './MemberStatePanel';
import type { MemberVitals } from '@/lib/member-state/vitals-read';
import { computePictureConfidence, buildVitalsView, EMPTY_MODALITY } from '@/lib/member-state/present-augment';

const LEVEL: Record<string, string> = {
  THIN: 'bg-rose-50 text-rose-700 ring-rose-200',
  PARTIAL: 'bg-amber-50 text-amber-700 ring-amber-200',
  GOOD: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
};

interface EncounterLite { diagnoses?: string[]; investigations?: string[] }

export default function MemberStateCallContext({ prescUid, vitals, encounter }: { prescUid: string; vitals?: MemberVitals; encounter?: EncounterLite | null }) {
  const { view, individualUid, state } = useMemberState(`presc_uid=${encodeURIComponent(prescUid)}`);
  if (state !== 'ready' || !view) return null;

  const modality = vitals?.modality ?? EMPTY_MODALITY;
  const vitalsView = buildVitalsView(vitals?.latest ?? null, modality);
  const confidence = computePictureConfidence({
    lastContact: view.confidence.lastContact,
    vitalsEver: !!vitals?.latest,
    modalityMix: modality,
    lastLab: view.confidence.lastLab,
    problems: view.confidence.problems,
    encounters: { opd: modality.total, ipd: 0 },
  }, view.confidence.now);

  const medConflicts = view.attentionFlags.filter((f) => f.kind === 'med_conflict');
  const problems = view.problems.filter((p) => p.tier === 'active' || p.tier === 'background');
  const topLab = view.flaggedLabs.surfaced.find((l) => l.abnormal) ?? view.flaggedLabs.surfaced[0] ?? null;

  // assessment completeness — deterministic from THIS visit's vitals + the member's modality.
  // D-B (CHEAP-DEFECT-BATCH §4.2): when the modality is UNKNOWN the sentence must not claim the
  // care was remote. The source field (general_practitioner_prescription__vitals) has been empty on
  // every prescription since 1 April 2026, so "remote / undocumented throughout" was a statement
  // about missing data dressed as a statement about the clinician. Every other case is unchanged.
  const completeness = vitalsView.hasVitals
    ? { tone: 'ok', text: 'Vitals captured this visit — a measured exam anchors this encounter.' }
    : modality.majority === 'unknown'
      ? { tone: 'warn', text: 'No vitals or exam findings captured on this note. How this member has been assessed is not recorded, so no exam history can be read from it.' }
      : { tone: 'warn', text: `No vitals or exam findings captured; modality ${modality.lastAssessMode ? modality.lastAssessMode.replace(/_/g, ' ').toLowerCase() : 'not recorded'} on this note. For this member, care has been remote / undocumented throughout — this encounter adds a diagnosis, not a measured exam.` };

  // compact confidence caption (mockup: "8 visits · no vitals · labs 2.5y old")
  const labsFactor = confidence.factors.find((f) => f.key === 'labs');
  const compact = [
    `${modality.total || 'no'} visit${modality.total === 1 ? '' : 's'}`,
    vitals?.latest ? 'vitals this visit' : 'no vitals',
    (labsFactor?.label || '').replace(/^Labs last panel /, 'labs ').replace(/ ago$/, ' old'),
  ].filter(Boolean).join(' · ');

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
        <ShieldCheck className="h-3.5 w-3.5 text-teal-600" />
        <span className="text-[12.5px] font-semibold text-slate-800">Clinical state · this visit</span>
        <span className="rounded-full bg-teal-50 px-1.5 py-0.5 text-[10px] font-semibold text-teal-700">validated · advisory</span>
        {individualUid && (
          <Link href={`/care/m/${encodeURIComponent(individualUid)}`} className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-teal-700 hover:text-teal-800">
            Full clinical state <ArrowUpRight className="h-3 w-3" />
          </Link>
        )}
      </div>

      <div className="space-y-3 px-3 py-2.5 text-[12px]">
        {/* ── THIS ENCOUNTER ─────────────────────────────────────────────── */}
        <div className="rounded-lg border border-teal-100 bg-teal-50/40 px-3 py-2.5">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-teal-700/80">This encounter</div>
          {encounter?.diagnoses?.length ? (
            <div className="mb-1"><span className="text-slate-400">Diagnosis </span><span className="font-medium text-slate-700">{encounter.diagnoses.join(' · ')}</span></div>
          ) : null}
          {vitalsView.hasVitals ? (
            <div className="mb-1 flex flex-wrap gap-1.5">
              {vitalsView.items.map((it, i) => (
                <span key={i} className={`rounded border px-1.5 py-0.5 text-[11px] ${it.flag ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-slate-200 bg-white text-slate-600'}`}>{it.label} {it.value}{it.flag ? ' ⚑' : ''}</span>
              ))}
              {vitalsView.ews && <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${vitalsView.ews.high ? 'bg-rose-600 text-white' : 'bg-slate-200 text-slate-700'}`}>EWS {vitalsView.ews.score}</span>}
            </div>
          ) : (
            <div className="mb-1 text-slate-500">Vitals not taken this visit</div>
          )}
          <div className={`mt-1.5 rounded border border-dashed px-2 py-1 text-[11.5px] ${completeness.tone === 'ok' ? 'border-emerald-200 text-emerald-700' : 'border-slate-300 text-slate-500'}`}>
            <b>Assessment completeness — {completeness.tone === 'ok' ? 'validated.' : 'partial.'}</b> {completeness.text}
          </div>
          {!vitalsView.hasVitals && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-400">
              <span>Not captured this visit:</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5">vitals</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5">weight / BMI trend</span>
            </div>
          )}
        </div>

        {/* ── AGAINST THE RECORD ─────────────────────────────────────────── */}
        <div>
          <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">Against the record · what matters for this call</div>

          {medConflicts.map((f, i) => (
            <div key={i} className="mb-1.5 flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-amber-800">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /><span>{f.text}</span>
            </div>
          ))}

          {problems.length > 0 && (
            <div className="mb-1.5">
              <div className="mb-0.5 text-[10px] font-semibold text-slate-400">Active / background problems</div>
              <div className="flex flex-wrap gap-x-2 gap-y-1">
                {problems.map((p, i) => (
                  <span key={i} className="inline-flex items-baseline gap-1">
                    <span className="font-medium text-slate-700">{p.label}</span>
                    {p.code && <span className="text-[10px] text-slate-400">{p.code}</span>}
                  </span>
                ))}
              </div>
            </div>
          )}

          {view.careGaps.length > 0 && (
            <div className="mb-1.5">
              <div className="mb-0.5 text-[10px] font-semibold text-slate-400">Care gaps</div>
              <div className="space-y-0.5">
                {view.careGaps.map((g, i) => (
                  <div key={i} className="text-[11.5px] text-slate-600"><span className={g.severity === 'safety' ? 'text-rose-500' : 'text-amber-500'}>○</span> <b className="font-medium text-slate-700">{g.analyte}</b> {g.detail}</div>
                ))}
              </div>
            </div>
          )}

          {topLab && (
            <div className="mb-1.5 text-[11.5px] text-slate-600">
              <span className="text-[10px] font-semibold text-slate-400">Labs </span>
              <b className="font-medium text-slate-700">{topLab.analyte}</b> {topLab.latestValue}{topLab.unit ? ` ${topLab.unit}` : ''} <span className="text-slate-400">{topLab.refText}</span>
              {view.flaggedLabs.normalCount > 0 && <span className="text-slate-400"> · {view.flaggedLabs.normalCount} more within range</span>}
            </div>
          )}

          {/* picture-confidence bar */}
          <div className="mt-1.5 flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${LEVEL[confidence.level]}`}>{confidence.level}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
              <div className={`h-full rounded-full ${confidence.level === 'GOOD' ? 'bg-emerald-400' : confidence.level === 'PARTIAL' ? 'bg-amber-400' : 'bg-gradient-to-r from-rose-500 to-amber-400'}`} style={{ width: `${confidence.barPct}%` }} />
            </div>
            <span className="text-[10.5px] text-slate-400">{compact}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
