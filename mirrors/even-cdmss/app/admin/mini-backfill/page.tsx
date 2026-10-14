import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { readState } from '@/lib/mini-backfill';
import { opdMiniEngine } from '@/lib/opd-note-audit';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';
import MiniBackfillControls from './controls';
import MiniBackfillMonitor from './monitor';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Mini backfill · Admin' };

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const n = (v: unknown): number => Number(v ?? 0);

function Locked() {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">Mini backfill</h1>
      <p className="mt-1.5 text-sm text-slate-500">Locked. <Link href="/admin/opd-audit" className="text-brand hover:underline">Unlock an admin surface</Link> first.</p>
    </div>
  );
}

export default async function MiniBackfillAdmin() {
  if (!(await isAdminUnlocked())) { adminTokenConfigured(); return <Locked />; }

  const st = await readState();
  const engineStr = opdMiniEngine(st.tag);

  const [byEngine, tableSize] = await Promise.all([
    run(`SELECT engine_version, count(*)::int AS rows,
                round(avg(pg_column_size(t.*)))::int AS avg_bytes,
                pg_size_pretty(sum(pg_column_size(t.*))::bigint) AS size
         FROM opd_note_audits t GROUP BY 1 ORDER BY count(*) DESC`, []).catch(() => []),
    run(`SELECT pg_size_pretty(pg_total_relation_size('opd_note_audits')) AS total`, []).catch(() => []),
  ]);

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">Free Mac-mini compute</div>
      <h1 className="font-serif text-[28px] font-semibold leading-tight text-slate-900">Free Mac-mini compute</h1>
      <p className="mt-1 max-w-2xl text-[13.5px] leading-relaxed text-slate-500">
        One free Mac-mini (qwen, &#8377;0) runs two workloads: the <strong>history re-score</strong> — re-auditing past OPD notes to the current engine, backward through time — and <strong>eval batches</strong> — bounded model-comparison / bridge runs. A bounded eval batch <strong>preempts</strong> the re-score and hands the mini back when it finishes. Which one holds the mini right now is shown at the top of the monitor.
      </p>

      {/* history re-score controls — start/pause + window + progress; advanced re-audit tucked away */}
      <div className="mt-5 mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-slate-500">History re-score · controls</div>
      <div><MiniBackfillControls state={{ enabled: st.enabled, window: st.window, cursor: st.cursor, floor: st.floor, tag: st.tag, n: st.n }} /></div>

      {/* live monitoring — continuous throughput line + state timeline + live feed */}
      <MiniBackfillMonitor />

      {/* storage — answers "would they take up too much space" with live numbers */}
      <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex items-baseline justify-between border-b border-slate-100 px-4 py-2.5">
          <span className="font-serif text-[14px] font-semibold text-slate-900">Storage · opd_note_audits</span>
          <span className="text-[11px] text-slate-400">table total {String(tableSize[0]?.total ?? '—')} (incl. indexes)</span>
        </div>
        <table className="w-full text-[11.5px]">
          <thead className="text-[10px] text-slate-400"><tr><th className="px-4 py-1.5 text-left font-normal">engine / generation</th><th className="px-2 py-1.5 text-right font-normal">rows</th><th className="px-2 py-1.5 text-right font-normal">avg row</th><th className="px-4 py-1.5 text-right font-normal">data size</th></tr></thead>
          <tbody>
            {byEngine.map((r) => (
              <tr key={String(r.engine_version)} className="border-t border-slate-50">
                <td className="px-4 py-1.5 text-slate-700">{String(r.engine_version)}{String(r.engine_version) === OPD_ENGINE_VERSION && <span className="ml-1.5 rounded bg-teal-50 px-1 py-0.5 text-[9px] font-semibold text-teal-700">prod</span>}{String(r.engine_version) === engineStr && <span className="ml-1.5 rounded bg-indigo-50 px-1 py-0.5 text-[9px] font-semibold text-indigo-700">current run</span>}</td>
                <td className="px-2 py-1.5 text-right text-slate-600">{n(r.rows).toLocaleString('en-IN')}</td>
                <td className="px-2 py-1.5 text-right text-slate-500">{(n(r.avg_bytes) / 1024).toFixed(1)} KB</td>
                <td className="px-4 py-1.5 text-right text-slate-600">{String(r.size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-t border-slate-100 px-4 py-2 text-[10.5px] text-slate-400">
          Rule of thumb from the live avg: a full 235k-note generation ≈ 235,260 × avg row. Superseded experimental generations can be dropped by engine tag when no longer needed.
        </div>
      </div>

      <p className="mt-4 text-[11px] text-slate-400">
        Nightly capacity at ~61s/note: the 00:00–05:00 IST window ≈ 240–290 notes/night; &quot;anytime&quot; mode uses every 5-min tick.
        Manual probe stays available: <code className="rounded bg-slate-100 px-1">/api/admin/opd-audit-mini-backfill?day=YYYY-MM-DD&amp;n=1</code>.
        Advisory research artifacts — mini rows never feed dashboards, stewardship, governance signals, or the learning loop.
      </p>
    </div>
  );
}
