/**
 * app/admin/stewardship/ops-section.tsx — the ops pane's own async boundary.
 *
 * WHY THIS FILE EXISTS. The ops pane costs six db13 round trips, and the round-2 validation caught
 * one of them (`ops_calendar`) returning a gateway 504 on a single run while `danger_escalation`
 * takes about ten seconds. Both are already fail-safe — a fault degrades that metric to unknown and
 * the pane still renders — but a fail-safe read is still a read the AUDIT pane was waiting behind.
 * The board, the danger queue and the inpatient slice have no business blocking on a consult-ops
 * number, and D-ops-not-rank says as much about the relationship between them.
 *
 * So the pane awaits its own data inside its own async server component, and the page wraps it in a
 * Suspense boundary. The audit pane streams first and this arrives when it arrives. Nothing about
 * the pane's contents, guarantees or refusals changes; what changes is what has to finish before the
 * numbers an MS actually came for appear.
 *
 * ⚠️ NOT the R6.1 hidden-tab trap. That defect was a Suspense boundary around a CLIENT component
 * that fetched on mount, which deferred hydration while the tab was hidden. This is a SERVER
 * component doing its own await, which is the case streaming exists for, and it renders in a pane
 * that is always visible.
 */
import { fetchOpsPane } from '@/lib/stewardship-ops';
import OpsPane from './ops-pane';

export default async function OpsSection({ scope, only }: { scope: string; only?: string[] }) {
  const data = await fetchOpsPane(only);
  return <OpsPane data={data} scope={scope} />;
}

/** What stands in the pane's place while it loads. It says which numbers are still coming, so an
 *  empty rectangle is never mistaken for a clinic with no consults. */
export function OpsSectionFallback() {
  return (
    <div className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="font-serif text-[15px] font-semibold text-slate-900">Consult ops</h2>
      <p className="mt-1 text-[12px] italic text-slate-500">
        Reading wait, no-show, Rx share, CSAT and teleconsult adherence from the live consult tables — this takes a few
        seconds and the audit numbers above do not wait for it.
      </p>
    </div>
  );
}
