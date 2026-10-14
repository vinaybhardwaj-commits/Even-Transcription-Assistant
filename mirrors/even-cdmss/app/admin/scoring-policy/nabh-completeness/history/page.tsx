// /admin/scoring-policy/nabh-completeness/history — version history (PRD §5.5).
//
// Reverse-chronological, APPEND-ONLY. "Compare to live" renders a side-by-side tier table with the
// changed rows highlighted; "Restore" does NOT rewrite history — it prefills the editor with the
// old vector so the user publishes a NEW version carrying those weights forward, with the
// prefilled rationale "Restored vN." (editable). That is the whole point of §5.5.
import Link from 'next/link';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { getActivePolicy, listVersions } from '@/lib/scoring-policy/store';
import { PHASE_A_NOTE_TYPES, TIER_LABEL, asTier, diffVectors, fieldsFor, labelFor, weightedKeysFor } from '@/lib/scoring-policy/weights';
import { Locked } from '../../ui';

export const dynamic = 'force-dynamic';

function fmt(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ note_type?: string; compare?: string; locked?: string }> }) {
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) {
    return <Locked configured={adminTokenConfigured()} bad={sp.locked === '1'} next="/admin/scoring-policy/nabh-completeness/history" />;
  }

  const noteType = (PHASE_A_NOTE_TYPES as string[]).includes(String(sp.note_type)) ? String(sp.note_type) : 'discharge_summary';
  const keys = weightedKeysFor(noteType);
  const fields = fieldsFor(noteType).filter((f) => f.weighted);

  const [active, versions] = await Promise.all([getActivePolicy(noteType), listVersions(noteType)]);
  const compareVersion = sp.compare ? Number(sp.compare) : null;
  const comparing = compareVersion == null ? null : versions.find((v) => v.version === compareVersion) ?? null;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <nav className="text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">
            <Link href="/admin/scoring-policy" className="hover:underline">Admin › Scoring policy</Link> ›{' '}
            <Link href={`/admin/scoring-policy/nabh-completeness?note_type=${noteType}`} className="hover:underline">NABH completeness weightage</Link> › History
          </nav>
          <h1 className="mt-0.5 font-serif text-[28px] font-semibold leading-tight text-slate-900 sm:text-[31px]">Version history</h1>
          <p className="mt-1 text-[13.5px] text-slate-500">
            Append-only. Restoring an earlier set publishes it forward as a new version — nothing here is ever rewritten.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {PHASE_A_NOTE_TYPES.map((nt) => (
            <Link
              key={nt}
              href={`/admin/scoring-policy/nabh-completeness/history?note_type=${nt}`}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${nt === noteType ? 'bg-brand text-white' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {nt === 'discharge_summary' ? 'Discharge summary' : 'OPD prescription'}
            </Link>
          ))}
        </div>
      </div>

      {versions.length === 0 ? (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No versions recorded yet. Run migration <code className="font-mono">0026_scoring_policy.sql</code> to seed v1
          (all fields Standard — reproduces the existing scoring exactly).
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {versions.map((v) => {
            const changes = diffVectors(
              versions.find((p) => p.version === (v.supersedes ?? v.version - 1))?.vector ?? null,
              v.vector,
              keys,
            );
            return (
              <div key={v.id || v.version} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="text-[13.5px] font-semibold text-slate-900">
                    v{v.version} · {fmt(v.publishedAt)} · {v.publishedByName ?? 'Unknown'}
                    {v.isActive && <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Live</span>}
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <Link href={`/admin/scoring-policy/nabh-completeness/history?note_type=${noteType}&compare=${v.version}`} className="text-brand hover:underline">Compare to live</Link>
                    {!v.isActive && (
                      <Link href={`/admin/scoring-policy/nabh-completeness?note_type=${noteType}&restore=${v.version}`} className="text-brand hover:underline">Restore</Link>
                    )}
                  </div>
                </div>
                <blockquote className="mt-1.5 border-l-2 border-slate-200 pl-2.5 text-[12.5px] italic text-slate-600">{v.rationale || '—'}</blockquote>
                <div className="mt-1.5 text-[11.5px] text-slate-400">
                  {v.version === 1 ? 'Initial version' : `${changes.length} field${changes.length === 1 ? '' : 's'} changed`}
                  {v.weightsSha256 && <span className="ml-2 font-mono">{v.weightsSha256.slice(0, 12)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {comparing && (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white">
          <div className="flex items-baseline justify-between border-b border-slate-100 px-4 py-3">
            <div className="text-[13px] font-semibold text-slate-800">v{comparing.version} compared to live (v{active.version})</div>
            <Link href={`/admin/scoring-policy/nabh-completeness/history?note_type=${noteType}`} className="text-xs text-slate-400 hover:text-brand">Close</Link>
          </div>
          <table className="w-full text-left text-[12.5px]">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2">Field</th>
                <th className="px-2 py-2">v{comparing.version}</th>
                <th className="px-2 py-2">Live (v{active.version})</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => {
                const a = asTier(comparing.vector[f.key]);
                const b = asTier(active.vector[f.key]);
                const differs = a !== b;
                return (
                  <tr key={f.key} className={`border-t border-slate-100 ${differs ? 'bg-amber-50' : ''}`}>
                    <td className="px-4 py-1.5 text-slate-700">{labelFor(noteType, f.key)}</td>
                    <td className={`px-2 py-1.5 ${differs ? 'font-semibold text-slate-900' : 'text-slate-500'}`}>{TIER_LABEL[a]}</td>
                    <td className={`px-2 py-1.5 ${differs ? 'font-semibold text-slate-900' : 'text-slate-500'}`}>{TIER_LABEL[b]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
