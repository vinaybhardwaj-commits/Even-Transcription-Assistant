/**
 * POST /api/care/readmissions/check — READMIT-RECENT-VIEW-BUILDER-BRIEF-17-SEP-2026, item D.
 *
 * V's ruling (17 Sep 2026): the worker cron only runs 06:30–10:30 IST, so Refresh on the board only
 * ever re-read stored rows — it never looked for a NEW readmission. This route runs the SAME
 * deterministic, ₹0 detection sweep the worker's tick 1 runs (`runDetectionSweep`) — no audit, no
 * model, no worker call — so a Refresh press can surface a just-arrived pair before the next cron tick.
 *
 * AUTH: the SAME guard as GET /api/care/readmissions/list, verbatim — a care manager who can see the
 * board can trigger this check; nothing more privileged than the read it sits beside.
 *
 * COOLDOWN: 120 s per instance (module-level, lib/readmission/check-state.ts) — a fast double-press of
 * Refresh, or two tabs open at once, cannot fire two sweeps back to back. Skipped requests still answer
 * `{ ok: true, skipped: 'cooldown' }`, never an error.
 *
 * READ-ONLY toward the audited ledger: this never runs the model audit and never calls the worker route
 * — detection only upserts idempotent 'detected' rows (saveDetection), exactly as the worker's tick 1
 * does today, every 30 min.
 */
import { NextResponse } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { runDetectionSweep } from '@/lib/readmission/run';
import { findingCounts } from '@/lib/readmission/store';
import { getLastRunAtMs, recordCheck } from '@/lib/readmission/check-state';
import { withinCooldown } from '@/lib/readmission-check-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function enabled(): boolean {
  return process.env.CCB_ENABLED === '1' && process.env.READMISSIONS_SURFACE_ENABLED === '1';
}
async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function POST() {
  if (!enabled()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const nowMs = Date.now();
  const lastRunAtMs = getLastRunAtMs();
  if (withinCooldown(lastRunAtMs, nowMs)) {
    return NextResponse.json({ ok: true, skipped: 'cooldown', checkedAt: new Date(lastRunAtMs as number).toISOString() });
  }

  const before = await findingCounts();
  const sweep = await runDetectionSweep();
  const after = await findingCounts();
  const newDetected = (after.byStatus['detected'] ?? 0) - (before.byStatus['detected'] ?? 0);
  const checkedAt = new Date().toISOString();
  recordCheck(nowMs, checkedAt);

  return NextResponse.json({
    ok: true,
    pairsStored: sweep.pairsStored,
    oonStored: sweep.oonStored,
    storeSkipped: sweep.storeSkipped,
    newDetected,
    checkedAt,
  });
}
