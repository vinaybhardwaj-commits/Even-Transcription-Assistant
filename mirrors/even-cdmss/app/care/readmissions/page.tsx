export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { redirect, notFound } from 'next/navigation';
import { isCareUnlocked } from '@/lib/care-cookie';
import ReadmissionsBoard from '@/components/care/ReadmissionsBoard';

/**
 * Readmissions (CDMSS-READMISSION-PHASE-2-CARE-SURFACE-PRD v1.0) — the read-only room a
 * care manager opens to review what the readmission agent found. Same care-manager gate
 * as its /care peers, plus READMISSIONS_SURFACE_ENABLED, which ships OFF: V flips it
 * after the deploy is verified.
 *
 * The client component owns the fetch and the render; the read route re-checks both
 * gates independently, so the flag is not enforced in only one place.
 */
export default async function ReadmissionsPage() {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (process.env.READMISSIONS_SURFACE_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');
  return <ReadmissionsBoard />;
}
