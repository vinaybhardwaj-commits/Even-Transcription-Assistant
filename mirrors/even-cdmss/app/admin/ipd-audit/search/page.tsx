// /admin/ipd-audit/search — UHID / patient-name / IP-number search (S3.2). Server-rendered.
// PHI (name/UHID) is joined from db13 kx_discharge_summary_records AT READ TIME for this
// access-controlled view only — never stored. Each hit shows the admission envelope + audit
// status; un-audited filed docs get the "Audit now" primitive.
import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';

import { searchIpdAdmissions } from '@/lib/ipd-audit/db13';
import { Locked, IpdTabs, BandChip } from '../ui';
import AuditNowButton from '../audit-now-button';

export const dynamic = 'force-dynamic';

export default async function IpdAuditSearch({ searchParams }: { searchParams: Promise<{ q?: string; locked?: string }> }) {
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) return <Locked configured={adminTokenConfigured()} bad={sp.locked === '1'} />;

  const q = (sp.q ?? '').trim().slice(0, 60);
  const hits = q.length >= 2 ? await searchIpdAdmissions(q) : [];
  const docIds = hits.map((h) => h.documentId).filter(Boolean) as string[];
  const audited = new Map<string, { id: string; band: string; cvi: number }>();
  if (docIds.length) {
    const rows = (await sql(
      `SELECT DISTINCT ON (document_id) document_id, id, band, care_value_index
       FROM ipd_discharge_audits WHERE document_id = ANY($1) ORDER BY document_id, audited_at DESC`,
      [docIds],
    )) as Array<{ document_id: string; id: string; band: string; care_value_index: number }>;
    for (const r of rows) audited.set(r.document_id, { id: r.id, band: r.band, cvi: r.care_value_index });
  }

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">IPD Discharge Audit</div>
      <h1 className="font-serif text-[28px] font-semibold leading-tight text-slate-900 sm:text-[31px]">Search admissions</h1>
      <p className="mt-1 max-w-2xl text-[13.5px] text-slate-500">UHID, patient name, or IP number. Identifiers come from db13 at read time for this access-controlled view — they are never stored with the audit.</p>

      <IpdTabs active="search" />

      <form method="GET" className="mt-4 flex max-w-lg gap-2">
        <input name="q" defaultValue={q} placeholder="UHID-370420 · IP-1218 · patient name…"
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" autoFocus />
        <button className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white">Search</button>
      </form>

      {q.length >= 2 && (
        <div className="mt-5 rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3 text-[13px] font-semibold text-slate-800">{hits.length} admission{hits.length === 1 ? '' : 's'}</div>
          {hits.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-slate-500">No admissions match “{q}”.</div>
          ) : (
            <table className="w-full text-left text-[12.5px]">
              <thead><tr className="text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2">Patient</th><th className="px-2 py-2">IP</th><th className="px-2 py-2">Speciality · ward</th>
                <th className="px-2 py-2">Discharged</th><th className="px-2 py-2">LOS</th><th className="px-2 py-2">Summary</th><th className="px-2 py-2">Audit</th>
              </tr></thead>
              <tbody>
                {hits.map((h) => {
                  const a = h.documentId ? audited.get(h.documentId) : undefined;
                  return (
                    <tr key={h.ipUid} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-2"><span className="font-semibold text-slate-800">{h.patientName ?? '—'}</span><span className="ml-1.5 text-[11px] text-slate-400">{h.uhid ?? ''}</span></td>
                      <td className="px-2 py-2 text-slate-600">{h.ipUid}</td>
                      <td className="px-2 py-2 text-slate-600">{h.speciality ?? '—'}{h.ward ? ` · ${h.ward}` : ''}</td>
                      <td className="px-2 py-2 text-slate-600">{h.dischargeDate ?? '—'}{h.dischargeType ? ` (${h.dischargeType})` : ''}</td>
                      <td className="px-2 py-2 text-slate-600">{h.losDays == null ? '—' : `${h.losDays}d`}</td>
                      <td className="px-2 py-2">{h.pdfUrl ? <a href={h.pdfUrl} target="_blank" className="text-brand hover:underline">PDF ↗</a> : <span className="text-slate-400">not filed</span>}</td>
                      <td className="px-2 py-2">
                        {a ? <Link href={`/admin/ipd-audit/${a.id}`} className="hover:opacity-80"><BandChip band={a.band} cvi={a.cvi} /></Link>
                          : h.documentId ? <AuditNowButton documentId={h.documentId} />
                          : <span className="text-[11px] text-slate-400">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
