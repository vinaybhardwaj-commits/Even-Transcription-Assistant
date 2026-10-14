// /admin/ipd-audit/episodes/[id] — the episode-audit DETAIL page (PRD §10). Server-rendered,
// admin cookie gate, direct store calls.
//
// 404 UNLESS THE FLAG IS ON (§9), exactly as the list page is.
//
// PHI: the patient name in the header is resolved AT RENDER TIME from db13 by the existing
// `namesForIpUids` path in lib/ipd-audit/db13.ts — the same read-time join the discharge surface
// uses. It is never stored on the audit row and never reaches a model. If db13 is unreachable the
// header simply shows the encounter id; a missing name degrades the page, it never fails it.
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { namesForIpUids } from '@/lib/ipd-audit/db13';
import { checkpointsForAudit, dischargeEngineScores, episodeAuditById } from '@/lib/ipd-episode/store';
import { DischargeEngineScore, DivergenceCounts, EpisodeTabs, InsufficientRecord, InternalIndex, ScoringNote, Locked, fmtDay } from '../ui';
import { CheckpointPanels, CommentaryPanel, FindingsPanel, TimelinePanel, UnassessablePanel } from './panels';

export const dynamic = 'force-dynamic';

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v == null ? '—' : String(v));
const arr = (v: unknown): Row[] => (Array.isArray(v) ? v as Row[] : []);

export default async function EpisodeAuditDetail({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ locked?: string }>;
}) {
  if (process.env.IPD_EPISODE_AUDIT_ENABLED !== '1') notFound();
  const { id } = await params;
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) return <Locked configured={adminTokenConfigured()} bad={sp.locked === '1'} />;

  const audit = await episodeAuditById(id);
  if (!audit) notFound();

  const encounterId = String(audit.encounter_id);
  const [checkpoints, sibling, names] = await Promise.all([
    checkpointsForAudit(id),
    dischargeEngineScores([encounterId]),
    namesForIpUids([encounterId]).catch(() => ({} as Record<string, { patientName: string | null; uhid: string | null }>)),
  ]);
  const sib = sibling[encounterId] ?? { care_value_index: null, band: null };
  const patientName = names[encounterId]?.patientName ?? null;

  const findings = arr(audit.findings);
  const events = arr(audit.real_course);
  const commentary = (audit.commentary ?? null) as Row | null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link href="/admin/ipd-audit/episodes" className="text-[12px] font-medium text-slate-500 hover:text-slate-800">← Episode audits</Link>
      <h1 className="mt-2 font-serif text-[24px] font-semibold text-slate-900">
        {encounterId}
        {patientName ? <span className="ml-2 text-[15px] font-normal text-slate-500">{patientName}</span> : null}
      </h1>
      <EpisodeTabs active="episodes" />

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-3">
        {/* DECISION 50: no band here either. DECISION 51: below 30 evaluated expectations the
            header says "insufficient record" instead of implying a comparable measurement. */}
        <ScoringNote status={audit.scoring_status as string | null} />
        <InsufficientRecord evaluated={audit.expectations_evaluated == null ? null : Number(audit.expectations_evaluated)} />
        <DivergenceCounts
          penalty={audit.penalty_total == null ? null : Number(audit.penalty_total)}
          evaluated={audit.expectations_evaluated == null ? null : Number(audit.expectations_evaluated)}
          divergent={audit.n_divergent == null ? null : Number(audit.n_divergent)}
        />
        <DischargeEngineScore cvi={sib.care_value_index} band={sib.band} />
        <span className="text-[12px] text-slate-600">
          <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Completeness </span>
          {audit.completeness_pct == null ? '—' : `${audit.completeness_pct}%`}
        </span>
        <span className="text-[12px] text-slate-600">
          <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Speciality </span>{s(audit.speciality)}
        </span>
        <span className="text-[12px] text-slate-600">
          <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Stay </span>
          {fmtDay(audit.admitted_at)} → {fmtDay(audit.discharged_at)}{audit.los_days == null ? '' : ` · ${audit.los_days}d`}
        </span>
        <span className="text-[12px] text-slate-600">
          <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Discharge type </span>{s(audit.discharge_type)}
        </span>
      </div>

      {/* The raw index, drill-in only and labelled for what it is. Never on the list. */}
      <p className="mt-2">
        <InternalIndex
          index={audit.divergence_index == null ? null : Number(audit.divergence_index)}
          uncertain={!!audit.band_uncertain}
          penalty={audit.penalty_total == null ? null : Number(audit.penalty_total)}
          evaluated={audit.expectations_evaluated == null ? null : Number(audit.expectations_evaluated)}
        />
      </p>

      <p className="mt-2 text-[11px] text-slate-400">
        Engine {s(audit.engine_version)} · checkpoints {s(audit.checkpoint_count)} · scoring {s(audit.scoring_status)} · extraction {s(audit.extraction_version)} ·
        checkpoint model {s(audit.model_checkpoint)} · judge model {s(audit.model_judge)}
      </p>

      <TimelinePanel events={events} />
      <FindingsPanel findings={findings} />
      <UnassessablePanel findings={findings} />
      <CommentaryPanel auditId={id} commentary={commentary} findings={findings} />
      <CheckpointPanels checkpoints={checkpoints} />
    </div>
  );
}
