export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { redirect, notFound } from 'next/navigation';
import { isCareUnlocked } from '@/lib/care-cookie';
import PatternsShelf from '@/components/care/PatternsShelf';

/**
 * Low-value patterns (LVP-L1 kickoff §4.2) — the ONE care-manager surface that replaced the two
 * LVC rooms (Concept coder + the adjudication board, D1–D6/O1). A shelf, not a queue: what the
 * stub operator computed from last night's concept stamps, and what the care manager has hidden.
 * Nothing here is a finding and nothing here can be routed. Gates mirror /care/lvc: flags →
 * notFound, care cookie → login redirect.
 */
export default async function PatternsPage() {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (process.env.LVC_PATTERNS_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');
  return <PatternsShelf />;
}
