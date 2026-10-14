export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { redirect, notFound } from 'next/navigation';
import { isCareUnlocked } from '@/lib/care-cookie';
import SignalHealthPanel from '@/components/care/SignalHealthPanel';

/** Signal health + suppression management — Tier 0/1 self-healing (PRD §7). */
export default async function SignalHealthPage() {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');
  return <SignalHealthPanel />;
}
