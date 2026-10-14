import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { fetchDoctorNames, fetchDoctorSpecialities } from '@/lib/metabase';
import { bandFor } from '@/lib/opd-note-score-core';
import { bandColor, scoreColor, parseJson, doctorLabel, fmtIstTime } from '@/lib/opd-audit-ui';
import { catsForRow } from '@/lib/opd-audit-cats';
import {
  fetchDoctorStats, fetchDoctorBandDist, fetchDoctorWeeklyTrend, fetchDoctorAuditRows,
  fetchLvcCells, readRightCareExclusions,
} from '@/lib/opd-audit-doctor';
import { computeDoctorOE } from '@/lib/opd-funnel-core';
import NotesExplorer, { type AuditRow } from '../../audit-table';
import { FunnelCard } from './funnel-card';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'OPD Audit · Doctor' };

const APP = process.env.APP_SOURCE || 'standalone';
const runSql = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const n = (v: unknown): number => Number(v ?? 0);
const BANDS = ['A', 'B', 'C', 'D', 'E'];
const BULK_CAP = 50;
const DOMAIN_MEANS: { k: 'd_doc' | 'd_nq' | 'd_appr' | 'd_presc' | 'd_pc'; label: string }[] = [
  { k: 'd_doc', label: 'Documentation' }, { k: 'd_nq', label: 'Note quality' }, { k: 'd_appr', label: 'Appropriateness' },
  { k: 'd_presc', label: 'Prescribing & safety' }, { k: 'd_pc', label: 'Continuity' },
];
const TYPE_SHORT: Record<string, string> = {
  GENERAL_PRACTITIONER: 'GP', HOSPITAL_GP: 'Hosp GP', HOSPITAL_GYNAECOLOGY_ASSESSMENT: 'Gynae',
  HOSPITAL_GYNAECOLOGY_OBSTETRICS: 'Obs-Gyn', HOSPITAL_PAEDIATRIC: 'Paeds', HOSPITAL_GP_INVESTIGATION_REFERRAL: 'GP-Ref',
};
const prettyType = (t: string | null) => (!t ? 'OPD' : TYPE_SHORT[t] || t.toLowerCase().replace(/_/g, ' '));
function issueFrom(findings: unknown, completenessPct: number): string {
  const fs = parseJson<{ subject?: string; verdict?: string }[]>(findings, []);
  const lv = fs.find((f) => f.verdict === 'low-value') || fs[0];
  if (lv?.subject) return lv.subject;
  if (completenessPct < 60) return 'Documentation gaps';
  return 'Review';
}

function Locked() {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">OPD Audit · doctor</h1>
      <p className="mt-1.5 text-sm text-slate-500">Locked. <Link href="/admin/opd-audit" className="text-brand hover:underline">Unlock the OPD Audit surface</Link> first.</p>
    </div>
  );
}

export default async function DoctorDetail({ params, searchParams }: { params: Promise<{ uid: string }>; searchParams: Promise<{ from?: string; to?: string }> }) {
  const { uid } = await params;
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) { adminTokenConfigured(); return <Locked />; }

  const from = (sp.from && /^\d{4}-\d{2}-\d{2}$/.test(sp.from)) ? sp.from : null;
  const to = (sp.to && /^\d{4}-\d{2}-\d{2}$/.test(sp.to)) ? sp.to : null;

  const [stats, bandDist, weekly, auditRows, names, specs] = await Promise.all([
    fetchDoctorStats(uid, from, to),
    fetchDoctorBandDist(uid, from, to),
    fetchDoctorWeeklyTrend(uid, from, to),
    fetchDoctorAuditRows(uid, from, to, 600),
    fetchDoctorNames([uid]).catch(() => ({} as Record<string, string>)),
    fetchDoctorSpecialities([uid]).catch(() => ({} as Record<string, { name: string; speciality: string }>)),
  ]);

  const doctor = names[uid] || specs[uid]?.name || doctorLabel(uid);
  const specialty = specs[uid]?.speciality || '';
  const rangeQs = [from ? `from=${from}` : '', to ? `to=${to}` : ''].filter(Boolean).join('&');

  const rows: AuditRow[] = auditRows.map((r) => ({
    id: String(r.id), time: `${fmtIstTime(r.note_date)}`, doctor,
    consult: prettyType(r.prescription_type || r.consult_type), uid: String(r.uid || ''),
    // S1 — displayed band (hysteresis anchor), raw-band fallback for pre-0029 rows.
    band: r.displayed_band ?? r.band, index: n(r.note_quality_index), lowVal: n(r.n_low_value),
    issue: issueFrom(r.findings, n(r.completeness_pct)),
    cats: catsForRow(parseJson<string[]>(r.missing_fields, []), parseJson<{ subject?: string; verdict?: string; rationale?: string }[]>(r.findings, [])),
    doctorUid: uid,
  }));

  // Feature C (UX polish PRD §1C): finding-scope triage ticks for the audits on screen — one
  // parameterized read-only round-trip (NOT the MCP guard path); .catch → [] degrades to no ticks.
  const auditIds = rows.map((r) => r.id);
  const triagedIds = auditIds.length
    ? (await runSql(`SELECT DISTINCT audit_id FROM opd_audit_feedback WHERE scope = 'finding' AND app_source = $1 AND audit_id = ANY($2) AND study IS NOT DISTINCT FROM $3`, [APP, auditIds, null]).catch(() => [])).map((x) => String(x.audit_id))
    : [];

  // Right Care funnel (§4/§7) — this doctor's dot vs specialty peers, case-mix adjusted. Peer grouping
  // + this doctor's specialty both come from doctor_directory (Neon) so the group is consistent.
  const [lvcCells, rcExclusions, dirRows] = await Promise.all([
    fetchLvcCells(),
    readRightCareExclusions(),
    runSql(`SELECT doctor_uid, speciality FROM doctor_directory WHERE speciality IS NOT NULL`, []).catch(() => []),
  ]);
  const specMap: Record<string, string> = {};
  for (const r of dirRows) specMap[String(r.doctor_uid)] = String(r.speciality);
  const oeAll = computeDoctorOE(lvcCells, new Set(rcExclusions));
  const funnelSpec = specMap[uid] || 'Unspecified';
  const funnelPeers = oeAll.filter((d) => (specMap[d.doctor_uid] || 'Unspecified') === funnelSpec);

  const nAudits = stats ? n(stats.nnotes) : 0;
  const meanIndex = stats ? n(stats.mean_index) : 0;
  const band = bandFor(meanIndex);
  const bandCounts: Record<string, number> = {};
  for (const b of bandDist) bandCounts[b.band] = n(b.c);
  const bandTotal = Object.values(bandCounts).reduce((s, x) => s + x, 0) || 1;

  // weekly index trend sparkline
  const idxs = weekly.map((w) => n(w.idx));
  const lo = Math.min(40, ...idxs, 100), hi = Math.max(85, ...idxs, 0);
  const tW = 360, tH = 56;
  const pts = weekly.map((w, i) => {
    const x = weekly.length <= 1 ? tW : (i / (weekly.length - 1)) * tW;
    const y = tH - ((n(w.idx) - lo) / Math.max(1, hi - lo)) * tH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">OPD Audit · doctor</div>
          <h1 className="font-serif text-[28px] font-semibold leading-tight text-slate-900">{doctor}</h1>
          <p className="mt-1 max-w-2xl text-[13.5px] text-slate-500">{specialty || 'OPD'} · advisory note-level documentation-quality proxy over {stats ? `${stats.first_date} → ${stats.last_date}` : 'all time'}. Not an outcomes measure or a clinician scorecard. <Link href="/admin/opd-audit/doctors" className="text-brand hover:underline">← All doctors</Link></p>
        </div>
        {nAudits > 0 && (nAudits <= BULK_CAP
          ? <a href={`/api/opd-audit/export-pdf?doctor=${uid}${rangeQs ? `&${rangeQs}` : ''}`} className="whitespace-nowrap rounded-lg border border-brand/40 px-3 py-1.5 text-[12px] font-medium text-brand hover:bg-brand-faint">↓ Download all ({nAudits}) as PDF</a>
          : <span className="whitespace-nowrap rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] text-slate-400" title={`PDF cap is ${BULK_CAP} — narrow the date range, or use the filtered "Download all" on the list below`}>{nAudits} audits · narrow to ≤{BULK_CAP} to export all</span>)}
      </div>

      {nAudits === 0 ? (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">No audits for this doctor{from || to ? ' in this date range' : ''}.</div>
      ) : (
        <>
          {/* stats header */}
          <div className="mt-5 grid gap-3 lg:grid-cols-[220px,minmax(0,1fr)]">
            <div className="rounded-xl border border-slate-200 bg-white p-4 text-center">
              <div className="font-serif text-[46px] font-semibold leading-none" style={{ color: bandColor(band) }}>{band}</div>
              <div className="mt-1 text-[13px] text-slate-500"><span className="font-serif text-[17px] font-semibold text-slate-800">{meanIndex}</span> / 100 mean index</div>
              <div className="mt-2 text-[11.5px] text-slate-500">{nAudits} audits · {n(stats?.low_value_rate)}% ≥1 low-value</div>
              <div className="mt-1 text-[10.5px] text-slate-400">{stats?.first_date} → {stats?.last_date}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-slate-400">Domain means</div>
              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {DOMAIN_MEANS.map((d) => {
                  const v = n(stats?.[d.k]); const c = scoreColor(v);
                  return (
                    <div key={d.k}>
                      <div className="flex items-baseline justify-between text-[11.5px]"><span className="text-slate-600">{d.label}</span><span className="font-medium tabular-nums" style={{ color: c }}>{v}</span></div>
                      <div className="mt-[3px] h-[6px] rounded bg-slate-100"><div className="h-full rounded" style={{ width: `${Math.max(2, v)}%`, background: c }} /></div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-3">
                <div className="min-w-[160px]">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.05em] text-slate-400">Band distribution</div>
                  <div className="flex h-4 overflow-hidden rounded-md">
                    {BANDS.map((b) => bandCounts[b] ? <span key={b} title={`${b} ${bandCounts[b]}`} style={{ width: `${(bandCounts[b] / bandTotal) * 100}%`, background: bandColor(b) }} /> : null)}
                  </div>
                  <div className="mt-1 flex justify-between text-[9.5px] text-slate-400">{BANDS.map((b) => <span key={b}>{b} {Math.round(((bandCounts[b] || 0) / bandTotal) * 100)}%</span>)}</div>
                </div>
                <div className="min-w-[200px] flex-1">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.05em] text-slate-400">Index over time · by week</div>
                  <svg viewBox={`0 0 ${tW} ${tH}`} width="100%" height={tH} preserveAspectRatio="none">
                    {pts && weekly.length > 1 && <polyline points={pts} fill="none" stroke="#0f766e" strokeWidth="2.5" />}
                    {weekly.map((w, i) => {
                      const x = weekly.length <= 1 ? tW : (i / (weekly.length - 1)) * tW;
                      const y = tH - ((n(w.idx) - lo) / Math.max(1, hi - lo)) * tH;
                      return <circle key={i} cx={x} cy={y} r="2.2" fill="#0f766e" />;
                    })}
                  </svg>
                  <div className="text-[10px] text-slate-400">{weekly.length > 1 ? `${idxs[0]} → ${idxs[idxs.length - 1]} over ${weekly.length} weeks` : 'building history — more weeks needed'}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Right Care funnel (§7) */}
          <div className="mt-5">
            <FunnelCard doctorUid={uid} specialty={funnelSpec} peers={funnelPeers} />
          </div>

          {/* the audit list (reuses NotesExplorer; its "Download all" honours any client filter) */}
          <div className="mt-5">
            <NotesExplorer rows={rows} triagedIds={triagedIds} />
          </div>
        </>
      )}
    </div>
  );
}
