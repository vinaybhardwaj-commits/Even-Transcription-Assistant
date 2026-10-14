import Link from 'next/link';
import type { ReactNode } from 'react';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { fetchDoctorNames, fetchOpdNoteByUid } from '@/lib/metabase';
import { rowToOpdCase, type DeidOpdCase } from '@/lib/opd-ingest-core';
import { enrichOpdMeds } from '@/lib/formulary';
import { individualUidForPresc, getMemberSnapshotAsOf } from '@/lib/member-state/member-state';
import { presentMemberState, type MemberStateView } from '@/lib/member-state/present-core';
import { type OpdDomain, documentationAdequacyFlag } from '@/lib/opd-note-score-core';
import { OPD_ENGINE_VERSION, OPD_ENGINE_VERSIONS_CURRENT } from '@/lib/opd-note-audit-core';
import { isLocalGrader, isReferenceModel } from '@/lib/audit-canonical';
import { bucketByTier } from '@/lib/severity-tier-core';
import { LVC_CATEGORY_LABELS } from '@/lib/opd-lvc-classify-core';
import { displayedBandColumnExists } from '@/lib/opd-audit-store';

// Decision 21: prev/next navigation READS the current-engine FAMILY (the escalation package below
// keeps exact OPD_ENGINE_VERSION — that's the display/metadata stamp, not a read filter).
const ENG_FAMILY_SQL = `ANY(ARRAY[${OPD_ENGINE_VERSIONS_CURRENT.map((v) => `'${v}'`).join(', ')}])`;
import { anchorFindings, anchorsByTarget, type NoteAnchor } from '@/lib/opd-case-anchor-core';
import { CitationChips, SourcesPanel } from '@/components/right-care/kit';
import type { Source } from '@/lib/citations-core';
import { stripRetiredEvenCitations } from '@/lib/even-ground-core';
import { citationResolves, groundingKind, GROUNDING_PRESENTATION } from '@/lib/provenance-tier-core';
import { findingOrigin, ORIGIN_PRESENTATION, LAYER_COPY } from '@/lib/opd-audit-layers-core';
import FeedbackPanel, { type FeedbackEntry } from './feedback-panel';
import { FindingTriage, ReviewerBar } from './finding-triage';
import { MissedFindingCapture, type MissedEntry } from './missed-finding';
import { EscalateButton } from './escalate-button';
import { TriageProgress } from './triage-progress';
import OpdCaseAskPanel from './case-ask-panel';
import {
  bandColor, scoreColor, parseJson, doctorLabel, fmtIstTime, PDQI9_LABEL, PDQI9_HELP,
} from '@/lib/opd-audit-ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'OPD case audit · Admin' };

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const n = (v: unknown): number => Number(v ?? 0);

const VERDICT_COLOR: Record<string, string> = {
  'low-value': '#dc2626', 'context-dependent': '#d97706', 'high-value': '#16a34a', uncertain: '#78715f',
};

type Finding = { subject: string; verdict: string; confidence: number; domain: string; rationale: string; evidence?: string[]; estimates?: string[]; source?: string; citation_ids?: number[]; finding_ref?: string; signal_type?: string; rule_ref?: string | null; lvc_category?: string; informational?: boolean; quieted_by?: string | null };
type LvcRuleInfo = { plain_rationale: string | null; citation: string | null; resolves: boolean };
// 0.81.8 Decision 10 — shared category labels (local 'other' override kept) so new overuse sub-tags render.
const LVC_CAT_LABEL: Record<string, string> = { ...LVC_CATEGORY_LABELS, other: 'Low-value care' };
type Pdqi = { attr: string; label?: string; value: number };
type Sugg = { priority: number; text: string };

// ── Stage 3 (opd-longitudinal/0.1) — the advisory Longitudinal panel (normative mockup) ──────────────
type LongFinding = { subject: string; rationale: string; evidence?: string[]; source?: string; signal_type?: string; informational?: boolean };
type LongitudinalBlockView = {
  version: string; asOf: string;
  contextMeta: { encounters: number; confidence: string; excluded_reason: string | null };
  findings: LongFinding[];
};
// Advisory plane palette — calm slate/indigo, DELIBERATELY NOT the scored-band colours (never shared).
const ADV = { ink: '#4b57a6', bg: '#f4f5fb', line: '#d6daf0', soft: '#eceef8', warn: '#b25e09', warnLine: '#e9d7a6' };
const EXCLUDED_COPY: Record<string, string> = {
  no_prior_history: 'No prior history before this visit — not applicable. Thin / first-visit charts are never penalised.',
  member_unresolved: 'Member could not be resolved from this note — longitudinal context is unavailable here.',
  context_fetch_failed: 'Prior context could not be fetched — the base audit is unaffected.',
  low_confidence_state: 'Picture confidence too thin for the judged dimensions; deterministic checks still ran.',
  llm_failed: 'The judged dimensions were unavailable; deterministic findings still stand.',
};

function LongitudinalPanel({ block, view }: { block: LongitudinalBlockView; view: MemberStateView | null }) {
  const meta = block.contextMeta;
  const findings = block.findings || [];
  const confLabel = meta.confidence === 'established' ? 'Established picture' : meta.confidence === 'thin' ? 'Thin picture' : 'No prior picture';
  return (
    <div id="longitudinal" className="mt-3 scroll-mt-4 rounded-xl border bg-white" style={{ borderColor: ADV.line, boxShadow: `0 0 0 3px ${ADV.soft} inset` }}>
      <div className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-[15px] font-bold" style={{ color: ADV.ink }}>
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: ADV.ink }} />
            Longitudinal context — the chart before the visit
          </div>
          <span className="rounded-full border px-2.5 py-0.5 text-[11px] font-bold" style={{ color: ADV.ink, background: ADV.bg, borderColor: ADV.line }}>
            Informational · does not affect the score
          </span>
        </div>
        <p className="mt-1.5 text-[12.5px] text-slate-500">
          MemberState reconstructed <b className="text-slate-800">as of {block.asOf}</b> (the encounter date). Only evidence dated <b>before</b> that day counts; this visit&apos;s own orders are excluded — the doctor is judged only on what was knowable going in.
        </p>

        {meta.excluded_reason && !findings.length && (
          <div className="mt-3 rounded-lg border px-3 py-2 text-[12.5px]" style={{ borderColor: ADV.line, background: ADV.bg, color: '#3d4470' }}>
            {EXCLUDED_COPY[meta.excluded_reason] || 'Longitudinal pass degraded — base audit unaffected.'}
          </div>
        )}

        {view && (
          <div className="mt-4 overflow-hidden rounded-lg border" style={{ borderColor: ADV.line, background: ADV.bg }}>
            <div className="flex flex-wrap items-center gap-2.5 border-b px-3.5 py-2.5" style={{ borderColor: ADV.line }}>
              <span className="rounded-full border bg-white px-2.5 py-0.5 text-[12px] font-bold" style={{ color: ADV.ink, borderColor: ADV.line }}>{confLabel}</span>
              <span className="text-[12.5px] text-slate-500">{meta.encounters} prior encounter{meta.encounters === 1 ? '' : 's'} · confidence {meta.confidence}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2">
              <ChartCell label="Active problems">
                {view.problems.slice(0, 4).map((p, i) => <Pill key={i}>{p.label}{p.code ? <Mono> {p.code}</Mono> : null}</Pill>)}
                {!view.problems.length && <Muted>none documented</Muted>}
              </ChartCell>
              <ChartCell label="Active medications">
                {view.medications.slice(0, 4).map((m, i) => <Pill key={i} strike={m.currentness.tone === 'stopped'}>{m.concept}{m.currentness.tone === 'stopped' ? <Mono> stopped</Mono> : null}</Pill>)}
                {!view.medications.length && <Muted>none documented</Muted>}
              </ChartCell>
              <ChartCell label="Attention">
                {view.attentionFlags.slice(0, 2).map((a, i) => <Pill key={i} attn>{a.text}</Pill>)}
                {!view.attentionFlags.length && <Muted>nothing flagged</Muted>}
              </ChartCell>
              <ChartCell label="Recent labs">
                {view.flaggedLabs.surfaced.slice(0, 3).map((l, i) => <Pill key={i}>{l.analyte} {l.latestValue}{l.unit ? ' ' + l.unit : ''} · {l.band}<Mono> {l.date}</Mono></Pill>)}
                {!view.flaggedLabs.surfaced.length && <Muted>no abnormal labs</Muted>}
              </ChartCell>
            </div>
          </div>
        )}

        {findings.length > 0 && (
          <div className="mt-5">
            <div className="mb-2.5 flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400">Longitudinal findings</div>
              <span className="text-[12px] text-slate-500">{findings.length} finding{findings.length === 1 ? '' : 's'} · all informational</span>
            </div>
            {findings.map((f, i) => {
              const rule = f.source !== 'llm';
              return (
                <div key={i} className="mb-2.5 rounded-lg border bg-white px-3.5 py-3" style={{ borderColor: '#e4e7ec', borderLeft: `3px solid ${ADV.ink}` }}>
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <span className="rounded border px-2 py-0.5 font-mono text-[11px] font-bold" style={{ color: ADV.ink, background: ADV.bg, borderColor: ADV.line }}>{f.signal_type}</span>
                    <span className="rounded px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.04em]" style={rule ? { color: '#3a4a7a', background: '#eef1fb', border: '1px solid #d6daf0' } : { color: '#5a4a86', background: '#f3eefb', border: '1px solid #e2d6f0' }}>{rule ? 'Rule' : 'Judged'}</span>
                    <span className="ml-auto text-[10.5px] font-bold" style={{ color: ADV.ink }}>Informational</span>
                  </div>
                  <div className="text-[13.5px] text-slate-800">{f.rationale}</div>
                  {f.evidence?.[0] && <div className="mt-2 border-t border-dashed pt-2 text-[12px] text-slate-500" style={{ borderColor: '#e4e7ec' }}>{f.evidence[0]}</div>}
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-2 border-t pt-3 text-[11.5px] leading-relaxed text-slate-500" style={{ borderColor: '#eef0f3' }}>
          No-hindsight rule: a lab resulting after {block.asOf}, or ordered at this visit, can never appear here or count against the note. Thin / first-visit charts show &ldquo;no prior history — not applicable,&rdquo; never a penalty. This panel is advisory — Care Managers validity-label these findings in triage; a type only affects the score after it clears the promotion gate (a future 0.9 step).
        </div>
      </div>
    </div>
  );
}
function ChartCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-t px-3.5 py-3 sm:odd:border-r" style={{ borderColor: ADV.line }}>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.03em] text-slate-400">{label}</div>
      {children}
    </div>
  );
}
function Pill({ children, strike, attn }: { children: ReactNode; strike?: boolean; attn?: boolean }) {
  return (
    <span className="mb-1.5 mr-1.5 inline-block rounded-md border bg-white px-2 py-1 text-[12.5px]"
      style={{ borderColor: attn ? ADV.warnLine : ADV.line, background: attn ? '#fdf9ef' : '#fff', textDecoration: strike ? 'line-through' : 'none', color: strike ? '#667085' : '#1a1d23' }}>
      {children}
    </span>
  );
}
function Mono({ children }: { children: ReactNode }) { return <span className="font-mono text-[11px] text-slate-400">{children}</span>; }
function Muted({ children }: { children: ReactNode }) { return <span className="text-[12px] italic text-slate-400">{children}</span>; }

const DOMAINS: { key: OpdDomain; col: string; label: string }[] = [
  { key: 'documentation', col: 'score_documentation', label: 'Documentation' },
  { key: 'note_quality', col: 'score_note_quality', label: 'Note quality' },
  { key: 'appropriateness', col: 'score_appropriateness', label: 'Appropriateness' },
  { key: 'prescribing_safety', col: 'score_prescribing_safety', label: 'Prescribing & safety' },
  { key: 'patient_centred', col: 'score_patient_centred', label: 'Continuity' },
];
const DOMAIN_LABEL: Record<string, string> = Object.fromEntries(DOMAINS.map((d) => [d.key, d.label]));

// PRD §9.5 — assemble the portable "Escalate to Gemini" package. Input `note` is already
// de-identified (DeidOpdCase), so the string carries no PHI. The consumer is the care manager's
// own Gemini (then Claude + this repo) — free-form, no structured import.
function buildEscalationPackage({ uid, doctor, band, index, note, findings, scores, engineVersion, notAssessed }: {
  uid: string; doctor: string; band: string; index: number;
  note: DeidOpdCase | null; findings: Finding[]; scores: Record<OpdDomain, number>; engineVersion: string;
  notAssessed?: boolean;
}): string {
  const L: string[] = [];
  L.push(`# OPD note — escalation for independent re-audit`);
  L.push(``);
  L.push(`- Encounter (de-identified): \`${uid}\``);
  L.push(`- Reviewing clinician: ${doctor}`);
  // S0 D5 — a failed measurement is never presented as a grade, least of all to an external reviewer.
  L.push(notAssessed ? `- CDMSS grade: not assessed at this engine version (grading model could not assess this note)` : `- CDMSS grade: ${index} · Band ${band}`);
  L.push(`- Engine: \`${engineVersion}\``);
  L.push(``);
  L.push(`## The note (de-identified — exactly what the engine read)`);
  if (!note) {
    L.push(`_Source note unavailable at export time._`);
  } else {
    const line = (label: string, val: string) => L.push(`- **${label}:** ${val || '(none)'}`);
    line('Presenting complaints / history', note.presentingComplaints.join(' · '));
    if (note.reasonForConsult) line('Reason for consult', note.reasonForConsult);
    line('Examination', note.examination.join(' · '));
    line('Diagnosis (ICD-10)', [note.diagnosisCodes.join(', '), note.impressions.join('; ') || note.impressionCodes.join(', ')].filter(Boolean).join(' · '));
    L.push(`- **Medications (${note.medications.length}):**`);
    for (const m of note.medications) {
      const dosing = [m.strength, m.dose, m.frequency, m.duration, m.route].filter(Boolean).join(' · ');
      const primary = m.resolvedGeneric || m.generic || m.brand || '(unnamed)';
      L.push(`  - ${primary}${dosing ? ` — ${dosing}` : ''}${m.instruction ? ` · ${m.instruction}` : ''}`);
    }
    line('Investigations ordered', note.investigations.join(' · '));
    line('Advice / plan', note.advice.join(' · '));
    line('Follow-up', note.followUpType ? `${note.followUpType}${note.followUpDateSet ? ' · date set' : ' · no date'}` : '(none)');
  }
  L.push(``);
  L.push(`## CDMSS domain scores`);
  for (const d of DOMAINS) L.push(`- ${d.label}: ${scores[d.key] ?? '—'}`);
  L.push(``);
  L.push(`## CDMSS findings (${findings.length})`);
  if (findings.length === 0) L.push(`_No findings fired._`);
  findings.forEach((f, i) => {
    L.push(`${i + 1}. **${f.subject}** — _${f.verdict}_ (${DOMAIN_LABEL[f.domain] || f.domain})`);
    if (f.rationale) L.push(`   - ${f.rationale}`);
  });
  L.push(``);
  L.push(`## Task for you (Gemini)`);
  L.push(`Independently re-audit the OPD note above as an experienced physician. For each of the five domains`);
  L.push(`(documentation, note quality, appropriateness, prescribing & safety, continuity):`);
  L.push(`1. State whether you agree with the CDMSS grade and each finding above; flag any you consider **false** or a **nitpick**.`);
  L.push(`2. List any clinically important issue the CDMSS audit **missed** (recall / false negatives).`);
  L.push(`3. Keep it advisory and note-scoped — this is a documentation-quality proxy, not a clinician scorecard.`);
  L.push(`Return your assessment as free text; it will be reconciled against the CDMSS audit out-of-band.`);
  L.push(``);
  return L.join('\n');
}

function LockedMsg() {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">OPD case audit</h1>
      <p className="mt-1.5 text-sm text-slate-500">Locked. <Link href="/admin/opd-audit" className="text-brand hover:underline">Unlock the OPD Audit surface</Link> first.</p>
    </div>
  );
}

// ── numbered anchor chips (note side) ──────────────────────────────────────────
const CHIP_CLS: Record<string, string> = {
  red: 'bg-red-50 text-red-700 ring-red-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  slate: 'bg-slate-100 text-slate-600 ring-slate-200',
};
function chipTone(f: Finding | undefined): string {
  if (!f) return 'slate';
  if (f.verdict === 'low-value') return 'red';
  if (f.verdict === 'context-dependent' || f.domain === 'prescribing_safety') return 'amber';
  return 'slate';
}
function Chips({ anchors, findings }: { anchors: NoteAnchor[] | undefined; findings: Finding[] }) {
  if (!anchors || anchors.length === 0) return null;
  return (
    <span className="inline-flex gap-1 align-middle">
      {anchors.map((a) => (
        <a key={a.num} id={`a${a.num}`} href={`#f${a.num}`}
          className={`inline-flex h-[16px] min-w-[16px] scroll-mt-24 items-center justify-center rounded-full px-1 text-[10px] font-semibold ring-1 target:ring-2 target:ring-brand ${CHIP_CLS[chipTone(findings[a.num - 1])]}`}
          title={findings[a.num - 1]?.subject || ''}>{a.num}</a>
      ))}
    </span>
  );
}

// ── the actual de-identified note (fetched live from db13 by uid) ──────────────
function NoteRow({ label, chips, children }: { label: string; chips?: ReactNode; children: ReactNode }) {
  return (
    <div className="border-t border-slate-50 px-4 py-2.5 first:border-t-0">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.06em] text-slate-400">{label}{chips}</div>
      <div className="mt-0.5 text-[12.5px] leading-relaxed text-slate-700">{children}</div>
    </div>
  );
}
const none = (s: string) => <span className="text-slate-400">{s}</span>;

function NotePanel({ note, pdfUrl, grouped, findings }: { note: DeidOpdCase | null; pdfUrl: string | null; grouped: Record<string, NoteAnchor[]>; findings: Finding[] }) {
  const pdfLink = pdfUrl ? <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] font-medium text-brand hover:underline">↓ Actual PDF</a> : null;
  const chips = (key: string) => <Chips anchors={grouped[key]} findings={findings} />;
  if (!note) {
    return <div className="rounded-xl border border-slate-200 bg-white p-4 text-[12px] text-slate-400">Source note unavailable — it may have been edited or removed in db13 since the audit ran. {pdfLink}</div>;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-4 py-2">
        <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-slate-600">The note <span className="font-normal text-slate-400">· de-identified · what the engine read</span>{chips('note')}</span>
        {pdfLink}
      </div>
      <NoteRow label="Presenting complaints / history" chips={chips('complaints')}>{note.presentingComplaints.length ? note.presentingComplaints.join(' · ') : none('(none documented)')}</NoteRow>
      {note.reasonForConsult ? <NoteRow label="Reason for consult" chips={chips('reason')}>{note.reasonForConsult}</NoteRow> : null}
      <NoteRow label="Examination" chips={chips('examination')}>{note.examination.length ? note.examination.join(' · ') : none('(none recorded)')}</NoteRow>
      <NoteRow label="Diagnosis (ICD-10)" chips={chips('diagnosis')}>{note.diagnosisCodes.length ? note.diagnosisCodes.join(', ') : none('(none)')}{note.impressions.length ? ` · ${note.impressions.join('; ')}` : (note.impressionCodes.length ? ` · impression ${note.impressionCodes.join(', ')}` : '')}</NoteRow>
      <NoteRow label={`Medications (${note.medications.length})`} chips={chips('medications')}>
        {note.medications.length === 0 ? none('(none)') : (
          <ul className="space-y-1">
            {note.medications.map((m, i) => {
              const dosing = [m.strength, m.dose, m.frequency, m.duration, m.route].filter(Boolean).join(' · ');
              const primary = m.resolvedGeneric || m.generic || m.brand;
              const showBrand = m.brand && (m.resolvedGeneric || m.generic) && m.brand.toLowerCase() !== String(primary).toLowerCase();
              const tags: string[] = [];
              if (m.therapeuticClass) tags.push(m.therapeuticClass);
              if (m.schedule && m.schedule !== '—') tags.push(`Sch ${m.schedule}`);
              if (m.formularyMatch === 'brand-prefix') tags.push('≈approx');
              if (m.nonFormulary === 'nutraceutical-cosmetic') tags.push('nutraceutical/cosmetic');
              else if (m.nonFormulary === 'non-formulary') tags.push('off-formulary');
              return (
                <li key={i}>
                  <Chips anchors={grouped[`medications:${i}`]} findings={findings} />{grouped[`medications:${i}`] ? ' ' : ''}
                  <span className="font-medium text-slate-800">{primary}</span>
                  {showBrand ? <span className="text-slate-400"> ({m.brand})</span> : null}
                  {m.highAlert ? <span className="ml-1 rounded bg-red-50 px-1 text-[9px] font-medium text-red-600">HIGH-ALERT</span> : null}
                  {dosing ? <span className="text-slate-500"> — {dosing}</span> : <span className="text-amber-600"> — dosing incomplete</span>}
                  {m.instruction ? <span className="text-slate-400"> · {m.instruction}</span> : null}
                  {tags.length ? <span className="text-slate-400"> · {tags.join(' · ')}</span> : null}
                </li>
              );
            })}
          </ul>
        )}
      </NoteRow>
      <NoteRow label="Investigations ordered" chips={chips('investigations')}>
        {note.investigations.length === 0 ? none('(none)') : (
          <ul className="space-y-0.5">
            {note.investigations.map((inv, i) => (
              <li key={i}><Chips anchors={grouped[`investigations:${i}`]} findings={findings} />{grouped[`investigations:${i}`] ? ' ' : ''}{inv}</li>
            ))}
          </ul>
        )}
      </NoteRow>
      <NoteRow label="Advice / plan" chips={chips('advice')}>{note.advice.length ? note.advice.join(' · ') : none('(none documented)')}</NoteRow>
      <NoteRow label="Follow-up" chips={chips('followup')}>{note.followUpType ? `${note.followUpType}${note.followUpDateSet ? ' · date set' : ' · no date'}` : none('(none)')}</NoteRow>
    </div>
  );
}

// ── PDQI-9 radar ────────────────────────────────────────────────────────────────
const PDQI_ORDER = ['up_to_date', 'accurate', 'thorough', 'useful', 'organized', 'comprehensible', 'succinct', 'synthesized', 'internally_consistent'];
const PDQI_SHORT: Record<string, string> = {
  up_to_date: 'Up-to-date', accurate: 'Accurate', thorough: 'Thorough', useful: 'Useful', organized: 'Organized',
  comprehensible: 'Compreh.', succinct: 'Succinct', synthesized: 'Synth.', internally_consistent: 'Consist.',
};
function PdqiRadar({ pdqi }: { pdqi: Pdqi[] }) {
  const vals = new Map(pdqi.map((p) => [p.attr, Math.max(0, Math.min(5, n(p.value)))]));
  const axes = PDQI_ORDER.filter((a) => vals.has(a));
  if (axes.length < 3) return null;
  const CX = 92, CY = 78, R = 52;
  const pt = (i: number, r: number): [number, number] => {
    const ang = (-90 + (i * 360) / axes.length) * (Math.PI / 180);
    return [CX + r * Math.cos(ang), CY + r * Math.sin(ang)];
  };
  const ring = (r: number) => axes.map((_, i) => pt(i, r).map((v) => v.toFixed(1)).join(',')).join(' ');
  const poly = axes.map((a, i) => pt(i, (vals.get(a)! / 5) * R).map((v) => v.toFixed(1)).join(',')).join(' ');
  const mean = axes.reduce((s, a) => s + vals.get(a)!, 0) / axes.length;
  const weakest = axes.slice().sort((a, b) => vals.get(a)! - vals.get(b)!)[0];
  const weakLabel = PDQI9_LABEL[weakest] || weakest;
  const help = PDQI9_HELP[weakLabel];
  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg width="184" height="156" viewBox="0 0 184 156" className="shrink-0">
        <polygon points={ring(R)} fill="none" stroke="#e2e8f0" strokeWidth="1" />
        <polygon points={ring(R / 2)} fill="none" stroke="#e2e8f0" strokeWidth="0.75" />
        {axes.map((_, i) => { const [x, y] = pt(i, R); return <line key={i} x1={CX} y1={CY} x2={x} y2={y} stroke="#f1f5f9" strokeWidth="0.75" />; })}
        <polygon points={poly} fill="#0f766e" fillOpacity="0.16" stroke="#0f766e" strokeWidth="1.5" />
        {axes.map((a, i) => {
          const v = vals.get(a)!;
          const [x, y] = pt(i, (v / 5) * R);
          const label = PDQI9_LABEL[a] || a;
          const h = PDQI9_HELP[label];
          return (
            <circle key={a} cx={x} cy={y} r="3" fill={scoreColor(((v - 1) / 4) * 100)}>
              <title>{`${label} · ${v}/5\n${h?.def || ''}`}</title>
            </circle>
          );
        })}
        {axes.map((a, i) => {
          const [x, y] = pt(i, R + 11);
          const anchor = Math.abs(x - CX) < 8 ? 'middle' : x > CX ? 'start' : 'end';
          return <text key={a} x={x} y={y + 3} fontSize="8.5" fill="#94a3b8" textAnchor={anchor}>{PDQI_SHORT[a] || a}</text>;
        })}
      </svg>
      <div className="min-w-[180px] flex-1 text-[11.5px] leading-relaxed text-slate-600">
        <div className="text-[12.5px] font-medium text-slate-800">PDQI-9 · {(Math.round(mean * 10) / 10).toFixed(1)}/5</div>
        <div className="mt-0.5">Weakest: <span className="font-medium" style={{ color: scoreColor(((vals.get(weakest)! - 1) / 4) * 100) }}>{weakLabel} {vals.get(weakest)}/5</span>{help ? ` — ${help.def.split('—')[0].trim().toLowerCase()}` : ''}</div>
        <div className="mt-1 text-[10px] text-slate-400">hover a vertex for the definition</div>
      </div>
    </div>
  );
}

// ── the three layers (facts-then-rules PR 1) ────────────────────────────────────
// Facts → Findings → Model, in the page's EXISTING order: the header labels the section it sits
// in, it does not move or regroup anything. Numbering is by identity, not position — layer 3
// stays "3" on a note with no findings. Longitudinal, Suggestions, Sources and Your verdict are
// deliberately outside the layers (they are workflow, and longitudinal carries its own label).
function LayerHeader({ n, title, line }: { n: number; title: string; line: string }) {
  return (
    <div className="mb-1.5">
      <div className="flex items-baseline gap-2">
        <span className="inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-slate-800 px-1 text-[10px] font-semibold text-white">{n}</span>
        <span className="text-[12.5px] font-semibold text-slate-800">{title}</span>
      </div>
      <p className="mt-0.5 text-[11.5px] leading-snug text-slate-500">{line}</p>
    </div>
  );
}

// ── the single finding card ─────────────────────────────────────────────────────
function FindingCard({ f, num, sources, auditId, triage, ruleMap }: { f: Finding; num: number; sources: Source[]; auditId: string; triage: Record<string, string>; ruleMap: Record<string, LvcRuleInfo> }) {
  const isLvc = f.verdict === 'low-value' || f.signal_type === 'low_value_care';
  const rule = isLvc && f.rule_ref ? ruleMap[f.rule_ref] : null;
  const catLabel = f.lvc_category ? (LVC_CAT_LABEL[f.lvc_category] || f.lvc_category) : 'Low-value care';
  const grounded = !!(f.citation_ids && f.citation_ids.length > 0);
  // L8 (V-approved wording): certainty of mechanism and externality of source raise visual weight;
  // internal self-reference does not. Kind comes from the shared core (provenance-tier-core).
  const gk = groundingKind(f, !!rule?.resolves);
  const gp = GROUNDING_PRESENTATION[gk];
  const ground = {
    label: gp.label,
    cls: gp.elevated ? 'border-teal-200 bg-teal-50 text-teal-800' : 'border-slate-200 bg-slate-50 text-slate-500',
  };
  // Layer 2 · origin (facts-then-rules PR 1; architecture §3.3 finding_origin, §3.7 legacy).
  // From the STORED source field ONLY. Never from rule_ref: the matcher stamps rule_ref onto
  // model-authored prose after the finding exists, so it proves nothing fired.
  const origin = ORIGIN_PRESENTATION[findingOrigin(f.source)];
  const tone = chipTone(f);
  const cardCls = tone === 'red' ? 'border-red-200 bg-red-50/50' : tone === 'amber' ? 'border-amber-200 bg-amber-50/40' : 'border-slate-200 bg-white';
  return (
    <div id={`f${num}`} className={`scroll-mt-24 rounded-lg border p-3 target:ring-2 target:ring-brand/50 ${cardCls}`}>
      <div className="flex items-start gap-2">
        <a href={`#a${num}`} title="Show in the note"
          className={`mt-[1px] inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1 text-[10.5px] font-semibold ring-1 hover:ring-2 ${CHIP_CLS[tone]}`}>{num}</a>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-slate-800">{f.subject}
            <span className="ml-2 align-middle text-[10px] font-normal" style={{ color: VERDICT_COLOR[f.verdict] || '#78715f' }}>{f.verdict}</span>
            <span className={`ml-2 inline-block rounded border px-1.5 py-0.5 align-middle text-[10px] font-medium ${ground.cls}`}>{ground.label}</span>
            <span className={`ml-2 inline-block rounded border px-1.5 py-0.5 align-middle text-[10px] font-medium ${origin.cls}`} title={origin.title}>{origin.label}</span>
            {/* Quieting badge — admin views stay UNFILTERED; the badge discloses zero score effect */}
            {f.quieted_by && (
              <span className="ml-2 inline-block rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 align-middle text-[10px] font-medium text-violet-700"
                title="Quieted by an active demote rule: recorded and routed to care/admin/analytics, but informational — no score contribution, absent from doctor-facing display.">
                quieted · rule {String(f.quieted_by).slice(0, 8)}
              </span>
            )}
          </div>
          {f.rationale && <div className="mt-1 text-[11.5px] leading-snug text-slate-600">{f.rationale}</div>}
          {/* Right Care rule chip (§7) — LVC category; expands to the rule's plain rationale + citation. */}
          {isLvc && (
            rule && rule.plain_rationale ? (
              <details className="mt-1 rounded-md border border-amber-200 bg-amber-50/60 px-2 py-1">
                <summary className="cursor-pointer text-[10.5px] font-medium text-amber-800">Right Care · {catLabel}</summary>
                <div className="mt-1 text-[11px] leading-snug text-slate-600">{rule.plain_rationale}
                  {/* L9: the link renders ONLY when the citation resolves to a specific
                      recommendation — a generic catalog root shows the plain rationale, no link. */}
                  {rule.resolves && rule.citation && <a href={rule.citation} target="_blank" rel="noopener" className="ml-1 text-amber-700 hover:underline">source →</a>}
                </div>
              </details>
            ) : (
              <span className="mt-1 inline-block rounded-md border border-amber-200 bg-amber-50/60 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">Right Care · {catLabel}</span>
            )
          )}
          {grounded && sources.length > 0 && <CitationChips ids={f.citation_ids!} sources={sources} />}
          {Array.isArray(f.evidence) && f.evidence.length > 0 && (
            <div className="mt-1 text-[11px] text-slate-500"><span className="text-emerald-700">Evidence:</span> {f.evidence.join('; ')}</div>
          )}
          <FindingTriage auditId={auditId} findingRef={f.finding_ref} signalType={f.signal_type} current={f.finding_ref ? triage[f.finding_ref] : undefined} />
        </div>
      </div>
    </div>
  );
}

export default async function OpdCaseAudit({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isAdminUnlocked())) { adminTokenConfigured(); return <LockedMsg />; }

  const rows = (await run(
    `SELECT id, uid, doctor_uid, consult_type, prescription_type, note_date, trace_id,
            note_quality_index, band, completeness_pct, n_missing_mandatory,
            score_documentation, score_note_quality, score_appropriateness, score_prescribing_safety, score_patient_centred,
            pdqi9, findings, suggestions, sources, longitudinal, excluded_reason,
            engine_version, model${(await displayedBandColumnExists().catch(() => false)) ? ', displayed_band' : ''}
     FROM opd_note_audits WHERE id = $1 AND app_source = $2 LIMIT 1`,
    [id, APP],
  ).catch(() => [])) as Record<string, unknown>[];

  const r = rows[0];
  if (!r) {
    return (
      <div>
        <Link href="/admin/opd-audit" className="text-sm text-brand hover:underline">← OPD Audit</Link>
        <p className="mt-6 text-sm text-slate-500">Audit not found.</p>
      </div>
    );
  }

  const index = n(r.note_quality_index);
  // S1 — the band this page SHOWS is the hysteresis-anchored displayed band (raw-band fallback for
  // rows written before 0029). The raw index renders beside it everywhere, per the rule: a contest
  // conversation is about the number, not the label.
  const band = String(r.displayed_band || '') || String(r.band || '');
  // S0 D5 — a marked row's stored values stay, but they are NEVER presented as a score.
  const notAssessed = String(r.excluded_reason || '') === 'llm_leg_failed';
  // GRADER PROVENANCE (PRD §4.3) — name the model that produced this audit, in plain words. The
  // local/cloud test is isLocalGrader, the SAME predicate the canonical ranking uses, so the label
  // can never disagree with the tier that decided whether this row is the one on the dashboard.
  const graderIsLocal = isLocalGrader(r.model, r.engine_version);
  const graderLabel = graderIsLocal
    ? `Graded by the local model (${String(r.model || 'qwen2.5:14b')})`
    : isReferenceModel(r.model) || !r.model
      ? 'Graded by Gemini 2.5 Pro'
      : `Graded by ${String(r.model)}`;
  const rawFindings = parseJson<Finding[]>(r.findings, []);
  // Right Care rule metadata (§7) — plain_rationale + citation per rule_ref on this note's LVC findings.
  const lvcRefs = Array.from(new Set(rawFindings.map((f) => f.rule_ref).filter(Boolean).map((x) => String(x))));
  const ruleRows = lvcRefs.length
    ? await run(`SELECT id, plain_rationale, statement, citation_doi, citation_pmid, citation_url FROM lvc_recommendations WHERE id = ANY($1)`, [lvcRefs]).catch(() => [])
    : [];
  const ruleMap: Record<string, LvcRuleInfo> = {};
  for (const rr of ruleRows as Record<string, unknown>[]) {
    // L7 — the ONE resolvability predicate (provenance-tier-core), computed once per rule here and
    // consumed by both the grounding label and the source-link gate below. Never reimplemented.
    const resolves = citationResolves({
      citation_doi: rr.citation_doi == null ? null : String(rr.citation_doi),
      citation_pmid: rr.citation_pmid == null ? null : String(rr.citation_pmid),
      citation_url: rr.citation_url == null ? null : String(rr.citation_url),
    });
    ruleMap[String(rr.id)] = {
      plain_rationale: rr.plain_rationale ? String(rr.plain_rationale) : (rr.statement ? String(rr.statement) : null),
      citation: rr.citation_url ? String(rr.citation_url) : (rr.citation_pmid ? `https://pubmed.ncbi.nlm.nih.gov/${rr.citation_pmid}/` : null),
      resolves,
    };
  }
  const nLowValue = rawFindings.filter((f) => f.verdict === 'low-value').length;
  const pdqi = parseJson<Pdqi[]>(r.pdqi9, []);
  const suggestions = parseJson<Sugg[]>(r.suggestions, []).sort((a, b) => a.priority - b.priority);
  const sources = parseJson<Source[]>(r.sources, []);
  // Retire display-filter (EVEN-LVC-GROUNDING §6, Phase 2.1): hide citations of RETIRED even-lvc
  // assertions from this view (display-only; stored citation_ids/sources are NOT rewritten). Best-effort
  // — soft-fails to [] so the page never breaks; empty (the current 0-retired state) ⇒ byte-identical.
  const retiredEvenIds = (await run(`SELECT id FROM even_lvc_assertions WHERE status = 'retired'`, []).catch(() => []))
    .map((rr) => String((rr as Record<string, unknown>).id));

  // Neon may hand timestamptz back as a JS Date; normalise to ISO so the ::timestamptz casts below always parse.
  const noteDateRaw = r.note_date instanceof Date ? r.note_date.toISOString() : String(r.note_date || '');
  const noteDateMs = new Date(noteDateRaw).getTime();
  const noteDate = Number.isFinite(noteDateMs) ? new Date(noteDateMs).toISOString() : noteDateRaw;

  // Feedback (PRD §4.4): the audit-scope panel shows only whole-audit rows (legacy rows have a null
  // scope and read as 'audit'); per-finding current state is the latest row per finding_ref; missed
  // flags are their own list. All wrapped in .catch — before the migrate route adds the columns the
  // scope-filtered reads return empty rather than 500 (the documented migrate-first sequence).
  const [feedback, findingStateRows, missedRows, prevR, nextR] = await Promise.all([
    run(`SELECT id, created_at, verdict, comment, author FROM opd_audit_feedback WHERE audit_id = $1 AND app_source = $2 AND (scope = 'audit' OR scope IS NULL) AND study IS NOT DISTINCT FROM $3 ORDER BY created_at DESC`, [id, APP, null]).catch(() => []),
    run(`SELECT DISTINCT ON (finding_ref) finding_ref, verdict FROM opd_audit_feedback WHERE audit_id = $1 AND app_source = $2 AND scope = 'finding' AND finding_ref IS NOT NULL AND study IS NOT DISTINCT FROM $3 ORDER BY finding_ref, created_at DESC`, [id, APP, null]).catch(() => []),
    run(`SELECT id, created_at, comment, author FROM opd_audit_feedback WHERE audit_id = $1 AND app_source = $2 AND scope = 'missed' AND study IS NOT DISTINCT FROM $3 ORDER BY created_at DESC`, [id, APP, null]).catch(() => []),
    run(
      `SELECT id FROM opd_note_audits
       WHERE app_source = $1 AND engine_version = ${ENG_FAMILY_SQL}
         AND (note_date AT TIME ZONE 'Asia/Kolkata')::date = ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date
         AND (note_date < $2::timestamptz OR (note_date = $2::timestamptz AND id::text < $3))
       ORDER BY note_date DESC, id DESC LIMIT 1`, [APP, noteDate, id]).catch(() => []),
    run(
      `SELECT id FROM opd_note_audits
       WHERE app_source = $1 AND engine_version = ${ENG_FAMILY_SQL}
         AND (note_date AT TIME ZONE 'Asia/Kolkata')::date = ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date
         AND (note_date > $2::timestamptz OR (note_date = $2::timestamptz AND id::text > $3))
       ORDER BY note_date ASC, id ASC LIMIT 1`, [APP, noteDate, id]).catch(() => []),
  ]);
  const prevId = prevR[0]?.id ? String(prevR[0].id) : null;
  const nextId = nextR[0]?.id ? String(nextR[0].id) : null;

  const docUid = r.doctor_uid ? String(r.doctor_uid) : null;
  const uid = r.uid ? String(r.uid) : '';
  const [docNames, noteRow, specRows] = await Promise.all([
    docUid ? fetchDoctorNames([docUid]).catch(() => ({} as Record<string, string>)) : Promise.resolve({} as Record<string, string>),
    uid ? fetchOpdNoteByUid(uid).catch(() => null) : Promise.resolve(null),
    docUid ? run(`SELECT speciality FROM doctor_directory WHERE doctor_uid = $1 LIMIT 1`, [docUid]).catch(() => []) : Promise.resolve([]),
  ]);
  const doctor = (docUid && docNames[docUid]) || doctorLabel(docUid);
  // B4 — show the clinician's real specialty (doctor directory) rather than the raw prescription type,
  // which mislabels every specialist as a GP.
  const specialty = (specRows as Record<string, unknown>[])[0]?.speciality ? String((specRows as Record<string, unknown>[])[0].speciality) : null;
  const parsed = noteRow ? rowToOpdCase(noteRow) : null;
  const note: DeidOpdCase | null = parsed?.case ?? null;
  if (note) enrichOpdMeds(note.medications);
  const prescriptionUrl = parsed?.keys.prescriptionUrl ?? null;

  // ── domain scores + findings grouped by domain (worst domain first) ───────────
  const scores = Object.fromEntries(DOMAINS.map((d) => [d.key, n(r[d.col])])) as Record<OpdDomain, number>;
  // B3 — the "fields present but content thin" flag, derived from stored doc score + PDQI (no re-audit).
  const docFlag = documentationAdequacyFlag(scores.documentation, pdqi);
  const pdqiAssessed = pdqi.length > 0;
  const domainOrder = DOMAINS.filter((d) => !(d.key === 'note_quality' && !pdqiAssessed))
    .slice().sort((a, b) => scores[a.key] - scores[b.key]).map((d) => d.key as string);
  const groupRank = (dom: string) => { const i = domainOrder.indexOf(dom); return i === -1 ? 99 : i; };
  const findings = rawFindings.slice().sort((a, b) => groupRank(a.domain) - groupRank(b.domain));
  // Apply the retire filter to the render pair only (order + count preserved — only citation_ids /
  // source numbering change). Empty retired set ⇒ the original arrays, byte-identical to today.
  const { findings: renderFindings, sources: renderSources } = retiredEvenIds.length
    ? stripRetiredEvenCitations(findings, sources, retiredEvenIds)
    : { findings, sources };
  const countByDomain: Record<string, number> = {};
  for (const f of rawFindings) countByDomain[f.domain] = (countByDomain[f.domain] || 0) + 1;

  // ── U1-A severity tiers (ratified table v1.0) — DERIVED at read time, stored set unchanged. ──
  // Tier 1 renders first (visually distinct), tier 2 as rows (domain-grouped, worst first),
  // tier 3 as a COUNT (never rows — the entire point), praise as a count OUTSIDE the tier list
  // (O1b — stored exactly as before, nothing deleted). Unknown kinds land in tier 2 and are
  // counted (O1c). The action list below is tier 1 + tier 2 only.
  const tiers = bucketByTier(renderFindings);
  const tier2Sorted = tiers.tier2.slice().sort((a, b) => groupRank(a.domain) - groupRank(b.domain));
  const displayFindings = [...tiers.tier1, ...tier2Sorted];
  const tier2Domains = domainOrder.filter((d) => tier2Sorted.some((f) => f.domain === d));
  const tier2Other = tier2Sorted.filter((f) => !domainOrder.includes(f.domain));

  // Anchors computed on the DISPLAY order so chip numbers match the cards. Tier-3/praise findings
  // render as counts, not rows, so they take no chip.
  const anchors = anchorFindings(
    displayFindings.map((f) => ({ subject: f.subject, domain: f.domain, verdict: f.verdict })),
    {
      medications: note ? note.medications.map((m) => String(m.resolvedGeneric || m.generic || m.brand || '')) : [],
      investigations: note ? note.investigations : [],
    },
  );
  const grouped = anchorsByTarget(anchors);

  // ── feedback read-back state (PRD §4.4 / §9) ──────────────────────────────────
  const triage: Record<string, string> = {};
  for (const row of findingStateRows as Record<string, unknown>[]) {
    if (row.finding_ref && row.verdict) triage[String(row.finding_ref)] = String(row.verdict);
  }
  const missed = missedRows as unknown as MissedEntry[];

  // Feature B seed (PRD §1B): total = findings with a finding_ref (triageable); triagedRefs = those
  // already triaged (reuse the current-state map above so live re-verdicts dedupe across the seed).
  // U1-A: the triage seed follows the ACTION LIST (tier 1 + 2) — tier-3/praise findings render as
  // counts, not rows, so they cannot be (and need not be) triaged from this page. Stored findings
  // and past triage rows are untouched.
  const triageableRefs = new Set(displayFindings.filter((f) => f.finding_ref).map((f) => String(f.finding_ref)));
  const triagedRefs = Object.keys(triage).filter((ref) => triageableRefs.has(ref));

  // Escalation package (PRD §9.5): de-identified note + CDMSS findings + domain scores +
  // engine_version + a fixed re-audit prompt. Built here (server), handed to EscalateButton for
  // client-side Copy / Download. No PHI: `note` is already de-identified (DeidOpdCase).
  const escalationPackage = buildEscalationPackage({ uid, doctor, band, index, note, findings, scores, engineVersion: OPD_ENGINE_VERSION, notAssessed });

  // ── the grade story ───────────────────────────────────────────────────────────
  const ranked = DOMAINS.filter((d) => !(d.key === 'note_quality' && !pdqiAssessed))
    .map((d) => ({ ...d, score: scores[d.key] })).sort((a, b) => a.score - b.score);
  const worst = ranked[0], second = ranked[1], best = ranked[ranked.length - 1];
  const lowVal = findings.find((f) => f.verdict === 'low-value');
  // S0 D5 — the story never narrates a grade that is not a measurement.
  const story = notAssessed
    ? 'The grading model could not assess this note at this engine version, so no grade is shown. Deterministic findings (dosing, interactions, completeness) below remain valid.'
    : index >= 70
      ? `A solid Band ${band} note — ${best.label.toLowerCase()} leads (${best.score}); the main headroom is ${worst.label.toLowerCase()} (${worst.score}).`
      : `Graded ${band} mainly on ${worst.label.toLowerCase()} (${worst.score})${lowVal ? ` — ${lowVal.subject.toLowerCase()}` : ''}${second && second.score < 55 ? `, with ${second.label.toLowerCase()} (${second.score}) close behind` : ''}; ${best.label.toLowerCase()} held up (${best.score}).`;
  const statusWord = notAssessed ? 'not assessed' : index >= 70 ? 'on track' : index >= 55 ? 'watch' : 'needs attention';

  // Stage 3 (opd-longitudinal/0.1) — the stored longitudinal block + a live as-of chart-read for the
  // panel (reuse present-core; recomputed at render because the block stores findings, not the view).
  const longitudinal = parseJson<LongitudinalBlockView | null>(r.longitudinal, null);
  let longitudinalView: MemberStateView | null = null;
  if (process.env.OPD_LONGITUDINAL_ENABLED === '1' && longitudinal && uid) {
    try {
      const indUid = await individualUidForPresc(uid);
      if (indUid) {
        const snap = await getMemberSnapshotAsOf(indUid, longitudinal.asOf, new Date().toISOString(), uid);
        if (snap) longitudinalView = presentMemberState(snap);
      }
    } catch { /* chart-read is best-effort; the stored findings still render */ }
  }

  // TOC sections that actually exist on this page.
  const toc: { href: string; label: string }[] = [
    { href: '#note', label: 'The note' },
    ...(longitudinal ? [{ href: '#longitudinal', label: 'Longitudinal' }] : []),
    ...(findings.length ? [{ href: '#findings', label: `Findings · ${findings.length}` }] : []),
    ...(pdqiAssessed ? [{ href: '#pdqi', label: 'PDQI-9 radar' }] : []),
    ...(suggestions.length ? [{ href: '#suggestions', label: `Suggestions · ${suggestions.length}` }] : []),
    ...(sources.length ? [{ href: '#sources', label: `Sources · ${sources.length}` }] : []),
    { href: '#verdict', label: 'Your verdict' },
  ];

  return (
    <div>
      <Link href="/admin/opd-audit" className="text-sm text-brand hover:underline">← OPD Audit</Link>

      <div className="mt-3 items-start gap-4 lg:grid lg:grid-cols-[224px,minmax(0,1fr)]">

        {/* ── persistent audit sidebar ── */}
        <aside className="self-start rounded-xl border border-slate-200 bg-white p-3.5 lg:sticky lg:top-4">
          <div className="text-center">
            {/* S0 D5 — a marked row's NQI/band are suppressed, never presented as a score. */}
            {notAssessed ? (
              <>
                <div className="mx-auto flex h-[66px] w-[66px] flex-col items-center justify-center rounded-full border-[5px] border-slate-300 bg-white">
                  <span className="text-[21px] font-medium leading-none text-slate-400">—</span>
                </div>
                <div className="mt-1.5 text-[12px] font-medium text-slate-500">Not assessed at this engine version</div>
              </>
            ) : (
              <>
                <div className="mx-auto flex h-[66px] w-[66px] flex-col items-center justify-center rounded-full bg-white" style={{ border: `5px solid ${bandColor(band)}` }}>
                  <span className="text-[21px] font-medium leading-none" style={{ color: bandColor(band) }}>{index}</span>
                </div>
                <div className="mt-1.5 text-[12px] font-medium" style={{ color: bandColor(band) }}>Band {band} · {statusWord}</div>
              </>
            )}
            <div className="mt-1 text-[11px] leading-snug text-slate-500">{fmtIstTime(noteDate)} · {doctor}<br /><span className="text-[10px] text-slate-400">{specialty || String(r.prescription_type || r.consult_type || 'OPD')}</span></div>
            {/* GRADER PROVENANCE (PRD §4.3, 2 Aug 2026): a clinician reading a band must be able to
                see WHAT produced it. Plain words, not a raw model string — and a local-model grade
                is called out, because a 14B model's judgment is not a Gemini judgment. */}
            <div className={`mt-1.5 text-[10.5px] leading-snug ${graderIsLocal ? 'font-medium text-amber-700' : 'text-slate-400'}`}>
              {graderLabel}
              <br /><span className="text-[9.5px] text-slate-400">{String(r.engine_version || OPD_ENGINE_VERSION)}</span>
            </div>
          </div>

          <div className="mt-3 border-t border-slate-100 pt-2.5">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-400">Domains{findings.length ? ' · click to jump' : ''}</div>
            {DOMAINS.map((d) => {
              const na = d.key === 'note_quality' && !pdqiAssessed;
              const v = scores[d.key];
              const c = scoreColor(v);
              const cnt = countByDomain[d.key] || 0;
              const isWorst = !na && d.key === worst.key && v < 55;
              const bar = (
                <div key={d.key} className={`mb-2.5 ${cnt > 0 ? 'cursor-pointer' : ''}`}>
                  <div className="flex items-baseline justify-between text-[11px]">
                    <span className={isWorst ? 'font-medium' : 'text-slate-600'} style={isWorst ? { color: c } : undefined}>{d.label}</span>
                    {na ? <span className="text-slate-300">—</span> : <span className="font-medium tabular-nums" style={{ color: c }}>{v}</span>}
                  </div>
                  <div className="mt-[3px] h-[7px] rounded bg-slate-100">
                    {!na && <div className="h-full rounded" style={{ width: `${Math.max(2, v)}%`, background: c }} />}
                  </div>
                  {(cnt > 0 || isWorst) && (
                    <div className="mt-[2px] text-[9.5px]" style={{ color: isWorst ? c : '#94a3b8' }}>
                      {na ? 'not assessed' : `${cnt > 0 ? `${cnt} finding${cnt > 1 ? 's' : ''}` : ''}${isWorst ? `${cnt > 0 ? ' · ' : ''}main drag ↓` : ''}`}
                    </div>
                  )}
                  {d.key === 'documentation' && docFlag && (
                    <div className="mt-[3px] rounded bg-amber-50 px-1.5 py-1 text-[9.5px] leading-snug text-amber-700" title={docFlag.detail}>
                      ⚠ {docFlag.label} — completeness ≠ adequacy
                    </div>
                  )}
                </div>
              );
              return cnt > 0 ? <a key={d.key} href={`#fd-${d.key}`} className="block no-underline">{bar}</a> : bar;
            })}
          </div>

          {nLowValue > 0 && (
            <a href="#fd-appropriateness" className="mt-2 block border-t border-slate-100 pt-2 text-[11px] font-medium text-amber-700 no-underline hover:text-amber-800">
              Right care · {nLowValue} low-value action{nLowValue > 1 ? 's' : ''}
            </a>
          )}

          <nav className="border-t border-slate-100 pt-2 text-[11.5px] leading-[2.05]">
            {toc.map((t) => <a key={t.href} href={t.href} className="block text-slate-500 hover:text-brand">{t.label}</a>)}
          </nav>

          {(triageableRefs.size > 0 || missed.length > 0) && (
            <TriageProgress total={triageableRefs.size} triagedRefs={triagedRefs} missed={missed.length} />
          )}

          <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2.5 text-[11px]">
            {prevId ? <Link href={`/admin/opd-audit/${prevId}`} className="text-brand hover:underline">‹ prev</Link> : <span className="text-slate-300">‹ prev</span>}
            <span className="flex flex-col items-center gap-0.5 text-[10px]">
              {prescriptionUrl ? <a href={prescriptionUrl} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">actual PDF</a> : null}
              <a href={`/api/opd-audit/export-pdf?id=${id}`} className="text-brand hover:underline">note + audit PDF</a>
              {r.trace_id ? <Link href={`/admin/observability/${r.trace_id}`} className="text-slate-400 hover:text-brand">trace</Link> : null}
            </span>
            {nextId ? <Link href={`/admin/opd-audit/${nextId}`} className="text-brand hover:underline">next ›</Link> : <span className="text-slate-300">next ›</span>}
          </div>
        </aside>

        {/* ── main column: story → note → findings → radar → suggestions → sources → verdict ── */}
        <div className="mt-4 min-w-0 lg:mt-0">
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-[12.5px] leading-relaxed text-slate-700">{story}</div>

          {longitudinal && <LongitudinalPanel block={longitudinal} view={longitudinalView} />}

          <div id="note" className="mt-4 scroll-mt-4">
            {/* Layer 1 · Facts — the pane reconstructs db13 as it is NOW, at render time. It is not
                an audit-time snapshot (that is PR 3), and it must not imply these facts drove the
                audit. Architecture §3.4. */}
            <LayerHeader n={LAYER_COPY.facts.n} title={LAYER_COPY.facts.title} line={LAYER_COPY.facts.line} />
            <NotePanel note={note} pdfUrl={prescriptionUrl} grouped={grouped} findings={displayFindings} />
          </div>

          {findings.length > 0 && (
            <div id="findings" className="mt-5 scroll-mt-4">
              {/* Layer 2 · Findings — the layer is OUTER, the severity tiers stay INNER and
                  unchanged (V's IA ruling, 20 Aug). Each card carries its origin, read from the
                  stored source field. Architecture §3.3, §3.7. */}
              <LayerHeader n={LAYER_COPY.findings.n} title={LAYER_COPY.findings.title} line={LAYER_COPY.findings.line} />
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400">Findings · grouped by severity tier · numbered where they sit in the note</div>
                <EscalateButton pkg={escalationPackage} uid={uid} />
              </div>
              {/* U1-A (ratified tier table v1.0): the reporting unit, stated explicitly (§1.4). */}
              <p className="mb-1 text-[11.5px] leading-snug text-slate-400">
                Reporting unit: one row per finding on this note. Tier 1 = escalate now · tier 2 = act this week · tier 3 = log only, shown as a count. Tiers are derived from the stored finding at read time — nothing is deleted or re-scored.
              </p>
              {/* Ruling R-7 (bug 9b) — ONCE per page, not per finding. The grounding chip records
                  attachment, not support; saying so here keeps 82.4% of cards honest until the
                  phase-3 support check lands. */}
              <p className="mb-2 text-[11.5px] leading-snug text-slate-400">
                A citation label records that a source was attached to a finding. It does not verify that the source supports the finding. A support check is in build.
              </p>
              <ReviewerBar />
              {/* ── Tier 1 — escalate now: rows at the top, visually distinct ── */}
              {tiers.tier1.length > 0 && (
                <div className="mb-3 rounded-lg border-2 border-red-300 bg-red-50/40 p-2">
                  <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-red-700">
                    Tier 1 · Escalate now <span className="font-normal normal-case tracking-normal text-red-600">possible active patient risk · {tiers.tier1.length} finding{tiers.tier1.length > 1 ? 's' : ''}</span>
                  </div>
                  <div className="space-y-2">{displayFindings.map((f, i) => ({ f, num: i + 1 })).slice(0, tiers.tier1.length).map(({ f, num }) => <FindingCard key={num} f={f} num={num} sources={renderSources} auditId={id} triage={triage} ruleMap={ruleMap} />)}</div>
                </div>
              )}
              {/* ── Tier 2 — act this week: rows, domain-grouped, worst first ── */}
              {tier2Sorted.length > 0 && (
                <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-slate-500">
                  Tier 2 · Act this week <span className="font-normal normal-case tracking-normal text-slate-400">{tier2Sorted.length} finding{tier2Sorted.length > 1 ? 's' : ''}</span>
                </div>
              )}
              {tier2Domains.map((dom) => {
                const list = displayFindings.map((f, i) => ({ f, num: i + 1 })).filter((x) => x.f.domain === dom && tier2Sorted.includes(x.f));
                const v = scores[dom as OpdDomain];
                return (
                  <div key={dom} id={`fd-${dom}`} className="mb-3 scroll-mt-4">
                    <div className="mb-1.5 flex items-baseline gap-2 text-[10.5px] font-semibold uppercase tracking-[0.06em]" style={{ color: scoreColor(v) }}>
                      {DOMAIN_LABEL[dom] || dom.replace('_', ' ')} <span className="font-normal normal-case tracking-normal text-slate-400">score {v} · {list.length} finding{list.length > 1 ? 's' : ''}</span>
                    </div>
                    {/* RIGHT CARE sub-header inside the Appropriateness group (§7) */}
                    {dom === 'appropriateness' && list.some((x) => x.f.verdict === 'low-value') && (
                      <div className="mb-1.5 rounded-md border border-amber-200 bg-amber-50/50 px-2 py-1 text-[10.5px] font-medium text-amber-800">
                        Right Care · {list.filter((x) => x.f.verdict === 'low-value').length} low-value action{list.filter((x) => x.f.verdict === 'low-value').length > 1 ? 's' : ''} per Choosing Wisely / NCG rules
                      </div>
                    )}
                    <div className="space-y-2">{list.map(({ f, num }) => <FindingCard key={num} f={f} num={num} sources={renderSources} auditId={id} triage={triage} ruleMap={ruleMap} />)}</div>
                  </div>
                );
              })}
              {tier2Other.length > 0 && (
                <div className="mb-3 space-y-2">{displayFindings.map((f, i) => ({ f, num: i + 1 })).filter((x) => tier2Other.includes(x.f)).map(({ f, num }) => <FindingCard key={num} f={f} num={num} sources={renderSources} auditId={id} triage={triage} ruleMap={ruleMap} />)}</div>
              )}
              {/* ── Tier 3 — log only: a COUNT, never rows (the entire point of U1-A) ── */}
              {tiers.tier3.length > 0 && (
                <div className="mb-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-500">
                  <b className="text-slate-600">Tier 3 · Log only — {tiers.tier3.length} finding{tiers.tier3.length > 1 ? 's' : ''}</b> (blank fields, coding, formulary/metadata notes). Logged and stored; not shown as rows so the tiers above stay visible.
                </div>
              )}
              {/* ── Praise — outside the tier list (O1b): a count; stored exactly as before ── */}
              {tiers.praise.length > 0 && (
                <div className="mb-2 rounded-md border border-emerald-200 bg-emerald-50/50 px-2.5 py-1.5 text-[11px] text-emerald-700">
                  <b>Praise · {tiers.praise.length}</b> — positive finding{tiers.praise.length > 1 ? 's' : ''} on this note. Not an action; stored unchanged and counted here.
                </div>
              )}
              {tiers.unlisted > 0 && (
                <div className="mb-2 text-[10.5px] text-slate-400">{tiers.unlisted} finding{tiers.unlisted > 1 ? 's' : ''} carried a kind outside the ratified tier table and took the tier-2 default (O1c).</div>
              )}
              <MissedFindingCapture auditId={id} initial={missed} />
            </div>
          )}

          {pdqiAssessed && (
            <div id="pdqi" className="mt-5 scroll-mt-4">
              {/* Layer 3 · Model ratings — PDQI-9 is model-derived and ~25% of the index. Proposals
                  join this layer in PR 2; they do not exist yet. Architecture §3.1. */}
              <LayerHeader n={LAYER_COPY.model.n} title={LAYER_COPY.model.title} line={LAYER_COPY.model.line} />
              <div className="rounded-xl border border-slate-200 bg-white p-3.5">
                <PdqiRadar pdqi={pdqi} />
              </div>
            </div>
          )}

          {suggestions.length > 0 && (
            <details id="suggestions" className="group mt-4 scroll-mt-4 rounded-xl border border-slate-200 bg-white" open>
              <summary className="cursor-pointer select-none px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400 hover:text-slate-600">Suggestions · {suggestions.length}</summary>
              <ol className="space-y-1.5 px-4 pb-3">
                {suggestions.map((s, i) => (
                  <li key={i} className="flex gap-2 rounded-lg border border-slate-100 bg-slate-50/50 p-2.5 text-[11.5px] text-slate-700">
                    <span className="font-medium text-brand">{s.priority}</span><span>{s.text}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}

          {sources.length > 0 && (
            <details id="sources" className="group mt-4 scroll-mt-4 rounded-xl border border-slate-200 bg-white">
              <summary className="cursor-pointer select-none px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400 hover:text-slate-600">Sources · retrieved from the CDMSS corpus · {sources.length}</summary>
              <div className="px-4 pb-3"><SourcesPanel sources={renderSources} /></div>
            </details>
          )}

          <div id="verdict" className="mt-4 scroll-mt-4"><FeedbackPanel auditId={id} uid={uid || null} initial={feedback as unknown as FeedbackEntry[]} /></div>

          {/* Ask the agent — the shared persisted case conversation (CASE-AGENTS-SPINE PRD P1).
              Additive: it sits BELOW the adjudication panel because the pills stay the primary
              adjudication loop (D2), and it changes nothing above it — no NQI, no band, no
              feedback row, no MemberState (§3.3). Before migration 0046 has run the box is simply
              empty and its turns do not persist; nothing else on this page notices. */}
          <div id="ask" className="mt-4 scroll-mt-4"><OpdCaseAskPanel auditId={id} /></div>

          <p className="mt-5 text-[11px] text-slate-400">Advisory note-level quality proxy — documentation, PDQI-9, appropriateness and prescribing safety as demonstrated in the note. uid <code className="rounded bg-slate-100 px-1">{uid}</code> links back to the source encounter in db13. Not an outcomes measure; not a clinician scorecard.</p>
        </div>
      </div>
    </div>
  );
}
