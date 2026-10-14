// /admin/ipd-audit — IPD Discharge Audit OVERVIEW (S3.1). Server-rendered; reads
// ipd_discharge_audits (renders an informative empty state while the table fills) + a db13
// filed-count for context. Access-controlled by the admin unlock; PHI never appears here —
// the overview is aggregate + link-back keys only.
import Link from 'next/link';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { bandColor, istDateRange, fmtIstDateLong, type Period } from '@/lib/opd-audit-ui';
import { bandFor, DOMAIN_LABEL, DEFAULT_WEIGHTS, VALUE_DOMAINS } from '@/lib/value-score-core';
import {
  ipdWorklist, ipdOverviewStats, reviewsForAudits,
  type ReviewedFilter, type RangePreset,
} from '@/lib/ipd-audit/store';
import { fetchDoctorsForAudits, groupByDoctor } from '@/lib/ipd-audit/doctor-lookup';
import { dischargeDocDensity, namesForIpUids } from '@/lib/ipd-audit/db13';
import { Locked, IpdTabs, PipelineStrip, BandChip, ReviewedChip, IpdFilterBar, DoctorUnavailableNotice, addDays, todayIst } from './ui';

export const dynamic = 'force-dynamic';

const DOMAIN_COL: Record<string, string> = {
  appropriateness: 'score_appropriateness', efficiency: 'score_efficiency', safety: 'score_safety',
  cost: 'score_cost', documentation: 'score_documentation', patient_centred: 'score_patient_centred',
};

export default async function IpdAuditOverview({ searchParams }: {
  searchParams: Promise<{ day?: string; period?: string; locked?: string; speciality?: string; range?: string; from?: string; to?: string; reviewed?: string; group?: string }>;
}) {
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) return <Locked configured={adminTokenConfigured()} bad={sp.locked === '1'} />;

  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.day ?? '') ? sp.day! : todayIst();
  const period: Period = sp.period === 'week' || sp.period === 'month' ? sp.period : 'day';
  const { from, to } = istDateRange(day, period);

  // ── Phase B filter state (the hero cards above keep their own day/period window; these govern
  //    the worklist below, which is the surface Dr. Binita actually reviews from) ──
  const filterSp: Record<string, string | undefined> = {
    speciality: sp.speciality, range: sp.range, reviewed: sp.reviewed, group: sp.group,
    from: sp.from, to: sp.to, day: sp.day, period: sp.period,
  };
  const groupByDoctorOn = sp.group === 'doctor';

  // §1.2 — the hero aggregates are ONE ROW PER DOCUMENT too. `ipdOverviewStats` fetches the window
  // and reduces it with the same pure rule the worklist uses, so a re-audited summary is counted
  // once here exactly as it is counted once below.
  const [stats, filed] = await Promise.all([
    ipdOverviewStats(from, to),
    dischargeDocDensity(from, to).catch(() => ({} as Record<string, number>)),
  ]);
  const bandRows = stats.bands;

  // ── Phase B — the filtered worklist, its doctor attributions and its review markers ──
  // Each of these fails soft on its own: an unreadable list is [], an unreachable db13 is
  // Unattributed + one notice, an unrun migration 0028 is no chips. None can take the page down.
  // ONE canonical fetch → the rows, the true total, and the chip counts. The chip and the doctor
  // view therefore read the same number off the same array (§1.2 acceptance).
  const { rows: listRows, total: totalInRange, specialities, capped } = await ipdWorklist({
    speciality: sp.speciality, reviewed: sp.reviewed as ReviewedFilter | undefined,
    range: (sp.range as RangePreset | undefined) ?? 'last_3_months',
    from: sp.from, to: sp.to, limit: 200,
  });
  const listIds = listRows.map((r) => String(r.id));
  const [reviews, doctors] = await Promise.all([
    reviewsForAudits(listIds),
    // ONE batched db13 call for the whole page — never one per row (§6.3).
    fetchDoctorsForAudits(listRows.map((r) => ({ ipUid: r.ip_uid as string | null, speciality: r.speciality as string | null }))),
  ]);
  const reviewedCount = listIds.filter((id) => reviews[id]).length;
  const byId = new Map(listRows.map((r) => [String(r.id), r as Record<string, unknown>]));
  const doctorGroups = groupByDoctorOn
    ? groupByDoctor(
        listRows.map((r) => ({ id: String(r.id), ipUid: r.ip_uid as string | null, completeness: r.completeness_pct as number | null, band: r.band as string | null })),
        doctors.byIpUid,
      )
    : [];

  // read-time PHI join for every row we render (ONE batched query; never persisted)
  const names = await namesForIpUids(
    listRows.map((r) => String(r.ip_uid ?? '')).filter(Boolean),
  ).catch(() => ({} as Record<string, { patientName: string | null; uhid: string | null }>));

  const total = stats.total;
  const meanCvi = stats.meanCvi;
  const band = bandFor(meanCvi);
  const filedCount = Object.values(filed).reduce((a, b) => a + b, 0);
  const periodLabel = period === 'day' ? fmtIstDateLong(day) : `${fmtIstDateLong(from)} → ${fmtIstDateLong(to)}`;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">IPD Discharge Audit</div>
          <h1 className="font-serif text-[28px] font-semibold leading-tight text-slate-900 sm:text-[31px]">Discharge-summary quality</h1>
          <p className="mt-1 max-w-2xl text-[13.5px] text-slate-500">{periodLabel} · every KareXpert discharge summary, read by the Case-Audit engine. Advisory — a process &amp; documentation proxy, not a clinician scorecard.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex overflow-hidden rounded-lg border border-slate-200">
            {(['day', 'week', 'month'] as Period[]).map((p) => (
              <Link key={p} href={`/admin/ipd-audit?day=${day}&period=${p}`} className={`px-3 py-1.5 text-xs capitalize ${period === p ? 'bg-brand text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{p}</Link>
            ))}
          </span>
          <span className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600">
            <Link href={`/admin/ipd-audit?day=${addDays(day, -1)}&period=${period}`} className="px-1 hover:text-brand">‹</Link>
            <span className="tabular-nums">{day}</span>
            <Link href={`/admin/ipd-audit?day=${addDays(day, 1)}&period=${period}`} className="px-1 hover:text-brand">›</Link>
          </span>
          {day !== todayIst() && <Link href={`/admin/ipd-audit?period=${period}`} className="text-xs text-brand hover:underline">latest</Link>}
          <form method="POST" action="/api/admin/unlock?action=logout"><button className="whitespace-nowrap text-xs text-slate-400 hover:text-brand">Lock</button></form>
        </div>
      </div>

      <IpdTabs active="overview" />

      {total === 0 ? (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No audits for this {period} yet{filedCount > 0 ? <> — <b>{filedCount}</b> discharge summar{filedCount === 1 ? 'y was' : 'ies were'} filed in the period</> : null}.
          Audit one from <Link href="/admin/ipd-audit/calendar" className="text-brand hover:underline">the calendar</Link> or <Link href="/admin/ipd-audit/search" className="text-brand hover:underline">search</Link>; the daily worker (S5) will fill this automatically.
        </div>
      ) : (
        <>
          {/* HERO band card */}
          <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div className="flex flex-col gap-5 p-5 sm:flex-row">
              <div className="flex shrink-0 flex-row items-center gap-4 border-b border-slate-100 pb-4 sm:w-[132px] sm:flex-col sm:gap-1 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-5">
                <div className="font-serif text-[58px] font-semibold leading-none" style={{ color: bandColor(band) }}>{band}</div>
                <div className="flex flex-col sm:items-center">
                  <div className="text-[13px] text-slate-500"><span className="font-serif text-[18px] font-semibold text-slate-800">{meanCvi}</span> / 100</div>
                  <div className="mt-1 rounded-md px-2 py-0.5 text-[11px] font-semibold text-white" style={{ background: bandColor(band) }}>{meanCvi >= 70 ? 'On track' : meanCvi >= 55 ? 'Watch' : 'Needs attention'}</div>
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="font-serif text-[16.5px] font-semibold text-slate-900">{period === 'day' ? `How ${fmtIstDateLong(day)} looked` : 'How this period looked'}</h2>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-slate-700">
                  <b>{total} discharge summar{total === 1 ? 'y' : 'ies'}</b> audited ({filedCount} filed). Mean Care-Value Index <b style={{ color: bandColor(band) }}>{meanCvi}</b>, completeness <b>{stats.meanCompleteness}%</b>, with <b>{stats.lowValue}</b> low-value and <b>{stats.contextDependent}</b> context-dependent findings.
                  {' '}Bands: {bandRows.sort((a, b) => a.band.localeCompare(b.band)).map((b) => `${b.band}×${b.n}`).join(' · ') || '—'}.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-[10px] text-slate-400">E</span>
                  <div className="relative h-2 flex-1 rounded-full" style={{ background: 'linear-gradient(90deg,#dc2626 0%,#ea580c 28%,#d97706 50%,#16a34a 74%,#0d9488 100%)' }}>
                    <span className="absolute top-[-3px] h-[14px] w-[3px] rounded-sm bg-slate-900 ring-2 ring-white" style={{ left: `${Math.max(0, Math.min(100, meanCvi))}%` }} />
                  </div>
                  <span className="text-[10px] text-slate-400">A</span>
                </div>
              </div>
            </div>
          </div>

          {/* six Care-Value domain pillars */}
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {VALUE_DOMAINS.map((d) => {
              const score = stats.domains[DOMAIN_COL[d]] ?? null;
              return (
                <div key={d} className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-[11px] font-semibold text-slate-500">{DOMAIN_LABEL[d]}</div>
                  <div className="mt-1 font-serif text-[24px] font-semibold leading-none text-slate-900">{score ?? '—'}</div>
                  <div className="mt-1.5 h-1.5 rounded-full bg-slate-100">
                    <div className="h-1.5 rounded-full bg-brand" style={{ width: `${score ?? 0}%` }} />
                  </div>
                  <div className="mt-1 text-[10px] text-slate-400">weight {Math.round(DEFAULT_WEIGHTS[d] * 100)}%</div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <PipelineStrip />

      {/* ── Phase B — the review worklist: filters, optional doctor grouping, reviewed marker ── */}
      <IpdFilterBar basePath="/admin/ipd-audit" sp={filterSp} specialities={specialities} />
      {doctors.unavailable && <DoctorUnavailableNotice />}

      <div className="mt-3 rounded-xl border border-slate-200 bg-white">
        <div className="flex items-baseline justify-between border-b border-slate-100 px-4 py-3">
          <span className="text-[13px] font-semibold text-slate-800">
            {groupByDoctorOn ? 'By doctor' : 'Audits'}
          </span>
          <span className="text-[11.5px] text-slate-400">
            {totalInRange} in range{capped ? ` · showing ${listRows.length}` : ''}{reviewedCount > 0 ? ` · ${reviewedCount} reviewed` : ''}
          </span>
        </div>

        {listRows.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-slate-500">
            No audits match these filters. <Link href="/admin/ipd-audit" className="text-brand hover:underline">Clear them</Link>.
          </div>
        ) : groupByDoctorOn ? (
          <div>
            {doctorGroups.map((g) => (
              <details key={g.name} className="border-t border-slate-100 first:border-t-0">
                <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-slate-50">
                  <span className="text-[13px] font-semibold text-slate-900">{g.name}</span>
                  {g.specialityUnconfirmed && (
                    <span title="Resolved by recency — the audit carried no speciality to match on." className="text-[10.5px] text-slate-400">speciality unconfirmed</span>
                  )}
                  <span className="text-[12px] text-slate-500">{g.n} discharge{g.n === 1 ? '' : 's'}</span>
                  <span className="text-[12px] text-slate-500">mean completeness {g.meanCompleteness == null ? '—' : `${g.meanCompleteness}%`}</span>
                  <span className="text-[11.5px] text-slate-400">
                    {['A', 'B', 'C', 'D', 'E'].filter((b) => g.bands[b]).map((b) => `${b}×${g.bands[b]}`).join(' · ') || '—'}
                  </span>
                </summary>
                <table className="w-full text-left text-[12.5px]">
                  <tbody>
                    {g.auditIds.map((id) => {
                      const r = byId.get(id);
                      if (!r) return null;
                      return <AuditRow key={id} r={r} names={names} reviews={reviews} indent />;
                    })}
                  </tbody>
                </table>
              </details>
            ))}
          </div>
        ) : (
          <table className="w-full text-left text-[12.5px]">
            <thead><tr className="text-[11px] uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2">Patient</th><th className="px-2 py-2">Doctor</th><th className="px-2 py-2">Speciality</th><th className="px-2 py-2">CVI</th>
              <th className="px-2 py-2">Findings</th><th className="px-2 py-2">Compl.</th><th className="px-2 py-2">Discharged</th><th className="px-2 py-2" />
            </tr></thead>
            <tbody>
              {listRows.map((r) => (
                <AuditRow key={String(r.id)} r={r} names={names} reviews={reviews} doctor={doctors.byIpUid[String(r.ip_uid ?? '')]?.name} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** One audit row, shared by the flat list and the expanded doctor groups. */
function AuditRow({ r, names, reviews, doctor, indent }: {
  r: Record<string, unknown>;
  names: Record<string, { patientName: string | null; uhid: string | null }>;
  reviews: Record<string, { note: string; reviewedByName: string | null; at: string | null }>;
  doctor?: string;
  indent?: boolean;
}) {
  const ipUid = String(r.ip_uid ?? '');
  const id = String(r.id);
  const review = reviews[id];
  return (
    <tr className="border-t border-slate-100 hover:bg-slate-50">
      <td className={`py-2 ${indent ? 'pl-8 pr-2' : 'px-4'}`}>
        <Link href={`/admin/ipd-audit/${id}`} className="font-semibold text-brand hover:underline">
          {names[ipUid]?.patientName ?? String(r.ip_uid ?? id).slice(0, 18)}
        </Link>
        {names[ipUid]?.uhid && <span className="ml-1.5 text-[11px] text-slate-400">{names[ipUid]!.uhid}</span>}
      </td>
      {doctor !== undefined && <td className="px-2 py-2 text-slate-600">{doctor}</td>}
      <td className="px-2 py-2 text-slate-600">{String(r.speciality ?? '—')}</td>
      <td className="px-2 py-2"><BandChip band={String(r.band)} cvi={Number(r.care_value_index)} /></td>
      <td className="px-2 py-2 text-slate-600">{Number(r.n_low_value)} LV · {Number(r.n_context_dependent)} CD</td>
      <td className="px-2 py-2 text-slate-600">{r.completeness_pct == null ? '—' : `${Number(r.completeness_pct)}%`}</td>
      <td className="px-2 py-2 text-slate-500">{String(r.discharged_day ?? r.audited ?? '—')}</td>
      <td className="px-2 py-2">{review ? <ReviewedChip by={review.reviewedByName} at={review.at} /> : null}</td>
    </tr>
  );
}
