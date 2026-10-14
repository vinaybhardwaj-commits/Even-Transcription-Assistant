import Link from 'next/link';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { loadGroundStatusRaw, loadTicks, EG_BATCH, EG_CRON_MIN } from '@/lib/even-ground';
import { buildGroundStatus } from '@/lib/even-ground-core';
import GroundingLive from './live';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'LVC grounding · Admin' };

function Locked() {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">LVC grounding worker</h1>
      <p className="mt-1.5 text-sm text-slate-500">Locked. <Link href="/admin/opd-audit" className="text-brand hover:underline">Unlock an admin surface</Link> first.</p>
    </div>
  );
}

export default async function LvcGroundAdmin() {
  if (!(await isAdminUnlocked())) { adminTokenConfigured(); return <Locked />; }

  const enabled = process.env.CCB_ENABLED === '1' && process.env.LVC_GROUND_ENABLED === '1';
  const raw = await loadGroundStatusRaw(enabled).catch(() => null);
  const status = raw ? buildGroundStatus(raw) : null;
  const ticks = await loadTicks(200).catch(() => []);

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">Even Adjudicated LVC · Phase 2</div>
      <h1 className="font-serif text-[28px] font-semibold leading-tight text-slate-900">Grounding worker</h1>
      <p className="mt-1 max-w-2xl text-[13.5px] leading-relaxed text-slate-500">
        A deterministic (no-LLM, no-Qwen, &#8377;0) standing worker that attaches an <strong>&ldquo;Even Adjudicated LVC&rdquo;</strong> citation to matching low-value findings, newest-first, re-sweeping whenever the active-assertion set changes (each ratify/retire bumps the epoch). Additive + score-invariant + reversible. Batch {EG_BATCH} notes/tick, every {EG_CRON_MIN} min.
        {!enabled && <span className="ml-1 font-medium text-amber-700">Disabled — set LVC_GROUND_ENABLED=1 (+ CCB_ENABLED=1) to run.</span>}
      </p>

      <GroundingLive initialStatus={status} initialTicks={ticks} batch={EG_BATCH} cadenceMin={EG_CRON_MIN} />
    </div>
  );
}
