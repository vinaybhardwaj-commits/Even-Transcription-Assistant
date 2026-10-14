// app/admin/observability/ledger-ui.tsx — shared render primitives for the Adjudication Ledger (#3)
// two-page surface (the finding-family ledger + the Reconstruction Fidelity page). Colocated module,
// NOT a route (no page/layout export). No federation logic here — pure presentation.
import Link from 'next/link';
import type { LedgerRow } from '@/lib/adjudication-ledger';

export const FAMILY_TONE: Record<string, string> = {
  TP: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  ValidExtra: 'bg-teal-50 text-teal-700 border-teal-200',
  False: 'bg-red-50 text-red-700 border-red-200',
  Nitpick: 'bg-slate-100 text-slate-600 border-slate-200',
  Contested: 'bg-violet-50 text-violet-700 border-violet-200',
  Faithful: 'bg-sky-50 text-sky-700 border-sky-200',
  MissedMaterial: 'bg-amber-50 text-amber-800 border-amber-200',
  MisPhased: 'bg-orange-50 text-orange-700 border-orange-200',
  OverIncluded: 'bg-rose-50 text-rose-700 border-rose-200',
};

export function Verdict({ v }: { v: string }) {
  return <span className={`whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium ${FAMILY_TONE[v] ?? 'bg-slate-50 text-slate-600 border-slate-200'}`}>{v}</span>;
}

export const pct = (x: number | null) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`);

export function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3">
      <div className="mb-2"><span className="text-[13px] font-semibold text-slate-800">{title}</span>{hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}</div>
      {children}
    </div>
  );
}

export const Empty = () => <div className="py-3 text-[12px] italic text-slate-400">No adjudications in this view.</div>;

export function Sel({ name, label, value, options }: { name: string; label: string; value?: string; options: string[] }) {
  return (
    <label className="flex flex-col text-[10.5px] text-slate-500">{label}
      <select name={name} defaultValue={value ?? ''} className="mt-0.5 h-7 rounded-md border border-slate-200 bg-white px-2 text-[12px]">
        <option value="">all</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

/** The shared browse table — same columns for finding + fidelity rows. Each row links back to its
 *  source surface. "Who" is a per-row display field, never aggregated. */
export function BrowseTable({ rows, cap = 300 }: { rows: LedgerRow[]; cap?: number }) {
  if (rows.length === 0) return <Empty />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead><tr className="text-left text-[10.5px] uppercase tracking-wide text-slate-400"><th className="py-1 pr-3">When</th><th className="pr-3">Surface</th><th className="pr-3">Finding / fact</th><th className="pr-3">Human call</th><th className="pr-3">Who</th><th className="pr-3">Source</th></tr></thead>
        <tbody>
          {rows.slice(0, cap).map((r, i) => (
            <tr key={i} className="border-t border-slate-100 align-top hover:bg-slate-50/60">
              <td className="py-1.5 pr-3 whitespace-nowrap font-mono text-[11px] text-slate-400">{r.adjudicated_at.slice(0, 16).replace('T', ' ')}</td>
              <td className="pr-3 text-slate-600">{r.surface}<div className="font-mono text-[10px] text-slate-400">{r.engine_version}</div></td>
              <td className="max-w-[24rem] pr-3 text-slate-700">{r.finding_subject || <span className="text-slate-400">—</span>}{r.note ? <div className="text-[10.5px] italic text-slate-400">“{r.note.slice(0, 120)}”</div> : null}</td>
              <td className="pr-3"><Verdict v={r.canonical_verdict} /></td>
              <td className="pr-3 text-[11px] text-slate-500">{r.reviewer || <span className="text-slate-300">anon</span>}</td>
              <td className="pr-3"><Link href={r.link} className="whitespace-nowrap text-brand hover:underline">open ↗</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > cap && <p className="mt-2 text-[11px] text-slate-400">Showing the newest {cap} of {rows.length} — narrow with the filters above.</p>}
    </div>
  );
}
