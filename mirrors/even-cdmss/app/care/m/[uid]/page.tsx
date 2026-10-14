export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { isCareUnlocked } from '@/lib/care-cookie';
import MemberDossier from '@/components/care/MemberDossier';
import TrackWorkspace from '@/components/care/TrackWorkspace';
import MemberStatePanel from '@/components/care/MemberStatePanel';
import PromsPanel from '@/components/care/PromsPanel';
import { readMemberVitals } from '@/lib/member-state/vitals-read';

// Whole-person member view: search lands here (holistic record) → the per-visit conversation
// brief is one section within it. DARK behind CCB_ENABLED; care-manager session required.
export default async function MemberDossierPage({ params }: { params: Promise<{ uid: string }> }) {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');
  const { uid } = await params;
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(uid)) notFound();

  // Read-only vitals/modality side-channel (Decision C) — fetched here and passed as props; never
  // enters the snapshot. Soft-fails to undefined so the panel renders honestly ("no vitals recorded").
  const memberVitals = process.env.MEMBER_STATE_UI === '1'
    ? await readMemberVitals(uid).catch(() => undefined)
    : undefined;

  return (
    <div className="mx-auto max-w-4xl px-5 py-8" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <Link href="/care" className="inline-flex items-center gap-1 text-[12.5px] text-slate-500 hover:text-slate-700">
        <ArrowLeft className="h-3.5 w-3.5" /> Worklist
      </Link>
      <MemberDossier individualUid={uid} />
      {process.env.MEMBER_STATE_UI === '1' && <MemberStatePanel individualUid={uid} vitals={memberVitals} />}
      {process.env.PROMS_ENABLED === '1' && <PromsPanel individualUid={uid} />}
      <TrackWorkspace individualUid={uid} />
    </div>
  );
}
