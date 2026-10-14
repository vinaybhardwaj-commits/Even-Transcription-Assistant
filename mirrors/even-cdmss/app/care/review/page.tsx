export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { redirect, notFound } from 'next/navigation';
import { isCareUnlocked } from '@/lib/care-cookie';
import ReviewSession from './review-session';

/**
 * Review Mode (Gold-Label Review-Mode PRD §2) — full-screen, keyboard-first, one FINDING per screen.
 * Lives under /care behind the SAME care-manager gate as /care/triage (§1.4 — no new auth). The
 * client component owns the queue fetch, the roster-driven identity picker, and the label POSTs.
 */
export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ study?: string | string[] }> }) {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');
  // Study-lane wiring (U1): the lane name is server-read, sanitised ONCE — trim, ≤64, empty →
  // undefined — matching review-queue/route.ts's own read exactly, so client and server can never
  // disagree about the lane. No useSearchParams, no Suspense boundary. Absent ⇒ prop undefined ⇒
  // the rendered DOM and every request are byte-identical to today.
  const sp = await searchParams;
  const rawStudy = Array.isArray(sp?.study) ? sp.study[0] : sp?.study;
  const study = String(rawStudy ?? '').trim().slice(0, 64) || undefined;
  return <ReviewSession study={study} />;
}
