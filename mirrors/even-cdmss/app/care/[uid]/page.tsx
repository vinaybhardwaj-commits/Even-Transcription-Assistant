export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { redirect, notFound } from 'next/navigation';
import { isCareUnlocked } from '@/lib/care-cookie';
import CareBriefSplit from '@/components/care/CareBriefSplit';
import { individualUidForPresc } from '@/lib/member-state/member-state';
import { readEncounterVitals } from '@/lib/member-state/vitals-read';

/**
 * CCB v2 P2 — the brief screen is now split-screen: source document beside the findings,
 * full width. The CAT sidebar collapses for this route via the shell's existing `fullBleed`
 * mechanism (components/Shell.tsx), the same one Review Mode uses — no shell fork, no new layout.
 */
export default async function CareBriefPage({ params }: { params: Promise<{ uid: string }> }) {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');
  const { uid } = await params;
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(uid)) notFound();

  // MEMBER_STATE_UI (Phase-1 read context) + CARE_CALL_ENABLED (Phase-2 Call panel) read SERVER-side
  // and passed as boolean props (the repo has no client env-flag convention — no NEXT_PUBLIC_). Both
  // off (default) ⇒ the call surface is byte-identical.
  const memberStateUi = process.env.MEMBER_STATE_UI === '1';

  // Read-only THIS-visit vitals + member modality mix (Decision C) — resolved from the episode's
  // prescription uid, passed as a prop; never enters the snapshot. Soft-fails to undefined.
  let vitals = undefined;
  if (memberStateUi) {
    const iu = await individualUidForPresc(uid).catch(() => null);
    if (iu) vitals = await readEncounterVitals(iu, uid).catch(() => undefined);
  }

  return <CareBriefSplit uid={uid} memberStateUi={memberStateUi} careCallUi={process.env.CARE_CALL_ENABLED === '1'} vitals={vitals} />;
}
