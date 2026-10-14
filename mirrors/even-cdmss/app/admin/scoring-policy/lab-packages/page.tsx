// /admin/scoring-policy/lab-packages — package maintenance by CSV round-trip (§7.3).
//
// Deliberately NOT a bespoke editor (decision §1.15): download the current set, edit in Excel,
// upload, review a diff, publish with a rationale. It reuses the Scoring policy module's versioning,
// publish flow and history wholesale — the only new UI is a download button and a file input.
import Link from 'next/link';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { activeLabPackages } from '@/lib/scoring-policy/lab-packages';
import { Locked } from '../ui';
import LabPackagesEditor from './ui';

export const dynamic = 'force-dynamic';

export default async function LabPackagesPage({ searchParams }: { searchParams: Promise<{ locked?: string }> }) {
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) {
    return <Locked configured={adminTokenConfigured()} bad={sp.locked === '1'} next="/admin/scoring-policy/lab-packages" />;
  }

  const { packages, version, origin } = await activeLabPackages();

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <nav className="text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">
            <Link href="/admin/scoring-policy" className="hover:underline">Admin › Scoring policy</Link> › Lab packages
          </nav>
          <h1 className="mt-0.5 font-serif text-[28px] font-semibold leading-tight text-slate-900 sm:text-[31px]">Lab packages</h1>
          <p className="mt-1 max-w-2xl text-[13.5px] text-slate-500">
            What each package contains, so the audit stops reading a panel and one of its own tests as two
            duplicate orders. Generated from the hospital&rsquo;s own order data — you correct it, you don&rsquo;t author it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600">
            {origin === 'db' ? `v${version} · live` : 'from file'}
          </span>
          <Link href="/admin/scoring-policy/nabh-completeness/history?note_type=lab_packages" className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
            Version history
          </Link>
        </div>
      </div>

      {packages.length === 0 && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] leading-relaxed text-amber-900">
          <b>No packages are loaded.</b> The generator has not been run yet, so the judge sees no package
          context and behaves exactly as it did before this feature existed — nothing is mis-flagged, but nothing
          is fixed either. Run{' '}
          <code className="font-mono text-[11.5px]">node --env-file=.env.local --import tsx scripts/generate-lab-packages.ts</code>{' '}
          and commit <code className="font-mono text-[11.5px]">data/lab-packages.json</code> (expect 62 packages).
        </div>
      )}

      <LabPackagesEditor packages={packages} count={packages.length} />

      <p className="mt-5 max-w-2xl text-[12px] leading-relaxed text-slate-400">
        This is factual context, not a scoring rule. It changes no weight, no severity and no applicability test —
        it only tells the audit what a package already includes.
      </p>
    </div>
  );
}
