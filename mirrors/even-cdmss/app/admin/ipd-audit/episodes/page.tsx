// /admin/ipd-audit/episodes — the IPD EPISODE audit LIST (PRD §10). Server-rendered, direct store
// calls, admin cookie gate — the same shape as app/admin/ipd-audit/page.tsx.
//
// THE FLAG GATES THIS PAGE, NOT THE PIPELINE (§9). With IPD_EPISODE_AUDIT_ENABLED unset this route
// 404s — indistinguishable from a route that does not exist — while the worker keeps running, so
// the cohort can be built and reviewed before anything is shown to a clinician.
//
// PHI: this page shows link-back keys and scores only. Patient names are resolved at RENDER time
// on the DETAIL page by the existing namesForIpUids path, and never on a list.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { episodeWorklist, dischargeEngineScores, IPD_EPISODE_ENGINE_VERSION } from '@/lib/ipd-episode/store';
import { DischargeEngineScore, DivergenceChip, DivergenceCounts, EpisodeTabs, Locked, fmtDay } from './ui';
import { DIVERGENCE_BANDS } from '@/lib/ipd-episode/judge-core';

export const dynamic = 'force-dynamic';

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const str = (v: unknown): string => (v == null ? '—' : String(v));

export default async function EpisodeAuditList({ searchParams }: {
  searchParams: Promise<{ locked?: string; sort?: string }>;
}) {
  if (process.env.IPD_EPISODE_AUDIT_ENABLED !== '1') notFound();
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) return <Locked configured={adminTokenConfigured()} bad={sp.locked === '1'} />;

  const rows = await episodeWorklist({ limit: 200 });
  const encounterIds = rows.map((r) => String(r.encounter_id));
  const sibling = await dischargeEngineScores(encounterIds);

  // ⚠️ THE INDEX IS NOT SORTABLE. Ordering rows by a figure that moves between runs would
  // present a ranking the measurement cannot support — the list would reorder itself on a re-run of
  // the same episodes. Sorting is by BAND (worst first), then by divergent-finding COUNT within
  // the band, which is a count and does not move the way the index does.
  const bandRank = (r: Record<string, unknown>): number => {
    const i = (DIVERGENCE_BANDS as readonly string[]).indexOf(String(r.divergence_band ?? ''));
    return i < 0 ? 99 : DIVERGENCE_BANDS.length - 1 - i;   // substantial first, unscorable last
  };
  const sort = sp.sort === 'discharge' ? 'discharge' : sp.sort === 'band' ? 'band' : 'recent';
  const sorted = [...rows].sort((a, b) => {
    if (sort === 'band') {
      const d = bandRank(a) - bandRank(b);
      if (d !== 0) return d;
      return (num(b.n_divergent) ?? 0) - (num(a.n_divergent) ?? 0);
    }
    if (sort === 'discharge') {
      const av = sibling[String(a.encounter_id)]?.care_value_index ?? 999;
      const bv = sibling[String(b.encounter_id)]?.care_value_index ?? 999;
      return av - bv;
    }
    return String(b.discharged_at ?? '').localeCompare(String(a.discharged_at ?? ''));
  });

  const sortLink = (key: string, label: string) => (
    <Link href={`/admin/ipd-audit/episodes?sort=${key}`}
      className={`rounded-md px-2 py-1 text-[11px] font-semibold ${sort === key ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}>
      {label}
    </Link>
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">IPD Episode Audit</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-500">
        The whole admission, not one document. An expected next-24-hours course is regenerated blind at each
        day boundary, and the real course is compared against it. Engine <code className="text-[11.5px]">{IPD_EPISODE_ENGINE_VERSION}</code>.
      </p>
      <EpisodeTabs active="episodes" />

      <div className="mt-5 flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Sort</span>
        {sortLink('recent', 'Most recent')}
        {sortLink('band', 'Divergence band')}
        {sortLink('discharge', 'Discharge engine score')}
      </div>

      {sorted.length === 0 ? (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
          No episodes have been audited at this engine version yet. Run the worker at
          <code className="mx-1 text-[11.5px]">/api/ipd-episode/worker?max=2</code> once the migration has been applied.
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-[900px] w-full text-left text-[13px]">
            <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Encounter</th>
                <th className="px-3 py-2 font-semibold">Speciality</th>
                <th className="px-3 py-2 font-semibold">Discharged</th>
                <th className="px-3 py-2 font-semibold">LOS</th>
                <th className="px-3 py-2 font-semibold">Divergence</th>
                <th className="px-3 py-2 font-semibold">Discharge engine score</th>
                <th className="px-3 py-2 font-semibold">Findings</th>
                <th className="px-3 py-2 font-semibold">Completeness</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const id = String(r.id);
                const enc = String(r.encounter_id);
                const sib = sibling[enc] ?? { care_value_index: null, band: null };
                return (
                  <tr key={id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                    <td className="px-3 py-2">
                      <Link href={`/admin/ipd-audit/episodes/${id}`} className="font-semibold text-brand hover:underline">{enc}</Link>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{str(r.speciality)}</td>
                    <td className="px-3 py-2 text-slate-600">{fmtDay(r.discharged_at)}</td>
                    <td className="px-3 py-2 tabular-nums text-slate-600">{r.los_days == null ? '—' : `${r.los_days}d`}</td>
                    <td className="px-3 py-2">
                      <DivergenceChip band={r.divergence_band as string | null} uncertain={!!r.band_uncertain} status={r.scoring_status as string | null} />
                      {/* ROUND 15 ITEM 1: the band alone cannot triage a worklist — two episodes
                          band the same while one holds four findings and the other forty. */}
                      <div className="mt-0.5">
                        <DivergenceCounts
                          penalty={r.penalty_total == null ? null : Number(r.penalty_total)}
                          evaluated={r.expectations_evaluated == null ? null : Number(r.expectations_evaluated)}
                          divergent={r.n_divergent == null ? null : Number(r.n_divergent)}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2"><DischargeEngineScore cvi={sib.care_value_index} band={sib.band} /></td>
                    <td className="px-3 py-2 text-[12px] text-slate-600">
                      {String(r.n_findings ?? 0)} total · {String(r.n_divergent ?? 0)} divergent · {String(r.n_unassessable ?? 0)} unassessable
                      <div className="text-[10.5px] text-slate-400">{String(r.n_divergence_pass ?? 0)} divergence · {String(r.n_fidelity_pass ?? 0)} fidelity</div>
                    </td>
                    <td className="px-3 py-2 tabular-nums text-slate-600">{r.completeness_pct == null ? '—' : `${r.completeness_pct}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
