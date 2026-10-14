'use client';
import { useState, useMemo } from 'react';
import Link from 'next/link';
import { bandColor, scoreColor } from '@/lib/opd-audit-ui';
import { CATS, CAT_DEF, type CatSev } from '@/lib/opd-audit-cats';
import { frequentFlierCmp, SORT_NEXT, SORT_LABEL, type SortMode } from '@/lib/opd-audit-context-sort';

export type AuditRow = {
  id: string; time: string; doctor: string; consult: string; uid: string;
  band: string; index: number; lowVal: number; issue: string; cats: string[];
  doctorUid: string | null;
  context?: string | null;   // Stage 3 (D5c) — established | thin | none | null (no longitudinal block)
  encounters?: number | null;   // 0.81.8 Part C — prior encounters (from the longitudinal block)
  longFindings?: number | null; // 0.81.8 Part C — longitudinal findings on this note
  /** Phase C §7.1 — joined from db13 at read time. 'unknown' is a real answer, not a gap. */
  investigations?: 'ordered' | 'none' | 'unknown';
};

// 0.81.8 Part C — the frequent-flier sort + its 3-state cycle live in the pure lib/opd-audit-context-sort
// (so the comparator is unit-tested); the table just consumes them. Default sort unchanged (worst first).

// Advisory (slate/indigo) context indicator — deliberately NOT the scored-band palette.
const CONTEXT_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  established: { label: 'established', color: '#4b57a6', bg: '#f4f5fb' },
  thin: { label: 'thin', color: '#8a6d3b', bg: '#fdf9ef' },
  none: { label: 'none', color: '#94a3b8', bg: '#f4f5f7' },
};

const BANDS = ['A', 'B', 'C', 'D', 'E'];
const SEV_COLOR: Record<CatSev, string> = { doc: '#d97706', caution: '#b45309', low: '#dc2626' };
const BULK_CAP = 50;

// Download a bulk "note + audit" PDF for an explicit id set (honours the active filter). POSTs the
// ids so any client filter (doctor / band / category / search) is respected, not just ?doctor=.
async function downloadBulk(ids: string[], setBusy: (b: boolean) => void, setErr: (s: string) => void) {
  if (ids.length === 0) return;
  if (ids.length > BULK_CAP) { setErr(`${ids.length} notes selected — the PDF cap is ${BULK_CAP}. Narrow the filter.`); return; }
  setBusy(true); setErr('');
  try {
    const res = await fetch('/api/opd-audit/export-pdf', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); setErr(j.error || `status ${res.status}`); setBusy(false); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `opd-audits-${ids.length}-notes.pdf`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  } catch (e) {
    setErr(String((e as Error).message));
  }
  setBusy(false);
}

// Top-issues panel (categorised, clickable) merged with the searchable all-notes table.
// Clicking an issue filters the table; search + band + doctor + sort stack on top. All client-side
// over the rows the server already fetched (≤600), so it's instant.
export default function NotesExplorer({ rows, initialDoctorUid, triagedIds, investigationsUnavailable }: {
  rows: AuditRow[]; initialDoctorUid?: string; triagedIds?: string[];
  /** §7.1 fail-soft: db13 unreachable ⇒ the control disables itself and the list renders unfiltered. */
  investigationsUnavailable?: boolean;
}) {
  const triaged = useMemo(() => new Set(triagedIds || []), [triagedIds]);
  const [q, setQ] = useState('');
  const [band, setBand] = useState('');
  const [cat, setCat] = useState('');
  const [docUid, setDocUid] = useState(initialDoctorUid || '');
  const [sort, setSort] = useState<SortMode>('index');   // default unchanged (worst first)
  const [inv, setInv] = useState<'all' | 'ordered' | 'none'>('all');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const tally = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) for (const c of r.cats) m.set(c, (m.get(c) || 0) + 1);
    return m;
  }, [rows]);
  const issues = useMemo(() => CATS.map((c) => ({ ...c, n: tally.get(c.key) || 0 })).filter((c) => c.n > 0), [tally]);
  const docIssues = issues.filter((i) => i.group === 'documentation').sort((a, b) => b.n - a.n);
  const rxIssues = issues.filter((i) => i.group === 'prescribing').sort((a, b) => b.n - a.n);
  const total = rows.length || 1;
  const docName = useMemo(() => (docUid ? (rows.find((r) => r.doctorUid === docUid)?.doctor || 'this doctor') : ''), [rows, docUid]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let r = rows;
    if (docUid) r = r.filter((x) => x.doctorUid === docUid);
    if (cat) r = r.filter((x) => x.cats.includes(cat));
    if (band) r = r.filter((x) => x.band === band);
    // §7.1/§8.11 — 'unknown' (num_investigations NULL, ~half the corpus) matches NEITHER option.
    // Never coerced to zero: that would assert half the corpus ordered nothing.
    if (inv !== 'all') r = r.filter((x) => (x.investigations ?? 'unknown') === inv);
    if (needle) r = r.filter((x) => `${x.doctor} ${x.consult} ${x.issue} ${x.uid} ${x.band}`.toLowerCase().includes(needle));
    return [...r].sort((a, b) => (
      sort === 'index' ? a.index - b.index
      : sort === 'time' ? b.time.localeCompare(a.time)
      : frequentFlierCmp(a, b)));
  }, [rows, q, band, cat, docUid, sort, inv]);

  type Issue = (typeof issues)[number];
  const IssueRow = ({ i }: { i: Issue }) => {
    const on = cat === i.key;
    const pct = Math.round((i.n / total) * 100);
    return (
      <button onClick={() => setCat(on ? '' : i.key)}
        className={`flex w-full items-center gap-3 px-3.5 py-2 text-left transition ${on ? 'bg-brand-faint' : 'hover:bg-[#faf7f2]'}`}>
        <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: SEV_COLOR[i.sev] }} />
        <span className="flex-1 text-[12.5px] text-slate-700">{i.label}</span>
        <span className="flex w-[150px] shrink-0 items-center gap-2">
          <span className="h-[5px] flex-1 rounded bg-slate-100"><span className="block h-full rounded" style={{ width: `${pct}%`, background: SEV_COLOR[i.sev] }} /></span>
          <span className="w-[60px] text-right text-[11.5px] font-medium text-slate-700">{i.n} · {pct}%</span>
        </span>
        <span className={`text-[13px] ${on ? 'text-brand' : 'text-slate-300'}`}>{on ? '✕' : '›'}</span>
      </button>
    );
  };

  return (
    <div className="space-y-3">
      {/* TOP ISSUES */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-2.5">
          <div className="font-serif text-[15px] font-semibold text-slate-900">Top issues</div>
          <div className="text-[11px] text-slate-400">The most common gaps across all {rows.length} notes — click any to filter the list below.</div>
        </div>
        {docIssues.length > 0 && <div className="px-3.5 pt-2 text-[11px] font-medium text-slate-500">Documentation</div>}
        {docIssues.map((i) => <IssueRow key={i.key} i={i} />)}
        {rxIssues.length > 0 && <div className="border-t border-slate-100 px-3.5 pb-1 pt-2.5 text-[11px] font-medium text-slate-500">Prescribing &amp; appropriateness</div>}
        {rxIssues.map((i) => <IssueRow key={i.key} i={i} />)}
        {issues.length === 0 && <div className="px-4 py-5 text-center text-[12px] text-slate-400">No issues flagged in this window.</div>}
      </div>

      {/* NOTES */}
      <div id="notes" className="overflow-hidden rounded-xl border border-slate-200 bg-white scroll-mt-4">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2.5">
          <span className="font-serif text-[14px] font-semibold text-slate-900">All notes</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search doctor, diagnosis, drug, uid…"
            className="w-60 max-w-full rounded-lg border border-slate-200 px-2.5 py-1 text-[12px] text-slate-700 outline-none focus:border-brand" />
          <span className="flex overflow-hidden rounded-lg border border-slate-200 text-[11px]">
            <button onClick={() => setBand('')} className={`px-2 py-1 ${band === '' ? 'bg-brand text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>All</button>
            {BANDS.map((b) => (
              <button key={b} onClick={() => setBand(band === b ? '' : b)} className={`px-2 py-1 ${band === b ? 'text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`} style={band === b ? { background: bandColor(b) } : undefined}>{b}</button>
            ))}
          </span>
          <button onClick={() => setSort(SORT_NEXT[sort])} className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] text-slate-500 hover:text-brand" title="Cycle: worst first → newest → frequent flier (longitudinal context)">sort: {SORT_LABEL[sort]}</button>
          {/* Investigations filter (§7.1). Disabled — not hidden — when db13 is unreachable, so the
              absence is visible rather than silently changing what the list means. */}
          <select
            value={inv}
            onChange={(e) => setInv(e.target.value as 'all' | 'ordered' | 'none')}
            disabled={investigationsUnavailable}
            title={investigationsUnavailable ? 'Temporarily unavailable' : 'Notes where investigations were ordered. Notes with no recorded value stay out of both filtered views.'}
            className={`rounded-lg border px-2 py-1 text-[11px] ${investigationsUnavailable ? 'border-slate-200 bg-slate-50 text-slate-300' : 'border-slate-200 text-slate-500'}`}
          >
            <option value="all">Investigations: all</option>
            <option value="ordered">Investigations ordered</option>
            <option value="none">None ordered</option>
          </select>
          {investigationsUnavailable && <span className="text-[11px] text-amber-600">Temporarily unavailable</span>}
          {cat && <button onClick={() => setCat('')} className="rounded-lg bg-brand-faint px-2 py-1 text-[11px] font-medium text-brand">✕ {CAT_DEF[cat]?.label}</button>}
          {docUid && <button onClick={() => setDocUid('')} className="rounded-lg bg-brand-faint px-2 py-1 text-[11px] font-medium text-brand">Filtered to {docName} · clear ✕</button>}
          <button onClick={() => downloadBulk(filtered.map((r) => r.id), setBusy, setErr)} disabled={busy || filtered.length === 0}
            className={`rounded-lg border px-2 py-1 text-[11px] font-medium ${busy || filtered.length === 0 ? 'border-slate-200 text-slate-400' : 'border-brand/40 text-brand hover:bg-brand-faint'}`}>
            {busy ? 'Building…' : `↓ Download all (${filtered.length}) as PDF`}
          </button>
          <span className="ml-auto text-[11px] text-slate-400">{filtered.length} of {rows.length}</span>
        </div>
        {err && <div className="border-b border-slate-100 bg-red-50/50 px-3 py-1.5 text-[11px] text-red-600">{err}</div>}
        <div className="max-h-[520px] overflow-y-auto">
          <table className="w-full text-[11.5px]">
            <thead className="sticky top-0 z-10 bg-white text-[10px] text-slate-400 shadow-[0_1px_0_#f1efe9]">
              <tr>
                <th className="px-3 py-1.5 text-left font-normal">time</th>
                <th className="px-2 py-1.5 text-left font-normal">doctor</th>
                <th className="px-2 py-1.5 text-left font-normal">type</th>
                <th className="px-2 py-1.5 text-center font-normal">band</th>
                <th className="px-2 py-1.5 text-right font-normal">index</th>
                <th className="px-3 py-1.5 text-left font-normal">top issue</th>
                <th className="px-2 py-1.5 text-center font-normal">context</th>
                <th className="px-2 py-1.5 text-right font-normal">pdf</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-t border-slate-50 hover:bg-slate-50"
                  style={r.context && CONTEXT_STYLE[r.context] ? { borderLeft: `3px solid ${CONTEXT_STYLE[r.context].color}` } : undefined}>
                  <td className="whitespace-nowrap px-3 py-1.5 text-slate-500"><Link href={`/admin/opd-audit/${r.id}`} className="hover:text-brand">{r.time}</Link></td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-slate-700">
                    {r.doctorUid
                      ? <button onClick={() => setDocUid(r.doctorUid!)} className="text-left hover:text-brand hover:underline" title="Filter to this doctor">{r.doctor}</button>
                      : <span>{r.doctor}</span>}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-slate-400">{r.consult}</td>
                  <td className="px-2 py-1.5 text-center"><span className="rounded px-1.5 py-0.5 text-[10px] font-medium text-white" style={{ background: bandColor(r.band) }}>{r.band}</span></td>
                  <td className="px-2 py-1.5 text-right font-medium" style={{ color: scoreColor(r.index) }}>{r.index}</td>
                  <td className="px-3 py-1.5"><Link href={`/admin/opd-audit/${r.id}`} className="text-slate-600 hover:text-brand hover:underline">{r.issue}</Link>{triaged.has(r.id) && <span className="ml-1 text-emerald-600" title="has your triage">✓</span>}</td>
                  <td className="px-2 py-1.5 text-center">
                    {r.context && CONTEXT_STYLE[r.context]
                      ? <span className="inline-flex flex-col items-center gap-0.5" title="Longitudinal context depth + frequent-flier signal (informational)">
                          <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ color: CONTEXT_STYLE[r.context].color, background: CONTEXT_STYLE[r.context].bg }}>{CONTEXT_STYLE[r.context].label}</span>
                          <span className="text-[9px] text-slate-400">{r.encounters || 0} prior{r.longFindings ? ` · ${r.longFindings} find` : ''}</span>
                        </span>
                      : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right"><a href={`/api/opd-audit/export-pdf?id=${r.id}`} className="text-slate-400 hover:text-brand" title="Download note + audit PDF">↓</a></td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-[12px] text-slate-400">No notes match.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
