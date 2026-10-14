import { computeFunnel, type FunnelState } from '@/lib/ccb-funnel';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata = { title: 'Care Brief Funnel · Admin · CAT' };

const STATE_LABEL: Record<FunnelState, string> = { internalized: 'Internalized', written_off: 'Written off', pending: 'Pending' };
const STATE_TONE: Record<FunnelState, string> = {
  internalized: 'bg-teal-50 text-teal-800',
  written_off: 'bg-red-50 text-red-700',
  pending: 'bg-slate-100 text-slate-500',
};

function Metric({ label, value, sub, tone = 'neutral' }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' | 'neutral' }) {
  const color = tone === 'good' ? 'text-teal-700' : tone === 'bad' ? 'text-red-700' : 'text-slate-900';
  return (
    <div className="rounded-lg bg-slate-50 p-3.5">
      <div className="text-[12px] text-slate-500">{label}</div>
      <div className={`text-[22px] font-medium leading-tight ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

export default async function CcbFunnel() {
  if (process.env.CCB_ENABLED !== '1') {
    return <div className="mx-auto max-w-3xl px-5 py-10 text-[13px] text-slate-500">Care Conversation Brief is not enabled.</div>;
  }
  const f = await computeFunnel(90).catch(() => null);

  return (
    <div className="mx-auto max-w-4xl px-5 py-8" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <h1 className="text-[20px] font-semibold text-slate-900">Care Brief — conversion funnel</h1>
      <p className="text-[12.5px] text-slate-500">
        Flagged candidates (a corpus-cited surgical/specialist indication → pitch) vs whether they internalized to Even IP within {f?.windowDays ?? 90} days
        (EHRC IP bill or surgery case). Advisory; member-level + time-window attribution. Most recent candidates are still inside their window.
      </p>

      {!f ? (
        <div className="mt-6 rounded-xl border border-slate-200 p-4 text-[13px] text-slate-400">Funnel unavailable.</div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Metric label="Flagged" value={String(f.totals.flagged)} />
            <Metric label="Internalized" value={String(f.totals.internalized)} tone="good" />
            <Metric label="Written off" value={String(f.totals.written_off)} tone="bad" />
            <Metric label="Pending" value={String(f.totals.pending)} sub="window open" />
            <Metric label="Conversion" value={f.totals.conversion_pct == null ? '—' : `${f.totals.conversion_pct}%`} sub="of elapsed windows" tone={f.totals.conversion_pct != null && f.totals.conversion_pct >= 50 ? 'good' : 'neutral'} />
          </div>

          {/* by speciality */}
          <h2 className="mt-7 text-[13px] font-medium text-slate-600">By speciality</h2>
          <div className="mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left text-[12.5px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr><th className="px-3 py-2 font-medium">Speciality</th><th className="px-3 py-2 font-medium">Flagged</th><th className="px-3 py-2 font-medium">Internalized</th><th className="px-3 py-2 font-medium">Written off</th><th className="px-3 py-2 font-medium">Pending</th><th className="px-3 py-2 font-medium">Conversion</th></tr>
              </thead>
              <tbody>
                {f.bySpeciality.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No flagged candidates yet.</td></tr>}
                {f.bySpeciality.map((g) => (
                  <tr key={g.speciality} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-700">{g.speciality}</td>
                    <td className="px-3 py-2 text-slate-600">{g.flagged}</td>
                    <td className="px-3 py-2 text-teal-700">{g.internalized}</td>
                    <td className="px-3 py-2 text-red-700">{g.written_off}</td>
                    <td className="px-3 py-2 text-slate-400">{g.pending}</td>
                    <td className="px-3 py-2 text-slate-700">{g.conversion_pct == null ? '—' : `${g.conversion_pct}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* candidate list (internal ids only — no uhid in the UI) */}
          <h2 className="mt-7 text-[13px] font-medium text-slate-600">Flagged candidates</h2>
          <div className="mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left text-[12.5px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr><th className="px-3 py-2 font-medium">Episode</th><th className="px-3 py-2 font-medium">Date</th><th className="px-3 py-2 font-medium">Speciality</th><th className="px-3 py-2 font-medium">Priority</th><th className="px-3 py-2 font-medium">Status</th></tr>
              </thead>
              <tbody>
                {f.candidates.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">No flagged candidates yet.</td></tr>}
                {f.candidates.slice(0, 200).map((c) => (
                  <tr key={c.prescUid} className="border-t border-slate-100">
                    <td className="px-3 py-2"><a href={`/care/${c.prescUid}`} className="font-mono text-[11px] text-teal-700 hover:underline">{c.prescUid.slice(0, 10)}</a></td>
                    <td className="px-3 py-2 text-slate-600">{c.noteDate || '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{c.speciality || '(unknown)'}</td>
                    <td className="px-3 py-2 capitalize text-slate-500">{c.priority || '—'}</td>
                    <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATE_TONE[c.state]}`}>{STATE_LABEL[c.state]}{c.via ? ` · ${c.via === 'ehrc_ip' ? 'EHRC IP' : 'surgery'}` : ''}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
