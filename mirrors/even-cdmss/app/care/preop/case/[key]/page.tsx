export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { redirect, notFound } from 'next/navigation';
import { isCareUnlocked } from '@/lib/care-cookie';
import PreopCasePage from '@/components/care/PreopCasePage';
import { isEpisodeKeyShape } from '@/lib/preop-versions-core';

/**
 * /care/preop/case/[key] — the case page (mockup §2): the factor tables with per-input
 * provenance, the snapshot timeline, and the anaesthetist's own verdict alongside.
 *
 * Gated identically to the board (both flags + the care unlock); the case route re-checks
 * all three independently. NO MODEL CALL on request — the client renders what the sweep
 * stored. Next.js 15: dynamic `params` is a Promise and must be awaited.
 */
export default async function PreopCaseRoute({ params }: { params: Promise<{ key: string }> }) {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (process.env.PREOP_SURFACE_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');
  const { key } = await params;
  let episodeKey = '';
  try { episodeKey = decodeURIComponent(key ?? ''); } catch { notFound(); }
  if (!episodeKey || !isEpisodeKeyShape(episodeKey)) notFound();
  return <PreopCasePage episodeKey={episodeKey} />;
}
