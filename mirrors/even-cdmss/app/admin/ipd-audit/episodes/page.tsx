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
import { DischargeEngineScore, DivergenceCounts, EpisodeTabs, InsufficientRecord, Locked, ScoringNote, fmtDay } from './ui';

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

  // ⚠️ THE INDEX IS NOT SORTABLE, AND FROM ROUND 24 NEITHER IS THE BAND — IT IS NOT SHOWN HERE AT
  // ALL. Ordering rows by a figure that moves between runs would present a ranking the measurement
  // cannot support. The band was a second such figure wearing a steadier-looking label: it is a
  // function of the index, so it moves with it, and after decision 44 removed every unverified
  // absence from the score, eight of twelve episodes banded identically and the column stopped
  // separating anything. THE COUNTS SORT INSTEAD — how many divergences this episode holds, then
  // how many findings it could not settle either way. Both are counts of findings a reader can
  // open, and neither moves the way a rate does.
  const sort = sp.sort === 'discharge' ? 'discharge' : sp.sort === 'recent' ? 'recent' : 'findings';
  const sorted = [...rows].sort((a, b) => {
    if (sort === 'findings') {
      const d = (num(b.n_divergent) ?? 0) - (num(a.n_divergent) ?? 0);
      if (d !== 0) return d;
      const c = (num(b.n_context_dependent) ?? 0) - (num(a.n_context_dependent) ?? 0);
      if (c !== 0) return c;
      return String(b.discharged_at ?? '').localeCompare(String(a.discharged_at ?? ''));
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
        {sortLink('findings', 'Findings')}
        {sortLink('recent', 'Most recent')}
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
                <th className="px-3 py-2 font-semibold">Divergent</th>
                <th className="px-3 py-2 font-semibold">Context-dependent</th>
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
                    {/* ROUND 24 ITEM 3: the band is gone from this surface. What remains is what a
                        reader can act on — the counts, and the penalty and denominator behind them.
                        The band is still stored and still shown on the detail page. */}
                    <td className="px-3 py-2">
                      {/* DECISION 51, and the scoring refusal decision 50 kept */}
                      <ScoringNote status={r.scoring_status as string | null} />
                      <InsufficientRecord evaluated={r.expectations_evaluated == null ? null : Number(r.expectations_evaluated)} />
                      <DivergenceCounts
                        penalty={r.penalty_total == null ? null : Number(r.penalty_total)}
                        evaluated={r.expectations_evaluated == null ? null : Number(r.expectations_evaluated)}
                        divergent={r.n_divergent == null ? null : Number(r.n_divergent)}
                      />
                    </td>
                    {/* Beside it, not inside it: a context-dependent finding is one the engine
                        looked at and could not settle either way. It is not a smaller divergence,
                        and after decision 44 it is where most unverified absences now land — so a
                        reader owed an explanation of a quiet episode looks here first. */}
                    <td className="px-3 py-2 tabular-nums text-slate-600">
                      {r.n_context_dependent == null ? '—' : String(r.n_context_dependent)}
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
