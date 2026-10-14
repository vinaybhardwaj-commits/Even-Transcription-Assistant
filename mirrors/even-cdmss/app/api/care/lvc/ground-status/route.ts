/**
 * GET  /api/care/lvc/ground-status — the grounding worker's observability payload (PRD §7): state,
 *   epoch, paused, active_assertions, total_lv_notes, grounded_at_epoch, citations_added_total,
 *   last_tick, recent_ticks[], drain_pct. All aggregates soft-fail to null. Care/admin auth.
 * POST /api/care/lvc/ground-status {paused: bool} — sets even_ground_paused (Pause/Resume buttons).
 *
 * Flag-gated: CCB_ENABLED=1. `state='disabled'` when LVC_GROUND_ENABLED!=1 (so the panel renders the
 * hard-off state honestly even before the env flag is set).
 */
import { NextRequest, NextResponse } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { loadGroundStatusRaw, setPaused } from '@/lib/even-ground';
import { buildGroundStatus } from '@/lib/even-ground-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function surfaceOn(): boolean { return process.env.CCB_ENABLED === '1'; }
function workerEnabled(): boolean { return process.env.CCB_ENABLED === '1' && process.env.LVC_GROUND_ENABLED === '1'; }
async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function GET() {
  if (!surfaceOn()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const raw = await loadGroundStatusRaw(workerEnabled());
  return NextResponse.json({ ok: true, ...buildGroundStatus(raw) });
}

export async function POST(req: NextRequest) {
  if (!surfaceOn()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* ignore */ }
  try { await setPaused(body.paused === true || body.paused === '1'); return NextResponse.json({ ok: true, paused: body.paused === true || body.paused === '1' }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
