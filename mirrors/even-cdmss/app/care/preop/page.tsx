export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { redirect, notFound } from 'next/navigation';
import { isCareUnlocked } from '@/lib/care-cookie';
import PreopBoard from '@/components/care/PreopBoard';

/**
 * Pre-op Risk (PRD CDMSS-PREOP-RISK-AGENT-v1.1-LOCKED §6; Build Plan B4) — the room a
 * care manager opens to see what the pre-op agent computed for the upcoming surgical
 * list. Same care-manager gate as its /care peers, plus PREOP_SURFACE_ENABLED, which
 * ships OFF: V flips it after the deploy is verified.
 *
 * The client component owns the fetch and the render; the read route re-checks both
 * flags and the cookie independently, so the gate is not enforced in only one place.
 */
export default async function PreopPage() {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (process.env.PREOP_SURFACE_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');
  return <PreopBoard />;
}
