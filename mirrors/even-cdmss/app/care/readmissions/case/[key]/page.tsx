export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { redirect, notFound } from 'next/navigation';
import { isCareUnlocked } from '@/lib/care-cookie';
import ReadmissionCasePage from '@/components/care/ReadmissionCasePage';

/**
 * /care/readmissions/case/[key] — the R4 case page (CDMSS-READMISSIONS-R4-PRD v1.0 §1): the
 * card header · why this case was flagged (code) · the agent's stored account with code-enforced
 * citations · the evidence ledger · prior findings related to this return (with the denominator
 * rule) · both bills · the download button · the R4.2 ask placeholder (disabled).
 *
 * Gated IDENTICALLY to the board (both env flags + the care unlock); the case API route
 * re-checks both independently. NO MODEL CALL on request (R4-2): the client component renders
 * what the case route returns, which is what the audit stored.
 */
export default async function ReadmissionCaseRoute({ params }: { params: Promise<{ key: string }> }) {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (process.env.READMISSIONS_SURFACE_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');
  const { key } = await params;
  let dedupKey = '';
  try { dedupKey = decodeURIComponent(key ?? ''); } catch { notFound(); }
  if (!dedupKey || dedupKey.length > 200 || !/^[A-Za-z0-9/_:|.-]+$/.test(dedupKey)) notFound();
  return <ReadmissionCasePage dedupKey={dedupKey} />;
}
