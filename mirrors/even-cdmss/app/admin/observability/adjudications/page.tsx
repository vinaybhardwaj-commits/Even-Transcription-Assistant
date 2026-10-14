// app/admin/observability/adjudications/page.tsx — the "Adjudication Ledger" surface (#3).
//
// The FINDING-PRECISION family ONLY — every human call on a finding the engine PRODUCED, federated at
// read time into one browsable stream + rollups. It is an AUDIT TRAIL of what the AI proposed and
// what a human decided — NOT a per-clinician/per-reviewer accuracy scorecard. "Who" is shown per row
// where the store captures it; it is NEVER aggregated into a reviewer leaderboard (enforced by
// lib/__tests__/adjudication-ledger.test.ts). The RECONSTRUCTION-FIDELITY family lives on its own
// page (../reconstruction-fidelity) — no recon rows appear here.
//
// Precision is grouped by SURFACE (headline); engine version is the drill-in WITHIN a surface, where
// version drift shows. Read-only, admin-gated. De-identified: finding themes + audit link-back keys.
import Link from 'next/link';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import {
  federateAdjudications, filterRows, selectFinding, precisionBySurface, verdictDistribution,
  volumeOverTime, FEDERATED_STORES, EXCLUDED_MACHINE_STORES, ADJUDICATION_LEDGER_VERSION,
  type LedgerRow,
} from '@/lib/adjudication-ledger';
import { Verdict, pct, Section, Empty, Sel, BrowseTable } from '../ledger-ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Adjudication Ledger · Observability' };

type SP = { surface?: string; engine?: string; verdict?: string; from?: string; to?: string };

export default async function AdjudicationLedgerPage({ searchParams }: { searchParams: Promise<SP> }) {
  if (!(await isAdminUnlocked())) {
    return <div className="mx-auto max-w-md py-16 text-center text-sm text-slate-500">Access-controlled. <Link href="/admin/observability" className="text-brand hover:underline">Unlock Observability</Link> first.</div>;
  }
  const sp = await searchParams;
  // FINDING FAMILY ONLY — fidelity rows are dropped here (they render on ../reconstruction-fidelity).
  const all = selectFinding(await federateAdjudications().catch(() => [] as LedgerRow[]));

  const rows = filterRows(all, {
    surface: sp.surface || undefined, engineVersion: sp.engine || undefined,
    verdict: sp.verdict || undefined,
    from: sp.from || undefined, to: sp.to ? `${sp.to}T23:59:59.999Z` : undefined,
  });

  const surfacePrecision = precisionBySurface(rows);   // surface headline, engine drill-in
  const distribution = verdictDistribution(rows);
  const volume = volumeOverTime(rows);

  const surfaces = [...new Set(all.map((r) => r.surface))].sort();
  const engines = [...new Set(all.map((r) => r.engine_version))].sort();
  const verdicts = [...new Set(all.map((r) => r.canonical_verdict))].sort();

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-[26px] font-semibold leading-tight text-slate-900 sm:text-[30px]">Adjudication Ledger</h1>
          <p className="mt-1.5 max-w-3xl text-sm text-slate-500">
            Every human adjudication of a finding the engine produced, federated at read time — <b>what the AI proposed and what a human decided.</b> The stream IS the consensus gold, accumulating in real time. Advisory only: this is an audit trail, <b>never a per-reviewer scorecard</b>.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <Link href="/admin/observability/reconstruction-fidelity" className="whitespace-nowrap text-brand hover:underline">Reconstruction Fidelity →</Link>
          <Link href="/admin/observability" className="whitespace-nowrap text-slate-400 hover:text-brand">← Observability</Link>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
        <span className="font-semibold text-slate-600">Federated (human ground-truth):</span> {FEDERATED_STORES.filter((s) => s.family === 'finding').map((s) => s.store).join(' · ')} <span className="text-slate-400">(finding family; the fidelity store renders on the Reconstruction Fidelity page)</span>.
        <span className="ml-2 font-semibold text-slate-600">Excluded (machine/judge — would corrupt precision):</span> {EXCLUDED_MACHINE_STORES.slice(0, 4).join(' · ')} … <span className="text-slate-400">({ADJUDICATION_LEDGER_VERSION})</span>
      </div>

      <form method="GET" className="mt-4 flex flex-wrap items-end gap-2">
        <Sel name="surface" label="Surface" value={sp.surface} options={surfaces} />
        <Sel name="engine" label="Engine version" value={sp.engine} options={engines} />
        <Sel name="verdict" label="Verdict" value={sp.verdict} options={verdicts} />
        <label className="flex flex-col text-[10.5px] text-slate-500">From<input type="date" name="from" defaultValue={sp.from} className="mt-0.5 h-7 rounded-md border border-slate-200 px-2 text-[12px]" /></label>
        <label className="flex flex-col text-[10.5px] text-slate-500">To<input type="date" name="to" defaultValue={sp.to} className="mt-0.5 h-7 rounded-md border border-slate-200 px-2 text-[12px]" /></label>
        <button className="h-7 rounded-md border border-brand/40 px-3 text-[12px] font-medium text-brand hover:bg-brand/5">Apply</button>
        <Link href="/admin/observability/adjudications" className="h-7 px-2 text-[12px] leading-7 text-slate-500 hover:text-brand">Reset</Link>
        <span className="ml-auto text-[11px] text-slate-400">{rows.length} finding adjudication{rows.length === 1 ? '' : 's'}</span>
      </form>

      {/* headline: precision per SURFACE, engine version on drill-in */}
      <Section title="Precision per surface" hint="TP + ValidExtra over (TP + ValidExtra + False). Nitpick / Contested excluded from the denominator. Expand a surface for its per-engine-version breakdown — where version drift shows.">
        {surfacePrecision.length === 0 ? <Empty /> : (
          <div className="space-y-1.5">
            {surfacePrecision.map((sfc) => (
              <details key={sfc.surface} className="rounded-lg border border-slate-200 open:bg-slate-50/40">
                <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[12px]">
                  <span className="font-semibold text-slate-800">{sfc.surface}</span>
                  <span className="text-slate-500">TP {sfc.tp}{sfc.validExtra ? ` +${sfc.validExtra} valid-extra` : ''} · False {sfc.falsePos}</span>
                  <span className="text-slate-400">labeled {sfc.labeled} · <span className="text-slate-400">{sfc.nitpick} nitpick · {sfc.contested} contested excluded</span></span>
                  <span className="ml-auto text-[15px] font-semibold text-slate-900">{pct(sfc.precision)}</span>
                  <span className="text-[10px] text-slate-400">{sfc.byVersion.length} version{sfc.byVersion.length === 1 ? '' : 's'} ▾</span>
                </summary>
                <div className="overflow-x-auto border-t border-slate-100 px-3 py-2">
                  <table className="w-full text-[12px]">
                    <thead><tr className="text-left text-[10.5px] uppercase tracking-wide text-slate-400"><th className="py-1 pr-3">Engine version</th><th className="pr-3">TP</th><th className="pr-3">ValidExtra</th><th className="pr-3">False</th><th className="pr-3">Nitpick</th><th className="pr-3">Contested</th><th className="pr-3">Labeled</th><th className="pr-3">Precision</th></tr></thead>
                    <tbody>
                      {sfc.byVersion.map((p) => (
                        <tr key={p.engine_version} className="border-t border-slate-100">
                          <td className="py-1.5 pr-3 font-mono text-[11px] text-slate-700">{p.engine_version}</td>
                          <td className="pr-3">{p.tp}</td><td className="pr-3">{p.validExtra}</td><td className="pr-3">{p.falsePos}</td>
                          <td className="pr-3 text-slate-400">{p.nitpick}</td><td className="pr-3 text-slate-400">{p.contested}</td>
                          <td className="pr-3">{p.labeled}</td>
                          <td className="pr-3 font-semibold text-slate-900">{pct(p.precision)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ))}
          </div>
        )}
      </Section>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title="Verdict distribution" hint="Per surface + engine version.">
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
        <Section title="Volume over time" hint="Adjudications per day, per surface.">
          {volume.length === 0 ? <Empty /> : (
            <div className="max-h-56 overflow-y-auto">
              <table className="w-full text-[12px]">
                <tbody>
                  {volume.map((v) => (
                    <tr key={`${v.day} ${v.surface}`} className="border-t border-slate-100 first:border-0">
                      <td className="py-1 pr-3 font-mono text-[11px] text-slate-500">{v.day}</td>
                      <td className="pr-3 text-slate-600">{v.surface}</td>
                      <td className="w-full"><span className="inline-block h-2 rounded bg-brand/40 align-middle" style={{ width: `${Math.min(100, v.n * 8)}%` }} /> <span className="text-[11px] text-slate-500">{v.n}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      <Section title="Adjudications" hint="Newest first. Each row links back to its source surface.">
        <BrowseTable rows={rows} />
      </Section>
    </div>
  );
}
