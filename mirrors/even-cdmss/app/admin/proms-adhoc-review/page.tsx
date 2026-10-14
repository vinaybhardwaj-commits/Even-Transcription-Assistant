'use client';

// PROMs Tier-3 adhoc review queue (admin) — per the normative CDMSS-PROMS-0.2b-2-MOCKUP-REVIEW-QUEUE.
// Reads /api/admin/proms-adhoc-review (admin + TIER3_ENABLED gated server-side). Frozen adhoc sets grouped
// by procedure with a promotion-candidate (recurring selection ≥ threshold) vs collecting verdict.
// "Promote" PROPOSES a named set to V for ratification (a proposal row — never a live hs-sets change);
// "Dismiss" closes the candidate. Nothing here mutates a live series.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';

interface Candidate {
  procedureKey: string; procedureLabel: string; totalSets: number; distinctCms: number;
  dominantSelection: string[]; recurrenceCount: number; editedCount: number;
  status: 'candidate' | 'collecting'; suggestedName: string; decision: string | null;
}
interface QueueResp { ok: boolean; threshold: number; candidates: Candidate[] }

export default function AdhocReviewPage() {
  const [data, setData] = useState<QueueResp | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'off' | 'error'>('loading');
  const [busy, setBusy] = useState<string>('');

  const load = useCallback(() => {
    setState('loading');
    fetch('/api/admin/proms-adhoc-review')
      .then(async (r) => (r.status === 404 ? { __off: true } : r.ok ? r.json() : { __err: true }))
      .then((j: QueueResp & { __off?: boolean; __err?: boolean }) => {
        if (j?.__off) setState('off');
        else if (j?.ok) { setData(j); setState('ready'); }
        else setState('error');
      })
      .catch(() => setState('error'));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function act(c: Candidate, action: 'promote' | 'dismiss') {
    setBusy(`${action}:${c.procedureKey}`);
    try {
      await fetch('/api/admin/proms-adhoc-review', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, procedure_key: c.procedureKey, proposed_name: c.suggestedName, item_ids: c.dominantSelection, recurrence_count: c.recurrenceCount }),
      });
      load();
    } catch { /* soft */ }
    setBusy('');
  }

  const threshold = data?.threshold ?? 5;

  return (
    <div className="mx-auto max-w-[900px] px-4 py-8">
      <div className="mb-1 text-[12.5px] text-slate-400">Admin › PROMs › <b className="text-slate-600">Tier-3 adhoc review queue</b></div>
      <h1 className="text-[19px] font-bold text-slate-800">Adhoc set review queue</h1>
      <p className="mb-4 text-[13px] text-slate-500">Tailored sets generated for unmapped procedures. Recurring selections graduate into named house sets.</p>

      <div className="mb-5 rounded-lg border border-purple-200 bg-purple-50 px-4 py-3 text-[13px] text-purple-900/80">
        <b className="text-purple-800">The harvest loop.</b> When the same selection recurs for a procedure across members, it’s a candidate to become a permanent, named house set — promoting it from <b>adhoc</b> (within-hospital, never pooled) to a ratified instrument that trends across patients. Promotion is <b>V-ratified</b> and lands in <b>hs-sets/0.3</b>.
      </div>

      {state === 'loading' && <div className="flex items-center gap-2 py-6 text-[13px] text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading queue…</div>}
      {state === 'off' && <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-[13px] text-slate-500">Tier-3 is off (TIER3_ENABLED unset). The queue activates once the flag is on.</div>}
      {state === 'error' && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-600">Could not load the queue (admin session required).</div>}

      {state === 'ready' && (
        <>
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-slate-400">Candidates · by procedure</h2>
          {!data?.candidates.length && <div className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-[13px] text-slate-400">No frozen adhoc sets yet — candidates appear once tailored sets are administered.</div>}

          {data?.candidates.map((c) => {
            const ready = c.status === 'candidate';
            const width = Math.min(100, Math.round((c.recurrenceCount / threshold) * 100));
            return (
              <div key={c.procedureKey} className="mb-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3">
                  <div>
                    <div className="text-[15px] font-bold text-slate-800">{c.procedureLabel}</div>
                    <div className="text-[12px] text-slate-400">unmapped family · {c.totalSets} set{c.totalSets === 1 ? '' : 's'} seen</div>
                  </div>
                  <span className={`ml-auto rounded-full px-2.5 py-0.5 text-[11px] font-bold ${ready ? 'border border-emerald-200 bg-emerald-50 text-emerald-700' : 'border border-purple-200 bg-purple-50 text-purple-700'}`}>
                    {ready ? 'Promotion candidate' : 'Collecting'}
                  </span>
                  {c.decision && <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-semibold text-slate-500">{c.decision === 'promote' ? 'Proposed → V' : 'Dismissed'}</span>}
                </div>

                <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-2.5 text-[12.5px] text-slate-500">
                  <span>Dominant selection used <b>{c.recurrenceCount}×</b> across <b>{c.distinctCms}</b> care manager{c.distinctCms === 1 ? '' : 's'} · edited in {c.editedCount} of {c.totalSets}</span>
                  <span className="relative h-2 w-[180px] overflow-hidden rounded-full bg-slate-100"><i className={`absolute inset-y-0 left-0 rounded-full ${ready ? 'bg-emerald-500' : 'bg-purple-500'}`} style={{ width: `${width}%` }} /></span>
                  <span>threshold ≥{threshold}{ready ? ' met' : ''}</span>
                </div>

                <div className="border-b border-slate-100 px-4 py-3">
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">The recurring selection</div>
                  {c.dominantSelection.length
                    ? <div className="flex flex-wrap gap-1.5">{c.dominantSelection.map((id) => (
                        <span key={id} className="rounded-md border border-slate-200 bg-white px-2 py-1 font-mono text-[11px] text-slate-600">{id}</span>))}</div>
                    : <span className="text-[12px] text-slate-400">no stable selection yet</span>}
                </div>

                {ready ? (
                  <div className="flex flex-wrap items-center gap-2 bg-slate-50/70 px-4 py-3">
                    <button type="button" disabled={busy === `promote:${c.procedureKey}`} onClick={() => act(c, 'promote')}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
                      <Sparkles className="h-3.5 w-3.5" /> Promote → {c.suggestedName}
                    </button>
                    <button type="button" disabled={busy === `dismiss:${c.procedureKey}`} onClick={() => act(c, 'dismiss')}
                      className="rounded-lg border border-slate-200 px-3 py-2 text-[13px] font-semibold text-slate-500 hover:bg-white disabled:opacity-60">Dismiss</button>
                    <span className="ml-auto max-w-[320px] text-right text-[11.5px] text-slate-400"><b className="text-slate-600">Promote</b> proposes a named set to V for ratification. Items are already ratified — this only blesses the recurring <b>selection</b>.</span>
                  </div>
                ) : (
                  <div className="bg-slate-50/70 px-4 py-3 text-[12px] text-slate-500">Not enough recurrence to propose a named set. The adhoc sets keep serving these members within-hospital; the queue watches for a stable selection to emerge.</div>
                )}
              </div>
            );
          })}

          <div className="mt-3 border-t border-slate-100 pt-3 text-[11.5px] text-slate-400">
            <b className="text-slate-600">Governance:</b> nothing here changes a live series (frozen adhoc sets stay as administered). Promotion is the only write, and it’s <b>V-ratified</b> before anything reaches <b>hs-sets/0.3</b>.
          </div>
        </>
      )}
    </div>
  );
}
