/**
 * app/admin/lvc-ratify/page.tsx — LVC RULEBOOK REPAIR PRD v1.1 §3.5 (D-17 to D-21), 25 Aug 2026.
 *
 * THE RATIFICATION SITTING. One rule per screen; accepting writes the rulebook immediately.
 *
 * The gate is the house gate, unchanged: `isAdminUnlocked()` for a signed-in browser, and the API
 * routes behind this page additionally accept an admin token. No new auth path is introduced.
 *
 * SERVER SHELL ONLY. The state is fetched by the client body so that a reload always re-derives
 * progress from the live rulebook rather than from a cached render — §6.13 requires resuming
 * exactly, and a statically rendered snapshot of "accepted" would be a lie the moment someone else
 * accepted something. Same split as app/admin/lvc-ground.
 */
import Link from 'next/link';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { MERGE_RECORD_SET } from '@/lib/lvc-rule-merge';
import RatifySitting from './sitting';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'LVC rulebook ratification · Admin' };

function Locked() {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">LVC rulebook ratification</h1>
      <p className="mt-1.5 text-sm text-slate-500">
        Locked. <Link href="/admin/opd-audit" className="text-brand hover:underline">Unlock an admin surface</Link> first.
      </p>
    </div>
  );
}

export default async function LvcRatifyAdmin() {
  if (!(await isAdminUnlocked())) { adminTokenConfigured(); return <Locked />; }

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">LVC rulebook repair · Phase 1</div>
      <h1 className="font-serif text-[28px] font-semibold leading-tight text-slate-900">Ratification sitting</h1>
      <p className="mt-1 max-w-3xl text-[13.5px] leading-relaxed text-slate-500">
        {MERGE_RECORD_SET.blurb} Every rule is reviewed on its own screen. Progress is read from the
        live rulebook and the ledger each time this page loads, so the sitting can be closed and
        resumed at any point. This is a single-reviewer activity — two people working at once will
        see each other&rsquo;s edits only after a reload.
      </p>

      <RatifySitting />
    </div>
  );
}
