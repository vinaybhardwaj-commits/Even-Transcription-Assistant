import Link from 'next/link';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { fetchDoctorNames, fetchDoctorSpecialities } from '@/lib/metabase';
import { doctorLabel, scoreColor } from '@/lib/opd-audit-ui';
import { fetchDoctorIndex, fetchLvcCells, readRightCareExclusions } from '@/lib/opd-audit-doctor';
import { computeDoctorOE, FUNNEL_MIN_N, type DoctorOE } from '@/lib/opd-funnel-core';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'OPD Audit · By doctor' };

const n = (v: unknown): number => Number(v ?? 0);

function Locked() {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">OPD Audit · by doctor</h1>
      <p className="mt-1.5 text-sm text-slate-500">Locked. <Link href="/admin/opd-audit" className="text-brand hover:underline">Unlock the OPD Audit surface</Link> first.</p>
    </div>
  );
}

export default async function DoctorIndex({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) { adminTokenConfigured(); return <Locked />; }

  const [rows, lvcCells, rcExclusions] = await Promise.all([
    fetchDoctorIndex(), fetchLvcCells(), readRightCareExclusions(),
  ]);
  const exclSet = new Set(rcExclusions);
  const oeMap = new Map<string, DoctorOE>(computeDoctorOE(lvcCells, exclSet).map((d) => [d.doctor_uid, d]));
  const uids = rows.map((r) => r.doctor_uid);
  const [names, specs] = await Promise.all([
    fetchDoctorNames(uids).catch(() => ({} as Record<string, string>)),
    fetchDoctorSpecialities(uids).catch(() => ({} as Record<string, { name: string; speciality: string }>)),
  ]);
  // "vs expected" ± points (raw − expected). n<10 or excluded/unbanded → em-dash (§8).
  const vsExpected = (uid: string): { txt: string; tone: string; title: string } => {
    if (exclSet.has(uid)) return { txt: '—', tone: 'text-slate-300', title: 'excluded (house/non-clinician account)' };
    const oe = oeMap.get(uid);
    if (!oe || oe.n < FUNNEL_MIN_N) return { txt: '—', tone: 'text-slate-300', title: `building history (n<${FUNNEL_MIN_N} banded notes)` };
    const pts = Math.round((oe.raw_rate - oe.expected_rate) * 100);
    const txt = pts > 0 ? `+${pts}` : `${pts}`;
    const tone = pts >= 3 ? 'text-amber-700' : pts <= -3 ? 'text-emerald-700' : 'text-slate-500';
    return { txt, tone, title: `observed ${Math.round(oe.raw_rate * 100)}% vs expected ${Math.round(oe.expected_rate * 100)}% (n=${oe.n})` };
  };
  const nameOf = (uid: string) => names[uid] || specs[uid]?.name || doctorLabel(uid);
  const specOf = (uid: string) => specs[uid]?.speciality || '';

  const q = (sp.q || '').trim().toLowerCase();
  const list = rows
    .map((r) => ({ ...r, name: nameOf(r.doctor_uid), specialty: specOf(r.doctor_uid) }))
    .filter((r) => !q || `${r.name} ${r.specialty}`.toLowerCase().includes(q));

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">OPD Audit</div>
          <h1 className="font-serif text-[28px] font-semibold leading-tight text-slate-900">By doctor</h1>
          <p className="mt-1 max-w-2xl text-[13.5px] text-slate-500">Every doctor with at least one audited note, across all time. Advisory — a note-level documentation-quality proxy, not an outcomes measure or a clinician scorecard. <Link href="/admin/opd-audit" className="text-brand hover:underline">← Back to daily</Link></p>
          {rcExclusions.length > 0 && <p className="mt-0.5 text-[11px] text-slate-400">Right Care: {rcExclusions.length} house/non-clinician account(s) excluded from “vs expected”.</p>}
        </div>
        <form method="GET" className="flex items-center gap-2">
          <input name="q" defaultValue={sp.q || ''} placeholder="Search name or specialty…"
            className="w-56 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[12px] text-slate-700 outline-none focus:border-brand" />
          <button type="submit" className="rounded-lg border border-brand/40 px-3 py-1.5 text-[12px] font-medium text-brand hover:bg-brand-faint">Search</button>
          {q && <Link href="/admin/opd-audit/doctors" className="text-[12px] text-slate-400 hover:text-brand">clear</Link>}
        </form>
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex items-baseline justify-between border-b border-slate-100 px-4 py-2.5">
          <span className="font-serif text-[14px] font-semibold text-slate-900">Doctors</span>
          <span className="text-[11px] text-slate-400">{list.length}{q ? ` of ${rows.length}` : ''} · highest volume first</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11.5px]">
            <thead className="bg-white text-[10px] text-slate-400">
              <tr>
                <th className="px-4 py-1.5 text-left font-normal">doctor</th>
                <th className="px-2 py-1.5 text-left font-normal">specialty</th>
                <th className="px-2 py-1.5 text-right font-normal">audits</th>
                <th className="px-2 py-1.5 text-right font-normal">mean index</th>
                <th className="px-2 py-1.5 text-right font-normal">low-value</th>
                <th className="px-2 py-1.5 text-right font-normal" title="observed minus case-mix-expected LVC rate, in points">vs expected</th>
                <th className="px-4 py-1.5 text-right font-normal">last audited</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.doctor_uid} className="border-t border-slate-50 hover:bg-slate-50">
                  <td className="px-4 py-1.5 text-slate-700"><Link href={`/admin/opd-audit/doctor/${r.doctor_uid}`} className="font-medium hover:text-brand hover:underline">{r.name}</Link></td>
                  <td className="px-2 py-1.5 text-slate-400">{r.specialty || '—'}</td>
                  <td className="px-2 py-1.5 text-right text-slate-600">{n(r.nnotes)}</td>
                  <td className="px-2 py-1.5 text-right font-medium tabular-nums" style={{ color: scoreColor(n(r.mean_index)) }}>{n(r.mean_index)}</td>
                  <td className="px-2 py-1.5 text-right text-slate-500">{n(r.low_value_rate)}%</td>
                  {(() => { const v = vsExpected(r.doctor_uid); return <td className={`px-2 py-1.5 text-right tabular-nums ${v.tone}`} title={v.title}>{v.txt}</td>; })()}
                  <td className="px-4 py-1.5 text-right text-slate-400">{r.last_audited}</td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-[12px] text-slate-400">No doctors match.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
