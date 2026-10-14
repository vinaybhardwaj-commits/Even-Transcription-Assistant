// /admin/ot-audit — CAT admin browser of landed OT notes.
// Day window matches IPD (?day=&period=day|week|month, IST). NABH % is the persisted column.
import Link from 'next/link';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { fmtIstDateLong, istDateRange, type Period } from '@/lib/opd-audit-ui';
import { loadHospitalLabels, loadMappedPulseNames, loadOtAdminWindow } from '@/lib/triage/ot-admin-read';
import {
  filterOtAdminList, meanPersistedNabhPct, pulseSurgeonLabel, siteIds,
  asMapStatus, asScoreBand,
} from '@/lib/triage/ot-admin-present';
import { Locked, OtFilterBar, MapChip, NabhPct, addDays, todayIst } from './ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'OT Audit · Admin' };

export default async function OtAuditList({ searchParams }: {
  searchParams: Promise<{ day?: string; period?: string; locked?: string; map?: string; site?: string; band?: string; surgeon?: string }>;
}) {
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) return <Locked configured={adminTokenConfigured()} bad={sp.locked === '1'} />;

  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.day ?? '') ? sp.day! : todayIst();
  const period: Period = sp.period === 'week' || sp.period === 'month' ? sp.period : 'day';
  const { from, to } = istDateRange(day, period);
  const map = asMapStatus(sp.map);
  const band = asScoreBand(sp.band);
  const site = (sp.site || '').trim();
  const surgeon = (sp.surgeon || '').trim();

  const [windowRows, hospitals] = await Promise.all([
    loadOtAdminWindow(from, to),
    loadHospitalLabels(),
  ]);
  const pulseNames = await loadMappedPulseNames(windowRows);
  const rows = filterOtAdminList(windowRows, { map, site, band, surgeon }, pulseNames);
  const mean = meanPersistedNabhPct(rows);
  const scored = rows.filter((r) => r.nabh_score_pct != null).length;
  const sites = siteIds(windowRows).map((id) => ({ id, label: hospitals[id] || id }));
  const keep = (patch: { day?: string; period?: Period; dropDay?: boolean }) => {
    const merged: Record<string, string | undefined> = {
      day: patch.dropDay ? undefined : (patch.day ?? day),
      period: patch.period ?? period,
      map, site: site || undefined, band, surgeon: surgeon || undefined,
    };
    const parts = Object.entries(merged)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    return `/admin/ot-audit?${parts.join('&')}`;
  };
  const periodLabel = period === 'day' ? fmtIstDateLong(day) : `${fmtIstDateLong(from)} → ${fmtIstDateLong(to)}`;
  const siteLabel = (uid: string | null) => (uid ? (hospitals[uid] || uid) : '—');

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">OT Audit</div>
          <h1 className="font-serif text-[28px] font-semibold leading-tight text-slate-900 sm:text-[31px]">Operative-note quality</h1>
          <p className="mt-1 max-w-2xl text-[13.5px] text-slate-500">
            {periodLabel} · final OT notes landed in Neon. NABH % is the stored ot-nabh score. The findings count is the action-queue lander screen, a separate check.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex overflow-hidden rounded-lg border border-slate-200">
            {(['day', 'week', 'month'] as Period[]).map((p) => (
              <Link key={p} href={keep({ period: p })} className={`px-3 py-1.5 text-xs capitalize ${period === p ? 'bg-brand text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{p}</Link>
            ))}
          </span>
          <span className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600">
            <Link href={keep({ day: addDays(day, -1) })} className="px-1 hover:text-brand">‹</Link>
            <span className="tabular-nums">{day}</span>
            <Link href={keep({ day: addDays(day, 1) })} className="px-1 hover:text-brand">›</Link>
          </span>
          {day !== todayIst() && <Link href={keep({ dropDay: true })} className="text-xs text-brand hover:underline">latest</Link>}
          <form method="POST" action="/api/admin/unlock?action=logout"><button className="whitespace-nowrap text-xs text-slate-400 hover:text-brand">Lock</button></form>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="text-[11px] font-semibold text-slate-500">Notes</div>
          <div className="mt-1 font-serif text-[24px] font-semibold leading-none text-slate-900">{rows.length}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="text-[11px] font-semibold text-slate-500">Mean persisted NABH %</div>
          <div className="mt-1 font-serif text-[24px] font-semibold leading-none text-slate-900">{mean == null ? '—' : <NabhPct pct={mean} />}</div>
          <div className="mt-1 text-[10px] text-slate-400">{scored} scored</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="text-[11px] font-semibold text-slate-500">Mapped</div>
          <div className="mt-1 font-serif text-[24px] font-semibold leading-none text-slate-900">{rows.filter((r) => r.map_status === 'mapped').length}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="text-[11px] font-semibold text-slate-500">Unmapped / hold</div>
          <div className="mt-1 font-serif text-[24px] font-semibold leading-none text-slate-900">{rows.filter((r) => r.map_status !== 'mapped').length}</div>
        </div>
      </div>

      <OtFilterBar day={day} period={period} map={map} site={site || undefined} band={band} surgeon={surgeon || undefined} sites={sites} />

      <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[920px] text-left text-[12.5px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2">Note day</th>
              <th className="px-2 py-2">Site</th>
              <th className="px-2 py-2">UHID</th>
              <th className="px-2 py-2">Surgery</th>
              <th className="px-2 py-2">Surgeon (raw)</th>
              <th className="px-2 py-2">Surgeon hop</th>
              <th className="px-2 py-2">NABH %</th>
              <th className="px-2 py-2">Findings</th>
              <th className="px-2 py-2">Engine</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-sm text-slate-500">No OT audits in this window.</td></tr>
            ) : rows.map((r) => {
              const hop = pulseSurgeonLabel({
                map_status: r.map_status,
                doctor_uid: r.doctor_uid,
                pulseName: r.doctor_uid ? pulseNames[r.doctor_uid] : null,
              });
              const href = `/admin/ot-audit/${r.id}?day=${day}&period=${period}`;
              return (
                <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 tabular-nums text-slate-700">{r.note_day}</td>
                  <td className="max-w-[140px] truncate px-2 py-2 text-slate-700" title={siteLabel(r.hospital_uid)}>{siteLabel(r.hospital_uid)}</td>
                  <td className="px-2 py-2 font-mono text-[11.5px] text-slate-700">{r.uhid || '—'}</td>
                  <td className="max-w-[200px] truncate px-2 py-2">
                    <Link href={href} className="font-medium text-slate-900 hover:text-brand">{r.surgery_name || 'Untitled surgery'}</Link>
                  </td>
                  <td className="max-w-[160px] truncate px-2 py-2 text-slate-700" title={r.surgeon_raw || ''}>{r.surgeon_raw || '—'}</td>
                  <td className="px-2 py-2">
                    <div className="flex flex-col gap-0.5">
                      <MapChip status={hop.status} />
                      {hop.status === 'mapped' && (
                        <span className="text-[11px] text-slate-700">{hop.pulseName || 'Pulse name unavailable'}</span>
                      )}
                      {hop.status === 'multi_surgeon_hold' && (
                        <span className="text-[11px] text-slate-500">multi-surgeon hold</span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-2"><NabhPct pct={r.nabh_score_pct} /></td>
                  <td className="px-2 py-2 tabular-nums text-slate-700">{r.n_findings}</td>
                  <td className="px-2 py-2 font-mono text-[10.5px] text-slate-500">{r.engine_version}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
