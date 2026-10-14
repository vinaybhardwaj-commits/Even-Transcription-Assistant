export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { redirect, notFound } from 'next/navigation';
import { isCareUnlocked } from '@/lib/care-cookie';
import LvcBoard from '@/components/care/LvcBoard';

/**
 * Even Adjudicated LVC (CDMSS-EVEN-LVC-ADJUDICATION §7) — the assertion library + governance room.
 * Same care-manager gate as its /care peers, plus the LVC_ADJUDICATION_ENABLED feature flag (ships
 * OFF). The client component owns the roster identity pick, the generate trigger, and the ratify /
 * edit-and-ratify / reject / retire actions.
 */
export default async function LvcPage() {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (process.env.LVC_ADJUDICATION_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');
  return <LvcBoard />;
}
