export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { redirect, notFound } from 'next/navigation';
import { isCareUnlocked } from '@/lib/care-cookie';
import TriageBoard from '@/components/care/TriageBoard';

/** OPD Audit Triage — the care-manager daily workspace (Managed Care § PRD §5). */
export default async function TriagePage() {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');
  return <TriageBoard />;
}
