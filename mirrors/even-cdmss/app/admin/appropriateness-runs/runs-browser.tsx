'use client';

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { downloadRunsExcel, type ExportRun } from '@/lib/runs-export';

export type RunRow = ExportRun & { docType: string | null; summary: string; nSources: number; nFindings: number };

const MODE_LABEL: Record<string, string> = { check: 'Order check', pathway: 'Care pathway', audit: 'Record audit' };
const MODE_BADGE: Record<string, string> = { check: 'bg-teal-50 text-teal-800', pathway: 'bg-blue-50 text-blue-800', audit: 'bg-amber-50 text-amber-800' };

export default function RunsBrowser({ runs }: { runs: RunRow[] }) {
  const [filter, setFilter] = useState<'all' | 'check' | 'pathway' | 'audit'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const shown = filter === 'all' ? runs : runs.filter((r) => r.mode === filter);

  async function dl(rows: ExportRun[], name: string, key: string) {
    setBusy(key); setErr(null);
    try { await downloadRunsExcel(rows, name); }
    catch (e) { setErr(`Excel failed: ${(e as Error).message}`); }
    finally { setBusy(null); }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1.5">
          {(['all', 'check', 'pathway', 'audit'] as const).map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)}
              className={`rounded-full px-3 py-1 text-xs ${filter === f ? 'bg-brand text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
              {f === 'all' ? 'All' : MODE_LABEL[f]}
            </button>
          ))}
        </div>
        <button type="button" disabled={!shown.length || !!busy}
          onClick={() => dl(shown, `right-care-runs-${filter}-${shown.length}.xlsx`, 'bulk')}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50">
          {busy === 'bulk' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Export all ({shown.length}) stacked
        </button>
      </div>

      {err && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>}

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">When (UTC)</th>
              <th className="px-3 py-2 font-medium">Mode</th>
              <th className="px-3 py-2 font-medium">Summary</th>
              <th className="px-3 py-2 text-center font-medium">Findings</th>
              <th className="px-3 py-2 text-center font-medium" title="Distinct sources actually cited by this run (not the retrieval pool)">Cited</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 align-top">
                <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">{r.created_at ? r.created_at.replace('T', ' ').replace('Z', '') : '—'}</td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${MODE_BADGE[r.mode]}`}>{MODE_LABEL[r.mode]}</span></td>
                <td className="px-3 py-2 text-[13px] text-slate-700">
                  {r.summary}
                  {r.scenario && <div className="mt-0.5 text-[11px] text-slate-400">{r.scenario.slice(0, 90)}{r.scenario.length > 90 ? '…' : ''}</div>}
                </td>
                <td className="px-3 py-2 text-center text-xs text-slate-600">{r.nFindings}</td>
                <td className="px-3 py-2 text-center text-xs text-slate-600">{r.nSources}</td>
                <td className="px-3 py-2 text-right">
                  <button type="button" disabled={!!busy}
                    onClick={() => dl([r], `right-care-${r.mode}-${r.id.slice(0, 8)}.xlsx`, r.id)}
                    className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                    {busy === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />} Excel
                  </button>
                </td>
              </tr>
            ))}
            {!shown.length && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-slate-400">No runs yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
