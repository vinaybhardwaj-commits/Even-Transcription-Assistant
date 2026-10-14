/**
 * GET  /api/care/concept/status — the Concept Coder worker's observability payload: state, paused,
 *   coded/candidates + coded_pct, cache_hit_pct, strings_extracted_7d, rejected_recent, not_yet_coded,
 *   concepts, strings_seed, last_tick, recent_ticks[]. All aggregates soft-fail to null.
 * POST /api/care/concept/status {paused: bool} — sets even_concept_paused (Pause/Resume).
 *
 * Flag-gated: CCB_ENABLED=1 for the SURFACE. `state='disabled'` when LVC_CONCEPT_ENABLED!=1 so the
 * panel renders the hard-off state honestly and an operator can see WHY nothing is draining, rather
 * than a 404. Mirrors app/api/care/lvc/ground-status/route.ts exactly.
 *
 * READ-ONLY over existing tables. NO PHI, NO doctor identifier, NO finding text — counts only.
 * Nothing here touches the audit or scoring path.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { loadConceptStatusRaw, setPaused } from '@/lib/even-concept';
import { buildConceptStatus } from '@/lib/even-concept-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function surfaceOn(): boolean { return process.env.CCB_ENABLED === '1'; }
function workerEnabled(): boolean { return process.env.CCB_ENABLED === '1' && process.env.LVC_CONCEPT_ENABLED === '1'; }
async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function GET() {
  if (!surfaceOn()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const raw = await loadConceptStatusRaw(workerEnabled());
  return NextResponse.json({ ok: true, ...buildConceptStatus(raw) });
}

export async function POST(req: NextRequest) {
  if (!surfaceOn()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* ignore */ }
  const paused = body.paused === true || body.paused === '1';
  try { await setPaused(paused); return NextResponse.json({ ok: true, paused }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
