export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { redirect, notFound } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { isCareUnlocked } from '@/lib/care-cookie';
import ConceptWorkerPanel from '@/components/care/ConceptWorkerPanel';

/**
 * Concept Coder (CDMSS-CONCEPT-CODER-PRD v1.0) — Phase 1 worker surface. Same care-manager gate as
 * its /care peers, on the shared CCB_ENABLED surface flag.
 *
 * The page is gated on CCB_ENABLED only, NOT on LVC_CONCEPT_ENABLED: when the worker flag is off the
 * panel renders a 'disabled' state explaining why nothing is draining. A 404 would leave an operator
 * unable to tell "switched off" from "broken".
 *
 * PHASE 1 = the worker card ONLY. The review sheet and evidence drawer are Phase 2 and are gated on
 * the PRD §10 open dependency; nothing here rules on a concept or renders a verdict.
 */
export default async function ConceptsPage() {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');

  return (
    <main className="mx-auto max-w-4xl px-4 py-6">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[18px] font-semibold text-slate-900">Concept coder</h1>
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200">
          <ShieldCheck className="h-3 w-3" />Score-invariant · stamps only
        </span>
      </div>
      <p className="mt-1.5 max-w-3xl text-[12.5px] leading-relaxed text-slate-500">
        Codes each free-text finding to a governed clinical concept, the way a diagnosis is coded to ICD.
        Writes <span className="font-medium text-slate-600">concept_id</span> only; nothing here changes an audit score.
      </p>

      <ConceptWorkerPanel />

      <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
        Phase 1 is the coder alone. Reviewing concepts and ruling on them is Phase 2, and enforcement — turning a
        ruling into a suppression — is Phase 3, which is gated on an open question about whether the follow-up and
        safety-netting group should score at all.
      </p>
    </main>
  );
}
