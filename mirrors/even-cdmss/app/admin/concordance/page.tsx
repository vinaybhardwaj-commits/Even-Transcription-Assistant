import Link from 'next/link';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { listConcordanceRuns, runAggregates, type RunListRow, type RunAggregates } from '@/lib/concordance-store';
import PageHeader from '@/components/PageHeader';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata = { title: 'Concordance registry · Admin · CAT' };

const VERDICT_LABEL: Record<string, string> = {
  concordant: 'Concordant',
  'discordant-likely-error': 'Discordant · likely error',
  'discordant-likely-real': 'Discordant · likely real',
  indeterminate: 'Indeterminate',
  null: 'Unparsed',
};

function Locked() {
  return (
    <div>
      <PageHeader eyebrow="Concordance registry" title="Registry" />
      <p className="text-sm text-slate-500">Locked. <Link href="/admin/opd-audit" className="text-brand hover:underline">Unlock an admin surface</Link> first.</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <div className="text-[12px] text-slate-500">{label}</div>
      <div className="mt-0.5 text-[22px] font-medium text-slate-900">{value}</div>
    </div>
  );
}

export default async function ConcordanceRegistryPage() {
  if (!(await isAdminUnlocked())) return <Locked />;

  let aggregates: RunAggregates | null = null;
  let runs: RunListRow[] = [];
  let tableMissing = false;
  try {
    [aggregates, runs] = await Promise.all([runAggregates(), listConcordanceRuns(100)]);
  } catch {
    tableMissing = true;
  }

  return (
    <div>
      <PageHeader
        eyebrow="Concordance registry"
        title="Registry"
        subtitle="The de-identified record of every completed check (capture-and-wall). This is the only place runs are visible — the clinical surface has no history. Track-2 calibration only; it does not validate individual verdicts."
      />

      {tableMissing || !aggregates ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-[14px] text-slate-600">
          No registry yet. Run <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[13px]">POST /api/admin/concordance/migrate</code> (admin-token-gated) to create <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[13px]">concordance_runs</code>, then completed checks will appear here.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Total runs" value={aggregates.total} />
            <Metric label="Mean questions" value={aggregates.meanQuestions} />
            <Metric label="Unknown rate" value={`${Math.round(aggregates.unknownRate * 100)}%`} />
            <Metric label="Analytes seen" value={Object.keys(aggregates.byAnalyte).length} />
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="mb-2 text-[13px] font-medium text-slate-700">Verdict mix</div>
              {Object.keys(aggregates.byVerdict).length === 0 ? <p className="text-[13px] text-slate-400">No runs yet.</p> : (
                Object.entries(aggregates.byVerdict).sort((a, b) => b[1] - a[1]).map(([v, n]) => {
                  const pct = aggregates!.total ? Math.round((n / aggregates!.total) * 100) : 0;
                  return (
                    <div key={v} className="mb-2 flex items-center gap-2">
                      <span className="w-44 shrink-0 text-[12px] text-slate-600">{VERDICT_LABEL[v] ?? v}</span>
                      <div className="h-2 flex-1 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-brand" style={{ width: `${pct}%` }} /></div>
                      <span className="w-10 text-right text-[12px] text-slate-500">{n}</span>
                    </div>
                  );
                })
              )}
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="mb-2 text-[13px] font-medium text-slate-700">By analyte</div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(aggregates.byAnalyte).sort((a, b) => b[1] - a[1]).map(([a, n]) => (
                  <span key={a} className="rounded-full bg-slate-100 px-2.5 py-1 text-[12px] text-slate-600">{a} · {n}</span>
                ))}
                {Object.keys(aggregates.byAnalyte).length === 0 && <p className="text-[13px] text-slate-400">No runs yet.</p>}
              </div>
            </div>
          </div>

          <div className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-4 py-2.5 text-[13px] font-medium text-slate-700">Recent runs ({runs.length})</div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    {['When', 'Analytes', 'Mode', 'Verdict', 'Conf', 'Q', 'Gaps', 'Age', 'Sex', 'Engine'].map((h) => (
                      <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {runs.length === 0 ? (
                    <tr><td colSpan={10} className="px-3 py-4 text-slate-400">No runs recorded yet.</td></tr>
                  ) : runs.map((r) => (
                    <tr key={r.id} className="border-t border-slate-50">
                      <td className="whitespace-nowrap px-3 py-2 text-slate-500">{new Date(r.created_at).toLocaleString()}</td>
                      <td className="px-3 py-2">{(r.analytes ?? []).join(', ') || '—'}</td>
                      <td className="px-3 py-2 text-slate-500">{r.mode}</td>
                      <td className="px-3 py-2">{VERDICT_LABEL[r.verdict ?? 'null'] ?? r.verdict}</td>
                      <td className="px-3 py-2 text-slate-500">{r.confidence ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-500">{r.asked_count}</td>
                      <td className="px-3 py-2 text-slate-500">{r.unknown_count}</td>
                      <td className="px-3 py-2 text-slate-500">{r.age_band ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-500">{r.sex ?? '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-400">{r.engine}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="mt-3 text-[11.5px] text-slate-400">De-identified feature vectors only — no names, no identifiers, no per-patient key. Population base rates and interview economy; never per-case validation.</p>
        </>
      )}
    </div>
  );
}
