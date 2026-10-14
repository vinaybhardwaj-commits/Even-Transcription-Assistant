// Care-Call — "Escalations · today" card on the /care landing page. Server component (async): reads
// the day's escalation-flagged outcomes (IST) + resolves member names, best-effort. DARK behind
// CARE_CALL_ENABLED; renders nothing when off or on any error (the store soft-fails to []).

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { escalationsToday } from '@/lib/care-call-store';
import { resolveMemberIdentities } from '@/lib/ccb-search';

const TRIGGER: Record<string, string> = { symptom_worse: 'worse complaint', high_alert_med_stopped: 'high-alert med stopped' };

export default async function EscalationsToday() {
  if (process.env.CARE_CALL_ENABLED !== '1') return null;
  const rows = await escalationsToday().catch(() => []);
  if (!rows.length) {
    return (
      <div className="mt-4 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-slate-700"><AlertTriangle className="h-3.5 w-3.5 text-slate-400" /> Escalations · today</div>
        <div className="text-[12px] text-slate-400">No escalations today.</div>
      </div>
    );
  }
  const names = await resolveMemberIdentities(rows.map((r) => r.individual_uid)).catch(() => ({} as Awaited<ReturnType<typeof resolveMemberIdentities>>));
  return (
    <div className="mt-4 rounded-xl border border-red-200 bg-white px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-red-700"><AlertTriangle className="h-3.5 w-3.5" /> Escalations · today <span className="font-medium text-slate-400">· {rows.length}</span></div>
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <Link key={i} href={`/care/${encodeURIComponent(r.presc_uid)}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-red-100 bg-red-50 px-2.5 py-1.5 text-[12px] text-slate-700 hover:border-red-300">
            <span className="font-medium">{names[r.individual_uid]?.name || 'Member'}</span>
            <span className="text-slate-400">{r.note_date || ''}</span>
            <span className="ml-auto rounded bg-red-100 px-1.5 py-0.5 text-[10.5px] font-bold text-red-700">{TRIGGER[r.reason] || r.reason}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
