'use client';
/**
 * The lab-packages table + CSV round-trip controls (§7.3).
 *
 * Client component because it owns a file input, a diff preview and a publish call — the same
 * server/client split the weightage screen uses.
 *
 * REMOVALS ARE LISTED PROMINENTLY. Deleting a package silently re-enables duplication flagging for
 * it, which is the exact failure mode that brought Dr. Binita here — so a removal is rendered in
 * danger colour, first, and never collapsed behind a summary count.
 */
import { useState } from 'react';
import type { LabPackage, PackageDiff } from '@/lib/scoring-policy/lab-packages-csv';
// §12.4 + decision 17 — required, and typed fresh every time. There is no prefill by design.
import { isValidAttribution, ATTRIBUTION_LABEL, ATTRIBUTION_HELP } from '@/lib/admin-attribution';

export default function LabPackagesEditor({ packages, count }: { packages: LabPackage[]; count: number }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [filename, setFilename] = useState<string>('');
  const [diff, setDiff] = useState<PackageDiff | null>(null);
  const [nextCount, setNextCount] = useState<number>(0);
  const [noChange, setNoChange] = useState(false);
  const [rationale, setRationale] = useState('');
  // ⚠️ STARTS EMPTY, ALWAYS (decision 17). No storage, no default — a remembered name would offer
  // the LAST person's name to the NEXT one, and a wrong name is worse than no name.
  const [changedBy, setChangedBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const reset = () => { setCsv(null); setFilename(''); setDiff(null); setNoChange(false); setRationale(''); setError(null); };

  const onFile = async (file: File | null) => {
    reset();
    if (!file) return;
    setFilename(file.name);
    const text = await file.text();
    setCsv(text);
    setBusy(true);
    try {
      const res = await fetch('/api/scoring-policy/lab-packages/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csv: text, filename: file.name }),
      });
      const json = (await res.json()) as { ok?: boolean; diff?: PackageDiff; count?: number; error?: string };
      if (!res.ok || !json.ok) { setError(json.error ?? 'Could not read that file.'); setCsv(null); return; }
      setDiff(json.diff ?? null);
      setNextCount(json.count ?? 0);
      setNoChange(!!json.diff?.isEmpty);
    } catch {
      setError('Could not read that file.'); setCsv(null);
    } finally { setBusy(false); }
  };

  const publish = async () => {
    if (!csv) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/scoring-policy/lab-packages/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csv, filename, publish: true, rationale, published_by_name: changedBy.trim() }),
      });
      const json = (await res.json()) as { ok?: boolean; noChange?: boolean; toast?: string; message?: string; error?: string };
      if (!res.ok || !json.ok) { setError(json.error ?? 'Publish failed.'); return; }
      setToast(json.toast ?? json.message ?? 'Done');
      setTimeout(() => location.reload(), 900);
    } catch {
      setError('Publish failed — nothing was changed.');
    } finally { setBusy(false); }
  };

  const canPublish = !!diff && !diff.isEmpty && rationale.trim().length >= 10 && isValidAttribution(changedBy) && !busy;

  return (
    <div className="mt-5">
      {/* ── actions ── */}
      <div className="flex flex-wrap items-center gap-2">
        <a
          href="/api/scoring-policy/lab-packages/export"
          className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white"
        >
          Download CSV
        </a>
        <label className="cursor-pointer rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
          Upload CSV
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void onFile(e.target.files?.[0] ?? null)} />
        </label>
        {filename && <span className="text-[11.5px] text-slate-400">{filename}</span>}
        {busy && <span className="animate-pulse text-[11.5px] text-slate-400">working…</span>}
        {(csv || error) && <button onClick={reset} className="text-[11.5px] text-slate-400 hover:text-brand">Cancel</button>}
      </div>
      <p className="mt-1.5 text-[11.5px] text-slate-400">
        Columns: <code className="font-mono">package,aliases,contains</code>. Aliases and constituent tests are
        separated by semicolons inside the quoted field, because commas separate the columns.
      </p>

      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{error}</p>}

      {noChange && (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">
          This file is identical to the live set. Nothing will be published and no version will be created.
        </p>
      )}

      {/* ── diff preview ── */}
      {diff && !diff.isEmpty && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-[13px] font-semibold text-slate-900">
            {diff.added.length} added · <span className={diff.removed.length ? 'text-red-700' : ''}>{diff.removed.length} removed</span> · {diff.changed.length} changed
            <span className="ml-2 text-[11.5px] font-normal text-slate-400">{count} → {nextCount} packages</span>
          </div>

          {/* REMOVALS FIRST, AND LOUD. */}
          {diff.removed.length > 0 && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
              <div className="text-[12.5px] font-semibold text-red-800">
                Removing {diff.removed.length} package{diff.removed.length === 1 ? '' : 's'}
              </div>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-red-700">
                Once a package is removed the audit no longer knows what it contains, so ordering it alongside one of
                its own tests will be flagged as a duplicate again.
              </p>
              <ul className="mt-1.5 list-disc pl-5 text-[12.5px] text-red-900">
                {diff.removed.map((p) => <li key={p}>{p}</li>)}
              </ul>
            </div>
          )}

          {diff.added.length > 0 && (
            <div className="mt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Added</div>
              <ul className="mt-1 list-disc pl-5 text-[12.5px] text-slate-700">{diff.added.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}

          {diff.changed.length > 0 && (
            <div className="mt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Changed</div>
              <ul className="mt-1 space-y-1.5">
                {diff.changed.map((c) => (
                  <li key={c.package} className="text-[12.5px]">
                    <span className="font-medium text-slate-800">{c.package}</span>
                    {c.containsAdded.length > 0 && <div className="pl-3 text-emerald-700">+ {c.containsAdded.join(', ')}</div>}
                    {c.containsRemoved.length > 0 && <div className="pl-3 text-red-700">− {c.containsRemoved.join(', ')}</div>}
                    {c.aliasesAdded.length > 0 && <div className="pl-3 text-slate-500">+ alias: {c.aliasesAdded.join(', ')}</div>}
                    {c.aliasesRemoved.length > 0 && <div className="pl-3 text-slate-500">− alias: {c.aliasesRemoved.join(', ')}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <label className="mt-4 block">
            <span className="text-[12.5px] font-semibold text-slate-800">Why are you making this change?</span>
            <textarea
              value={rationale} onChange={(e) => setRationale(e.target.value)} rows={2}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px]"
              placeholder="Kept with the version, permanently."
            />
            <span className="text-[11px] text-slate-400">{rationale.trim().length}/10 characters minimum</span>
          </label>

          <label className="mt-4 block">
            <span className="text-[12.5px] font-semibold text-slate-800">{ATTRIBUTION_LABEL}</span>
            <input
              value={changedBy} onChange={(e) => setChangedBy(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px]"
              placeholder="Dr Binita Priyambada"
            />
            <span className="text-[11px] text-slate-400">{ATTRIBUTION_HELP}</span>
          </label>

          <button
            onClick={publish} disabled={!canPublish}
            className="mt-2 rounded-lg bg-brand px-4 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
          >
            {busy ? 'Publishing…' : 'Publish new version'}
          </button>
        </div>
      )}

      {/* ── current set ── */}
      <div className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-3 text-[13px] font-semibold text-slate-800">
          Current packages <span className="font-normal text-slate-400">· {count}</span>
        </div>
        {packages.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-slate-500">Nothing loaded yet.</div>
        ) : (
          <table className="w-full text-left text-[12.5px]">
            <thead><tr className="text-[11px] uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2">Package</th><th className="px-2 py-2">Aliases</th><th className="px-2 py-2">Tests</th>
            </tr></thead>
            <tbody>
              {packages.map((p) => (
                <tr key={p.package} className="border-t border-slate-100">
                  <td className="px-4 py-2 text-slate-800">{p.package}</td>
                  <td className="px-2 py-2 text-slate-500">{p.aliases?.length ? p.aliases.join(', ') : <span className="text-slate-300">—</span>}</td>
                  <td className="px-2 py-2 tabular-nums text-slate-600" title={p.contains.join(', ')}>{p.contains.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-lg">{toast}</div>
      )}
    </div>
  );
}
