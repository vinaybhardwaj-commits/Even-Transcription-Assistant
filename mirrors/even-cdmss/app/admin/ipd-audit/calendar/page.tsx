// /admin/ipd-audit/calendar — density heatmap of discharge summaries by discharge/filed date
// (S3.3), with a day rail listing that day's summaries + audit status. Server-rendered; the
// density comes from db13 (filed docs) with the audited overlay from Neon. No PHI on this view
// (envelope only — the report page joins identifiers at read time).
import Link from 'next/link';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { fmtIstDateLong } from '@/lib/opd-audit-ui';
import { dischargeDocDensity, dischargeDocsForDay } from '@/lib/ipd-audit/db13';
import { specialityOptions, ipdAuditedByDay } from '@/lib/ipd-audit/store';
import { Locked, IpdTabs, BandChip, IpdFilterBar, todayIst } from '../ui';
import AuditNowButton from '../audit-now-button';

export const dynamic = 'force-dynamic';

function monthDays(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}
function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}
const heat = (n: number) => n === 0 ? 'bg-slate-100 text-slate-400'
  : n <= 2 ? 'bg-teal-100 text-teal-900' : n <= 5 ? 'bg-teal-300 text-teal-950' : n <= 9 ? 'bg-teal-500 text-white' : 'bg-teal-700 text-white';

export default async function IpdAuditCalendar({ searchParams }: { searchParams: Promise<{ month?: string; day?: string; locked?: string; speciality?: string }> }) {
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) return <Locked configured={adminTokenConfigured()} bad={sp.locked === '1'} />;

  const month = /^\d{4}-\d{2}$/.test(sp.month ?? '') ? sp.month! : todayIst().slice(0, 7);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.day ?? '') ? sp.day! : null;
  const days = monthDays(month);

  // §6.1 — the speciality filter also appears here. It narrows the AUDITED overlay only; see the
  // note rendered beside the heatmap for why the density itself cannot be filtered.
  const specialityFilter = (sp.speciality ?? '').trim();
  const specFiltered = specialityFilter && specialityFilter !== 'all';

  const [density, dayDocs, auditedCanonical, specialities] = await Promise.all([
    dischargeDocDensity(days[0], days[days.length - 1]).catch(() => ({} as Record<string, number>)),
    day ? dischargeDocsForDay(day).catch(() => []) : Promise.resolve([]),
    // §1.2 — ONE ROW PER DOCUMENT, the same pure rule the list and the overview use. Both the heat
    // counts and the day-rail chips come from this single call, so a re-audited summary is counted
    // once in the cell and marked once in the rail.
    ipdAuditedByDay(month, specFiltered ? specialityFilter : null),
    specialityOptions({ range: 'custom', from: `${month}-01`, to: `${month}-31` }).catch(() => []),
  ]);
  const auditedByDay = new Map(Object.entries(auditedCanonical.byDay));
  const audited = new Map(Object.entries(auditedCanonical.byDocument));

  const total = days.reduce((s, d) => s + (density[d] ?? 0), 0);
  const firstDow = new Date(`${days[0]}T00:00:00Z`).getUTCDay(); // 0 Sun

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">IPD Discharge Audit</div>
      <h1 className="font-serif text-[28px] font-semibold leading-tight text-slate-900 sm:text-[31px]">Discharge calendar</h1>
      <p className="mt-1 max-w-2xl text-[13.5px] text-slate-500">Summaries by discharge date (filed date where unlinked). Pick a day to list its summaries.</p>

      <IpdTabs active="calendar" />

      <IpdFilterBar basePath="/admin/ipd-audit/calendar" sp={{ month, day: day ?? undefined, speciality: sp.speciality }} specialities={specialities} />
      {specFiltered && (
        <p className="mt-2 text-[11.5px] text-slate-400">
          Speciality narrows the <b>audited</b> counts only. The density heat is every discharge summary FILED in db13,
          which carries no speciality — that lives on the audit, so an unaudited summary has none to filter on.
        </p>
      )}

      <div className="mt-4 flex flex-col gap-5 lg:flex-row">
        {/* month heatmap */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 lg:w-[420px]">
          <div className="flex items-center justify-between">
            <Link href={`/admin/ipd-audit/calendar?month=${addMonths(month, -1)}`} className="px-2 text-slate-400 hover:text-brand">‹</Link>
            <div className="text-[13px] font-semibold text-slate-800">{month} · {total} summaries</div>
            <Link href={`/admin/ipd-audit/calendar?month=${addMonths(month, 1)}`} className="px-2 text-slate-400 hover:text-brand">›</Link>
          </div>
          <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[10px] text-slate-400">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i}>{d}</div>)}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {Array.from({ length: firstDow }, (_, i) => <div key={`pad${i}`} />)}
            {days.map((d) => {
              const n = density[d] ?? 0;
              const na = auditedByDay.get(d) ?? 0;
              return (
                <Link key={d} href={`/admin/ipd-audit/calendar?month=${month}&day=${d}`}
                  className={`relative flex h-10 flex-col items-center justify-center rounded-md text-[11px] font-semibold ${heat(n)} ${day === d ? 'ring-2 ring-brand' : ''}`}>
                  <span>{Number(d.slice(8))}</span>
                  {n > 0 && <span className="text-[9px] font-normal opacity-80">{n}</span>}
                  {na > 0 && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-indigo-500" title={`${na} audited`} />}
                </Link>
              );
            })}
          </div>
          <div className="mt-3 text-[10.5px] text-slate-400">cell = summaries that day · <span className="mx-0.5 inline-block h-1.5 w-1.5 rounded-full bg-indigo-500 align-middle" /> = audited</div>
        </div>

        {/* day rail */}
        <div className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3 text-[13px] font-semibold text-slate-800">
            {day ? `${fmtIstDateLong(day)} · ${dayDocs.length} summar${dayDocs.length === 1 ? 'y' : 'ies'}` : 'Pick a day'}
          </div>
          {!day ? (
            <div className="px-4 py-8 text-center text-sm text-slate-500">Select a day on the heatmap to list its discharge summaries.</div>
          ) : dayDocs.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-slate-500">No discharge summaries for this day.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {dayDocs.map((d) => {
                const a = audited.get(d.documentId);
                return (
                  <li key={d.documentId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[12.5px]">
                    <span>
                      <span className="font-semibold text-slate-800">{d.patientName ?? d.ipUid ?? d.documentId.slice(0, 10)}</span>
                      {d.uhid && <span className="ml-1.5 text-[11px] text-slate-400">{d.uhid}</span>}
                      <span className="ml-2 text-slate-500">{d.patientName ? `${d.ipUid ?? ''} · ` : ''}{d.speciality ?? '—'}{d.losDays != null ? ` · LOS ${d.losDays}d` : ''}{d.dischargeType ? ` · ${d.dischargeType}` : ''}</span>
                    </span>
                    {a ? <Link href={`/admin/ipd-audit/${a.id}`} className="hover:opacity-80"><BandChip band={a.band} cvi={a.cvi} /></Link>
                      : <AuditNowButton documentId={d.documentId} />}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
