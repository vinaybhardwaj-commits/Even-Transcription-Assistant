export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { redirect } from 'next/navigation';

/**
 * Destined 20 Aug 2026 (LVP-L1 kickoff §4.7, D1–D6/O1): the Even Adjudicated LVC room was folded
 * into the one Low-value patterns shelf. The route stays reachable and forwards there. LvcBoard
 * itself is untouched (kickoff untouched list).
 */
export default function LvcPage() {
  redirect('/care/patterns');
}
