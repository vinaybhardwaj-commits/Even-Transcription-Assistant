// /admin/scoring-policy — the Scoring policy module index (PRD §5.2).
//
// Three cards: NABH completeness weightage (active), Domain weights and Finding severity (locked).
// Phase C adds a fourth, Lab packages.
//
// ⚠️ The PRD specifies `AdminLayout` with a `breadcrumbs` prop and warns that omitting it breaks
// the build. THERE IS NO AdminLayout OR AdminShell IN THIS REPOSITORY (0 references across 765
// source files). Every admin page here is a plain server component that gates on isAdminUnlocked()
// and renders its own header. This page follows the repo's actual convention — see
// app/admin/ipd-audit/page.tsx. Flagged in the build report.
import Link from 'next/link';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { getActivePolicies } from '@/lib/scoring-policy/store';
import { PHASE_A_NOTE_TYPES, weightedKeysFor } from '@/lib/scoring-policy/weights';
import { activeLabPackages } from '@/lib/scoring-policy/lab-packages';
import { Locked } from '../ipd-audit/ui';

export const dynamic = 'force-dynamic';

const NOTE_TYPE_LABEL: Record<string, string> = {
  discharge_summary: 'Discharge summary',
  opd_rx: 'OPD prescription',
};

export default async function ScoringPolicyIndex({ searchParams }: { searchParams: Promise<{ locked?: string }> }) {
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) return <Locked configured={adminTokenConfigured()} bad={sp.locked === '1'} />;

  const [policies, labPackages] = await Promise.all([
    getActivePolicies(PHASE_A_NOTE_TYPES),
    activeLabPackages(),
  ]);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <nav className="text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">Admin › Scoring policy</nav>
          <h1 className="mt-0.5 font-serif text-[28px] font-semibold leading-tight text-slate-900 sm:text-[31px]">Scoring policy</h1>
          <p className="mt-1 max-w-2xl text-[13.5px] text-slate-500">
            How much each thing counts. Changes here are versioned, carry a written reason, and are recalculated over
            existing audits — nothing is ever re-run and no stored score is overwritten.
          </p>
        </div>
        <form method="POST" action="/api/admin/unlock?action=logout"><button className="whitespace-nowrap text-xs text-slate-400 hover:text-brand">Lock</button></form>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* ── active ── */}
        <Link
          href="/admin/scoring-policy/nabh-completeness"
          className="group rounded-xl border border-slate-200 bg-white p-4 transition hover:border-brand hover:shadow-sm"
        >
          <div className="text-[13.5px] font-semibold text-slate-900 group-hover:text-brand">NABH completeness weightage</div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-slate-500">
            Set how much each NABH field matters clinically. A missing discharge date need not count the same as a
            missing signature.
          </p>
          <dl className="mt-3 space-y-1 border-t border-slate-100 pt-2.5">
            {PHASE_A_NOTE_TYPES.map((nt) => {
              const p = policies[nt];
              return (
                <div key={nt} className="flex items-baseline justify-between gap-2 text-[11.5px]">
                  <dt className="text-slate-500">{NOTE_TYPE_LABEL[nt]} · {weightedKeysFor(nt).length} fields</dt>
                  <dd className="tabular-nums text-slate-700">
                    {p?.fallback
                      ? <span className="text-amber-600">not yet initialised</span>
                      : <>v{p?.version} <span className="text-slate-400">· {p?.publishedByName ?? 'System'}</span></>}
                  </dd>
                </div>
              );
            })}
          </dl>
        </Link>

        {/* ── Lab packages (Phase C §7.3) — active, and honest about the empty state ── */}
        <Link
          href="/admin/scoring-policy/lab-packages"
          className="group rounded-xl border border-slate-200 bg-white p-4 transition hover:border-brand hover:shadow-sm"
        >
          <div className="text-[13.5px] font-semibold text-slate-900 group-hover:text-brand">Lab packages</div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-slate-500">
            What each package contains, so a panel and one of its own tests are not read as two duplicate orders.
            Maintained by downloading a CSV, editing it, and uploading it back.
          </p>
          <dl className="mt-3 space-y-1 border-t border-slate-100 pt-2.5">
            <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
              <dt className="text-slate-500">{labPackages.packages.length} packages</dt>
              <dd className="tabular-nums text-slate-700">
                {labPackages.origin === 'db'
                  ? <>v{labPackages.version}</>
                  : <span className="text-amber-600">{labPackages.packages.length ? 'from file' : 'not generated yet'}</span>}
              </dd>
            </div>
          </dl>
        </Link>

        {/* ── locked (PRD §5.2) ── */}
        {[
          { title: 'Domain weights', blurb: 'How the six Care-Value domains combine into the headline index.' },
          { title: 'Finding severity', blurb: 'How much a low-value or context-dependent finding deducts.' },
        ].map((c) => (
          <div key={c.title} aria-disabled className="cursor-not-allowed rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-4">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] font-semibold text-slate-400">{c.title}</span>
              <span className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Locked</span>
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-slate-400">{c.blurb}</p>
            <p className="mt-3 border-t border-slate-200 pt-2.5 text-[11.5px] italic text-slate-400">
              Available after completeness weightage is settled.
            </p>
          </div>
        ))}
      </div>

      <p className="mt-5 max-w-2xl text-[12px] leading-relaxed text-slate-400">
        Completeness measures whether a field is filled — not whether what was written is right. It is one of six
        domains, and a band remains a ±1-tier estimate.
      </p>
    </div>
  );
}
