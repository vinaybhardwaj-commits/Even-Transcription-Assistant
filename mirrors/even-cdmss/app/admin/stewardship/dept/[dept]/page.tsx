/**
 * Department (specialty) stewardship detail — RIGHT-CARE-INDICATOR-PRD §7c / decision 20. Every number
 * drills to cases; fairness (vs-expected) travels with the raw rate. All aggregates on the shared
 * distinct-note + current-engine-family + banded + excluded basis, FIXED 90-day window (decision 19).
 * Admin-gated (identical to the parent page). Weekly trend = inline SVG. Reuses funnel-card + the O/E
 * fns (no reimplementation, decision 18). Fail-safe: any section that errors degrades to empty/hidden.
 */
import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { doctorLabel } from '@/lib/opd-audit-ui';
import {
  fetchDeptKpis, fetchDeptWeeklyTrend, fetchDeptCategorySplit, fetchDeptTopFindings,
  fetchLvcCells, readRightCareExclusions,
} from '@/lib/opd-audit-doctor';
import { computeDoctorOE, FUNNEL_MIN_N, type DoctorOE } from '@/lib/opd-funnel-core';
import { LVC_CATEGORY_LABELS } from '@/lib/opd-lvc-classify-core';
import { FunnelCard } from '../../../opd-audit/doctor/[uid]/funnel-card';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Stewardship · Department · Admin' };

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const pct = (x: number): string => `${Math.round(x * 100)}%`;
// 0.81.8 Decision 10 — shared category labels (local 'other' override kept) so new overuse sub-tags render.
const CAT_LABEL: Record<string, string> = { ...LVC_CATEGORY_LABELS, other: 'Other' };

function Locked() {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">Stewardship · department</h1>
      <p className="mt-1.5 text-sm text-slate-500">Locked. <Link href="/admin/stewardship" className="text-brand hover:underline">Unlock stewardship</Link> first.</p>
    </div>
  );
}
function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 font-serif text-[24px] font-semibold text-slate-900">{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-slate-500">{sub}</div>}
    </div>
  );
}

/** Dual inline-SVG trend: NQI (0–100) + LVC% (0–100) over the dept's weeks. No chart libs. */
function WeeklyTrend({ weeks }: { weeks: { wk: string; nqi: number; lvc: number }[] }) {
  if (weeks.length < 2) return <div className="text-[11px] text-slate-400">Building weekly history…</div>;
  const W = 480, H = 90, m = 6;
  const x = (i: number) => m + (i / (weeks.length - 1)) * (W - 2 * m);
  const y = (v: number) => H - m - (v / 100) * (H - 2 * m);
  const line = (key: 'nqi' | 'lvc') => weeks.map((w, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(w[key]).toFixed(1)}`).join(' ');
  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Weekly NQI and low-value trend">
        <path d={line('nqi')} fill="none" stroke="#0f766e" strokeWidth={1.5} />
        <path d={line('lvc')} fill="none" stroke="#d97706" strokeWidth={1.5} strokeDasharray="3 2" />
      </svg>
      <div className="mt-1 flex gap-3 text-[10.5px] text-slate-500">
        <span><span className="inline-block h-2 w-2 rounded-full bg-teal-700" /> mean NQI</span>
        <span><span className="inline-block h-2 w-2 rounded-full bg-amber-600" /> low-value %</span>
        <span className="text-slate-400">{weeks.length} weeks</span>
      </div>
    </div>
  );
}

export default async function DeptDetail({ params }: { params: Promise<{ dept: string }> }) {
  if (!(await isAdminUnlocked())) { adminTokenConfigured(); return <Locked />; }
  const { dept: deptRaw } = await params;
  const dept = decodeURIComponent(deptRaw);   // 'Unspecified' round-trips

  const [kpis, weeks, cats, topFindings, lvcCells, rcExclusions, dirRows] = await Promise.all([
    fetchDeptKpis(dept), fetchDeptWeeklyTrend(dept), fetchDeptCategorySplit(dept), fetchDeptTopFindings(dept),
    fetchLvcCells(), readRightCareExclusions(),
    run(`SELECT doctor_uid, COALESCE(NULLIF(doctor_name,''),'') AS name, COALESCE(NULLIF(speciality,''),'Unspecified') AS spec FROM doctor_directory`, []).catch(() => []),
  ]);

  const specMap: Record<string, string> = {}, nameMap: Record<string, string> = {};
  for (const r of dirRows) { const u = String(r.doctor_uid); specMap[u] = String(r.spec || 'Unspecified'); if (r.name) nameMap[u] = String(r.name); }
  const exclSet = new Set(rcExclusions);
  const oeAll = computeDoctorOE(lvcCells, exclSet);
  const deptDoctors: DoctorOE[] = oeAll
    .filter((d) => (specMap[d.doctor_uid] || 'Unspecified') === dept)
    .sort((a, b) => (b.oe ?? -1) - (a.oe ?? -1));

  const totalCatNotes = cats.reduce((a, c) => a + c.notes, 0);

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-brand">STEWARDSHIP · DEPARTMENT</div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-serif text-[26px] font-semibold text-slate-900">{dept}</h1>
        <Link href="/admin/stewardship" className="text-[12.5px] text-brand hover:underline">← All departments</Link>
      </div>
      <p className="mt-1 max-w-3xl text-sm text-slate-500">Last 90 days, latest audit per note. Advisory — a process &amp; appropriateness lens, not a clinician score. Banded coverage {kpis.banded.toLocaleString()}/{kpis.n.toLocaleString()}.</p>

      {kpis.n === 0 ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-6 text-center text-[13px] text-slate-500">No audited notes for {dept} in the window.</div>
      ) : (
        <>
          {/* KPI row */}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Notes audited" value={kpis.n.toLocaleString()} sub={`${deptDoctors.length} clinician(s)`} />
            <Stat label="Avg note-quality" value={String(kpis.avg_nqi)} />
            <Stat label="Notes w/ low-value" value={`${kpis.pct_low}%`} sub={`${kpis.sum_low.toLocaleString()} findings`} />
            <Stat label="Banded coverage" value={`${kpis.banded.toLocaleString()}/${kpis.n.toLocaleString()}`} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {/* weekly trend */}
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <h3 className="text-[13px] font-semibold text-slate-800">Weekly note-quality &amp; low-value trend</h3>
              <div className="mt-2"><WeeklyTrend weeks={weeks} /></div>
            </div>
            {/* category split */}
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <h3 className="text-[13px] font-semibold text-slate-800">Low-value by category</h3>
              <div className="mt-2 space-y-1.5">
                {cats.length === 0 ? <div className="text-[11px] text-slate-400">No low-value findings in the window.</div> : cats.map((c) => (
                  <div key={c.category} className="flex items-center gap-2 text-[12px]">
                    <span className="w-40 shrink-0 text-slate-600">{CAT_LABEL[c.category] || c.category}</span>
                    <div className="h-2 flex-1 rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-amber-400" style={{ width: `${totalCatNotes ? Math.max(3, (c.notes / totalCatNotes) * 100) : 0}%` }} />
                    </div>
                    <span className="w-8 text-right tabular-nums text-slate-500">{c.notes}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* specialty funnel (reuse) */}
          <div className="mt-4">
            <FunnelCard doctorUid="" specialty={dept} peers={deptDoctors} />
          </div>

          {/* doctors ranked by O/E */}
          <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-4 py-2.5 font-serif text-[14px] font-semibold text-slate-900">Clinicians — ranked by O/E</div>
            <table className="w-full text-[12px]">
              <thead className="text-[10.5px] uppercase tracking-wide text-slate-400">
                <tr className="text-right">
                  <th className="px-3 py-2 text-left font-medium">Clinician</th>
                  <th className="px-3 py-2 font-medium">n</th>
                  <th className="px-3 py-2 font-medium">raw</th>
                  <th className="px-3 py-2 font-medium">expected</th>
                  <th className="px-3 py-2 font-medium">vs exp</th>
                  <th className="px-3 py-2 font-medium">O/E</th>
                  <th className="px-3 py-2 font-medium">cases</th>
                </tr>
              </thead>
              <tbody>
                {deptDoctors.map((d) => {
                  const grey = d.n < FUNNEL_MIN_N;
                  const pts = Math.round((d.raw_rate - d.expected_rate) * 100);
                  const tone = grey ? 'text-slate-300' : pts >= 3 ? 'text-amber-700 font-medium' : pts <= -3 ? 'text-emerald-700' : 'text-slate-500';
                  return (
                    <tr key={d.doctor_uid} className={`border-t border-slate-50 text-right hover:bg-slate-50 ${grey ? 'opacity-60' : ''}`}>
                      <td className="px-3 py-2 text-left"><Link href={`/admin/opd-audit/doctor/${d.doctor_uid}`} className="font-medium text-slate-700 hover:text-brand hover:underline">{nameMap[d.doctor_uid] || doctorLabel(d.doctor_uid)}</Link></td>
                      <td className="px-3 py-2 tabular-nums text-slate-500">{d.n}</td>
                      <td className="px-3 py-2 tabular-nums text-slate-600">{pct(d.raw_rate)}</td>
                      <td className="px-3 py-2 tabular-nums text-slate-400">{pct(d.expected_rate)}</td>
                      <td className={`px-3 py-2 tabular-nums ${tone}`} title={grey ? `building history (n<${FUNNEL_MIN_N})` : ''}>{grey ? '—' : (pts > 0 ? `+${pts}` : `${pts}`)}</td>
                      <td className="px-3 py-2 tabular-nums text-slate-500">{grey || d.oe == null ? '—' : d.oe.toFixed(2)}</td>
                      <td className="px-3 py-2"><Link href={`/admin/opd-audit?doctor=${d.doctor_uid}#notes`} className="text-brand hover:underline">view →</Link></td>
                    </tr>
                  );
                })}
                {deptDoctors.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No banded clinicians in this department yet.</td></tr>}
              </tbody>
            </table>
          </div>

          {/* top recurring findings (top 10, count ≥3) — hidden section on error/empty */}
          {topFindings.length > 0 && (
            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
              <h3 className="text-[13px] font-semibold text-slate-800">Top recurring findings</h3>
              <ul className="mt-2 space-y-1">
                {topFindings.map((f, i) => (
                  <li key={i}>
                    {/* drill-through (§2.1): land in the OPD Audit notes list filtered to these exact findings */}
                    <Link href={`/admin/opd-audit?finding=${encodeURIComponent(f.subject)}&signal=${encodeURIComponent(f.signal_type)}&dept=${encodeURIComponent(dept)}#notes`}
                      className="-mx-2 flex items-baseline justify-between gap-3 rounded-md px-2 py-0.5 text-[12px] hover:bg-slate-50">
                      <span className="text-slate-700">{f.subject} {f.signal_type && <span className="text-slate-400">· {f.signal_type}</span>}</span>
                      <span className="shrink-0 tabular-nums text-slate-500">×{f.n}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-4 text-[11px] text-slate-400">
            “vs exp” = observed minus case-mix-expected LVC rate (points); “O/E” = observed / expected. Clinicians with n&lt;{FUNNEL_MIN_N} banded notes are greyed. Case-mix adjustment uses the complexity-band strata (§4). Advisory — not an outcomes measure or clinician scorecard.
            {rcExclusions.length > 0 && ` ${rcExclusions.length} house/non-clinician account(s) excluded.`}
          </p>
        </>
      )}
    </div>
  );
}
