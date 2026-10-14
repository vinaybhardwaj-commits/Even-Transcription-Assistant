/**
 * /admin/provenance — the provenance tier ledger (PRD CDMSS-PROVENANCE-TIER-LEDGER). Admin-gated,
 * read-only instrument for governance: where every served finding's authority actually comes from,
 * partitioned by engine_version AND quieting_gen (L5 — never a blended total without saying so),
 * with the attribution CEILING stated in words, the daily snapshot trend (L6), and a per-tier
 * drill-down for auditing the classifier itself. Score-invariant; not doctor-facing.
 */
export const dynamic = 'force-dynamic';

import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';
import { loadTierLedger, snapshotToday, loadSnapshots, tierExamples } from '@/lib/provenance-tier';
import { PROVENANCE_TIERS, PROVENANCE_TIER_LABELS, type ProvenanceTier } from '@/lib/provenance-tier-core';

const TIER_TONE: Record<ProvenanceTier, string> = {
  deterministic: 'bg-teal-50 text-teal-800',
  clinician_signed: 'bg-emerald-50 text-emerald-800',
  category_authority: 'bg-sky-50 text-sky-800',
  internal_consensus: 'bg-amber-50 text-amber-800',
  uncited_deterministic: 'bg-slate-100 text-slate-700',
  deterministic_completeness: 'bg-cyan-50 text-cyan-800',
  deterministic_logical: 'bg-cyan-50 text-cyan-800',
  unattributed_sourceable: 'bg-violet-50 text-violet-800',
  inherent_judgment: 'bg-slate-50 text-slate-500',
};

function Locked({ configured }: { configured: boolean }) {
  return (
    <div className="mx-auto max-w-lg px-5 py-16 text-center text-sm text-slate-500">
      {configured ? 'Admin surface locked. Unlock from the admin console first.' : 'ADMIN_TOKEN is not configured; this surface stays locked.'}
    </div>
  );
}

export default async function ProvenanceLedgerPage() {
  if (!(await isAdminUnlocked())) return <Locked configured={adminTokenConfigured()} />;

  const parts = await loadTierLedger();
  await snapshotToday(parts);                        // L6: first load of the day appends the rollup (idempotent)
  const snaps = await loadSnapshots(30);
  const examples = await tierExamples(OPD_ENGINE_VERSION, 5);

  // The ceiling line is computed on the CURRENT engine version (all gens of it, labelled as such).
  const current = parts.filter((p) => p.engine_version === OPD_ENGINE_VERSION);
  const curTotal = current.reduce((s, p) => s + p.total, 0);
  const curInherent = current.reduce((s, p) => s + p.tiers.inherent_judgment, 0);
  const inherentPct = curTotal ? Math.round((curInherent / curTotal) * 1000) / 10 : 0;
  const ceilingPct = Math.round((100 - inherentPct) * 10) / 10;

  const pct = (n: number, total: number) => (total ? `${Math.round((n / total) * 1000) / 10}%` : '—');
  const snapDays = [...new Set(snaps.map((s) => s.day))];

  return (
    <div className="mx-auto max-w-5xl px-5 py-7" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <h1 className="text-[20px] font-semibold text-slate-900">Provenance tier ledger</h1>
      <p className="mt-1 text-[12.5px] text-slate-500">
        Where each served finding&rsquo;s authority comes from — a read-time lens (never stamped), deterministic mapping only (no LLM),
        partitioned by engine version and quieting generation. Score-invariant; governance instrument, not doctor-facing.
      </p>

      {/* THE CEILING LINE (PRD §4) — stated in words */}
      <div className="mt-4 rounded-xl border border-slate-300 bg-slate-50 px-4 py-3 text-[13.5px] text-slate-800">
        {curTotal > 0 ? (
          <>
            <b>{inherentPct}%</b> of findings are inherent clinical judgement and cannot be cited by any catalog.
            The attainable attribution ceiling is <b>({100} − {inherentPct})% = {ceilingPct}%</b>.
            <span className="ml-1 text-[11.5px] text-slate-500">(engine {OPD_ENGINE_VERSION}, all quieting generations of it, labelled per-gen below)</span>
          </>
        ) : (
          <>Ledger unavailable or empty — counts could not be computed (fail-safe: nothing is shown rather than something wrong).</>
        )}
      </div>

      {/* Current distribution, per (engine_version, quieting_gen) partition — L5 */}
      <h2 className="mt-6 text-[15px] font-semibold text-slate-800">Current distribution</h2>
      {parts.length === 0 && <p className="mt-2 text-[12.5px] text-slate-400">No data.</p>}
      {parts.map((p) => (
        <div key={`${p.engine_version}|${p.quieting_gen}`} className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 text-[12px] text-slate-500">
            <span><b className="text-slate-700">{p.engine_version}</b> · quieting gen {p.quieting_gen}</span>
            <span>{p.total.toLocaleString('en-IN')} non-informational findings</span>
          </div>
          <table className="w-full text-[12.5px]">
            <tbody>
              {PROVENANCE_TIERS.map((t) => (
                <tr key={t} className="border-t border-slate-50">
                  <td className="px-3 py-1.5"><span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${TIER_TONE[t]}`}>{t}</span></td>
                  <td className="px-2 text-slate-500">{PROVENANCE_TIER_LABELS[t]}</td>
                  <td className="px-2 text-right font-medium text-slate-700">{p.tiers[t].toLocaleString('en-IN')}</td>
                  <td className="w-16 px-3 text-right text-slate-500">{pct(p.tiers[t], p.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {/* Trend (L6) */}
      <h2 className="mt-7 text-[15px] font-semibold text-slate-800">Trend (daily snapshots, last 30 days)</h2>
      {snapDays.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-slate-400">No snapshots yet — the first row lands with today&rsquo;s first page load after the migration.</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-[12px]">
            <thead><tr className="border-b border-slate-100 text-left text-[10.5px] uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2">Day</th><th className="px-2">Engine · gen</th>
              {PROVENANCE_TIERS.map((t) => <th key={t} className="px-2 text-right">{t.replace('_', ' ')}</th>)}
            </tr></thead>
            <tbody>
              {snapDays.slice(0, 14).map((day) => {
                const dayRows = snaps.filter((s) => s.day === day);
                const partsOfDay = [...new Set(dayRows.map((s) => `${s.engine_version}|${s.quieting_gen}`))];
                return partsOfDay.map((pk) => {
                  const [ev, gen] = pk.split('|');
                  const cell = (t: string) => dayRows.find((s) => s.engine_version === ev && s.quieting_gen === Number(gen) && s.tier === t)?.count ?? 0;
                  return (
                    <tr key={`${day}|${pk}`} className="border-t border-slate-50">
                      <td className="px-3 py-1.5 text-slate-600">{day}</td>
                      <td className="px-2 text-slate-500">{ev.replace('opd-note-audit/', '')} · g{gen}</td>
                      {PROVENANCE_TIERS.map((t) => <td key={t} className="px-2 text-right text-slate-600">{cell(t).toLocaleString('en-IN')}</td>)}
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Drill-down — for auditing the classifier itself (PRD §4) */}
      <h2 className="mt-7 text-[15px] font-semibold text-slate-800">Classifier drill-down <span className="font-normal text-slate-400">(examples per tier, engine {OPD_ENGINE_VERSION})</span></h2>
      <div className="mt-2 space-y-2.5">
        {PROVENANCE_TIERS.map((t) => (
          <details key={t} className="rounded-xl border border-slate-200 bg-white px-3.5 py-2.5">
            <summary className="cursor-pointer text-[12.5px]">
              <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${TIER_TONE[t]}`}>{t}</span>
              <span className="ml-2 text-slate-500">{PROVENANCE_TIER_LABELS[t]}</span>
            </summary>
            <ul className="mt-2 space-y-1 text-[12px] text-slate-600">
              {examples[t].length === 0 && <li className="text-slate-400">No examples in the sampled window.</li>}
              {examples[t].map((e, i) => (
                <li key={i}>· {e.subject} <span className="text-[10.5px] text-slate-400">[{e.signal_type || 'no signal_type'}{e.rule_ref ? ` · rule ${e.rule_ref.slice(0, 12)}` : ''}]</span></li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </div>
  );
}
