// /admin/ot-audit/[id] — one landed OT note.
// Order: header → persisted NABH grid → action-queue lander findings → note body.
// Primary key is the Neon row UUID. The page does not score.
import Link from 'next/link';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { fmtIstDateLong, parseJson } from '@/lib/opd-audit-ui';
import { OT_NABH_CRITERIA } from '@/lib/triage/ot-nabh';
import { loadHospitalLabels, loadMappedPulseNames, loadOtAdminDetail } from '@/lib/triage/ot-admin-read';
import { pulseSurgeonLabel, readPersistedCriteria } from '@/lib/triage/ot-admin-present';
import { MapChip, NabhPct } from '../ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'OT note audit · Admin' };

function LockedMsg() {
  return (
    <div className="mx-auto max-w-md py-16 text-center text-sm text-slate-500">
      This report is access-controlled. <Link href="/admin/ot-audit" className="text-brand hover:underline">Unlock the OT audit surface</Link> first.
    </div>
  );
}

function fmtWhen(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  return new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

function ScoreCell({ score, na }: { score: 0 | 1 | 2 | null; na: boolean }) {
  if (na) {
    return <span className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-semibold text-slate-500">N/A</span>;
  }
  if (score == null) return <span className="text-slate-400">—</span>;
  const tone = score === 2
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : score === 1
      ? 'border-amber-200 bg-amber-50 text-amber-900'
      : 'border-red-200 bg-red-50 text-red-800';
  return <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${tone}`}>{score}</span>;
}

type LanderFinding = { subject?: string; verdict?: string; rationale?: string; domain?: string };

export default async function OtAuditDetail({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ day?: string; period?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) return <LockedMsg />;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return <div className="p-8 text-sm text-slate-500">Bad audit id.</div>;

  const row = await loadOtAdminDetail(id);
  if (!row) {
    return <div className="p-8 text-sm text-slate-500">Audit not found. <Link href="/admin/ot-audit" className="text-brand hover:underline">Back to OT Audit</Link></div>;
  }

  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.day ?? '') ? sp.day! : row.note_day;
  const period = sp.period === 'week' || sp.period === 'month' ? sp.period : 'day';
  const back = `/admin/ot-audit?day=${day}&period=${period}`;

  const [hospitals, names] = await Promise.all([
    loadHospitalLabels(),
    loadMappedPulseNames([row]),
  ]);
  const hop = pulseSurgeonLabel({
    map_status: row.map_status,
    doctor_uid: row.doctor_uid,
    pulseName: row.map_status === 'mapped' && row.doctor_uid ? names[row.doctor_uid] : null,
  });
  const site = row.hospital_uid ? (hospitals[row.hospital_uid] || row.hospital_uid) : '—';
  const criteria = readPersistedCriteria(row.nabh_criteria);
  const hasGrid = row.nabh_score_pct != null || Object.keys(criteria).length > 0;
  const parsedFindings = parseJson<unknown>(row.findings, []);
  const findings: LanderFinding[] = Array.isArray(parsedFindings) ? parsedFindings as LanderFinding[] : [];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={back} className="text-xs text-brand hover:underline">‹ OT Audit</Link>
        <form method="POST" action="/api/admin/unlock?action=logout"><button className="text-xs text-slate-400 hover:text-brand">Lock</button></form>
      </div>

      <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">OT Audit</div>
        <h1 className="mt-1 font-serif text-[26px] font-semibold leading-tight text-slate-900">{row.surgery_name || 'Operative note'}</h1>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
          <div><dt className="text-[11px] uppercase tracking-wide text-slate-400">uid</dt><dd className="font-mono text-[12px] text-slate-800">{row.uid}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-wide text-slate-400">Note day</dt><dd className="text-slate-800">{fmtIstDateLong(row.note_day)}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-wide text-slate-400">Site</dt><dd className="text-slate-800">{site}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-wide text-slate-400">UHID</dt><dd className="font-mono text-[12px] text-slate-800">{row.uhid || '—'}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-wide text-slate-400">Encounter</dt><dd className="font-mono text-[12px] text-slate-800">{row.encounter_id || '—'}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-wide text-slate-400">Surgeon (raw)</dt><dd className="text-slate-800">{row.surgeon_raw || '—'}</dd></div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-slate-400">Surgeon hop</dt>
            <dd className="mt-0.5 flex flex-wrap items-center gap-2">
              <MapChip status={hop.status} />
              {hop.status === 'mapped' && <span className="text-slate-800">{hop.pulseName || 'Pulse name unavailable'}</span>}
              {hop.status === 'unmapped' && <span className="text-slate-500">unmapped</span>}
              {hop.status === 'multi_surgeon_hold' && <span className="text-slate-500">multi-surgeon hold</span>}
            </dd>
          </div>
          <div><dt className="text-[11px] uppercase tracking-wide text-slate-400">Lander engine</dt><dd className="font-mono text-[12px] text-slate-700">{row.engine_version}</dd></div>
        </dl>
      </div>

      <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-serif text-[20px] font-semibold text-slate-900">NABH completeness</h2>
            <p className="mt-1 text-[12.5px] text-slate-500">Primary screen. 24 criteria, scored 0 / 1 / 2. N/A only for implants and specimens. Read from the stored row.</p>
          </div>
          <div className="text-right">
            <div className="font-serif text-[28px] font-semibold leading-none"><NabhPct pct={row.nabh_score_pct} /></div>
            <div className="mt-1 text-[12px] text-slate-500">
              {row.nabh_score_sum == null || row.nabh_score_max == null
                ? 'Sum / max not stored'
                : `${row.nabh_score_sum} / ${row.nabh_score_max}`}
            </div>
            <div className="mt-0.5 font-mono text-[10.5px] text-slate-400">
              {row.nabh_engine_version || 'not scored'} · {fmtWhen(row.nabh_scored_at)}
            </div>
          </div>
        </div>
        {!hasGrid ? (
          <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] text-slate-600">
            Not scored yet. This row has no persisted ot-nabh result. The grid stays empty until the lander or backfill writes it.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-2">Criterion</th>
                  <th className="py-2 pr-2">Score</th>
                  <th className="py-2">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {OT_NABH_CRITERIA.map(([key, label]) => {
                  const cell = criteria[key];
                  return (
                    <tr key={key} className="border-t border-slate-100">
                      <td className="py-2 pr-3">
                        <div className="font-medium text-slate-800">{label}</div>
                        <div className="font-mono text-[10.5px] text-slate-400">{key}</div>
                      </td>
                      <td className="py-2 pr-3 align-top">
                        <ScoreCell score={cell?.score ?? null} na={cell?.na === true} />
                      </td>
                      <td className="py-2 text-slate-600">{cell?.evidence || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-serif text-[20px] font-semibold text-slate-900">Action-queue lander screen</h2>
        <p className="mt-1 text-[12.5px] text-slate-500">
          Secondary. Documentation findings from engine <span className="font-mono text-[11.5px]">{row.engine_version || 'ot-note-audit/0.1'}</span>. These are not the NABH rubric.
        </p>
        <div className="mt-2 text-[12px] text-slate-500">{row.n_findings} finding{row.n_findings === 1 ? '' : 's'}</div>
        {findings.length === 0 ? (
          <p className="mt-3 text-[13px] text-slate-500">No lander findings stored.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {findings.map((f, i) => (
              <li key={i} className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium text-slate-900">{f.subject || 'Finding'}</span>
                  {f.verdict && <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-slate-600">{f.verdict}</span>}
                </div>
                {f.rationale && <p className="mt-1 text-[12.5px] leading-relaxed text-slate-600">{f.rationale}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-serif text-[20px] font-semibold text-slate-900">Note body</h2>
        <p className="mt-1 text-[12.5px] text-slate-500">Admin-unlocked view of the stored operative note. Not a shareable export.</p>
        {row.note && row.note.trim() ? (
          <div className="mt-3 max-h-[480px] overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12.5px] leading-relaxed text-slate-800">{row.note}</div>
        ) : (
          <p className="mt-3 text-[13px] text-slate-500">No note body stored.</p>
        )}
      </section>
    </div>
  );
}
