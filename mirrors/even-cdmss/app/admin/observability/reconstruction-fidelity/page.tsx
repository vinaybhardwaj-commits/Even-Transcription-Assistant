// app/admin/observability/reconstruction-fidelity/page.tsx — the "Reconstruction Fidelity" surface (#3).
//
// The FIDELITY family ONLY — the episode_recon_ratings human ratings of whether the assembled
// EpisodeState faithfully reconstructs the documented course (faithful / missed-material / mis-phased
// / over-included). Split out from the Adjudication Ledger (which is finding-precision only) because
// fidelity is a BUILDER measurement, not finding TP/False — never blended into precision.
//
// Same read-layer (lib/adjudication-ledger), same de-identified posture, link-back, "who where
// present" (single-validator V). Advisory: this is not a per-reviewer scorecard. Read-only, admin-gated.
import Link from 'next/link';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import {
  federateAdjudications, filterRows, selectFidelity, fidelityRollup, verdictDistribution,
  ADJUDICATION_LEDGER_VERSION, type LedgerRow,
} from '@/lib/adjudication-ledger';
import { Verdict, pct, Section, Empty, Sel, BrowseTable } from '../ledger-ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Reconstruction Fidelity · Observability' };

type SP = { engine?: string; verdict?: string; from?: string; to?: string };

export default async function ReconstructionFidelityPage({ searchParams }: { searchParams: Promise<SP> }) {
  if (!(await isAdminUnlocked())) {
    return <div className="mx-auto max-w-md py-16 text-center text-sm text-slate-500">Access-controlled. <Link href="/admin/observability" className="text-brand hover:underline">Unlock Observability</Link> first.</div>;
  }
  const sp = await searchParams;
  // FIDELITY FAMILY ONLY — finding-precision rows never appear here.
  const all = selectFidelity(await federateAdjudications().catch(() => [] as LedgerRow[]));

  const rows = filterRows(all, {
    engineVersion: sp.engine || undefined, verdict: sp.verdict || undefined,
    from: sp.from || undefined, to: sp.to ? `${sp.to}T23:59:59.999Z` : undefined,
  });

  const fidelity = fidelityRollup(rows);
  const distribution = verdictDistribution(rows);

  const engines = [...new Set(all.map((r) => r.engine_version))].sort();
  const verdicts = [...new Set(all.map((r) => r.canonical_verdict))].sort();

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-[26px] font-semibold leading-tight text-slate-900 sm:text-[30px]">Reconstruction Fidelity</h1>
          <p className="mt-1.5 max-w-3xl text-sm text-slate-500">
            Human ratings of whether the assembled EpisodeState faithfully reconstructs the documented course — <b>faithful / missed-material / mis-phased / over-included</b>. A <b>builder-fidelity</b> measurement, kept separate from finding precision: a faithful reconstruction is never a “true positive”.
          </p>
          {/* WM0 W0.2 — disambiguation only; this surface's scope is unchanged. */}
          <p className="mt-1 text-[11.5px] text-slate-400">This rates <b>EpisodeState</b>, not the MemberState walk.</p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <Link href="/admin/observability/adjudications" className="whitespace-nowrap text-brand hover:underline">Adjudication Ledger →</Link>
          <Link href="/admin/observability" className="whitespace-nowrap text-slate-400 hover:text-brand">← Observability</Link>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
        <span className="font-semibold text-slate-600">Source (human ground-truth):</span> episode_recon_ratings — the EpisodeState reconstruction ratings. <span className="text-slate-400">Distinct from finding precision; never folded into it ({ADJUDICATION_LEDGER_VERSION}).</span>
      </div>

      <form method="GET" className="mt-4 flex flex-wrap items-end gap-2">
        <Sel name="engine" label="Builder version" value={sp.engine} options={engines} />
        <Sel name="verdict" label="Rating" value={sp.verdict} options={verdicts} />
        <label className="flex flex-col text-[10.5px] text-slate-500">From<input type="date" name="from" defaultValue={sp.from} className="mt-0.5 h-7 rounded-md border border-slate-200 px-2 text-[12px]" /></label>
        <label className="flex flex-col text-[10.5px] text-slate-500">To<input type="date" name="to" defaultValue={sp.to} className="mt-0.5 h-7 rounded-md border border-slate-200 px-2 text-[12px]" /></label>
        <button className="h-7 rounded-md border border-brand/40 px-3 text-[12px] font-medium text-brand hover:bg-brand/5">Apply</button>
        <Link href="/admin/observability/reconstruction-fidelity" className="h-7 px-2 text-[12px] leading-7 text-slate-500 hover:text-brand">Reset</Link>
        <span className="ml-auto text-[11px] text-slate-400">{rows.length} fidelity rating{rows.length === 1 ? '' : 's'}</span>
      </form>

      <Section title="Fidelity per builder version" hint="Did the EpisodeState faithfully reconstruct the documented course? A distinct measurement — faithful is never a TP, and this never contributes to precision.">
        {fidelity.length === 0 ? <Empty /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead><tr className="text-left text-[10.5px] uppercase tracking-wide text-slate-400"><th className="py-1 pr-3">Builder version</th><th className="pr-3">Faithful</th><th className="pr-3">Missed material</th><th className="pr-3">Mis-phased</th><th className="pr-3">Over-included</th><th className="pr-3">Total</th><th className="pr-3">Faithful rate</th></tr></thead>
              <tbody>
                {fidelity.map((f) => (
                  <tr key={f.engine_version} className="border-t border-slate-100">
                    <td className="py-1.5 pr-3 font-mono text-[11px] text-slate-700">{f.engine_version}</td>
                    <td className="pr-3">{f.faithful}</td><td className="pr-3 text-amber-700">{f.missedMaterial}</td>
                    <td className="pr-3 text-orange-700">{f.misPhased}</td><td className="pr-3 text-rose-700">{f.overIncluded}</td>
                    <td className="pr-3">{f.total}</td><td className="pr-3 font-semibold text-slate-900">{pct(f.faithfulRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Rating distribution" hint="Per builder version.">
        {distribution.length === 0 ? <Empty /> : (
          <div className="space-y-2">
            {distribution.map((d) => (
              <div key={`${d.surface} ${d.engine_version}`}>
                <div className="text-[11px] text-slate-500">{d.surface} · <span className="font-mono">{d.engine_version}</span> <span className="text-slate-400">({d.total})</span></div>
                <div className="mt-0.5 flex flex-wrap gap-1">{Object.entries(d.counts).sort().map(([v, n]) => <span key={v} className="flex items-center gap-1"><Verdict v={v} /><span className="text-[11px] text-slate-500">{n}</span></span>)}</div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Ratings" hint="Newest first. Each row links back to the reconstruction-rating queue.">
        <BrowseTable rows={rows} />
      </Section>
    </div>
  );
}
