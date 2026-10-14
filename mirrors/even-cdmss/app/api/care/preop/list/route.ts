/**
 * GET /api/care/preop/list — the read behind /care/preop (Build Plan B4).
 *
 * READ-ONLY and NO MODEL. Two Neon reads, both fail-safe: the upcoming findings the
 * sweep already stored, and the last sweep's heartbeat (for the stamp and the degraded
 * strip). Nothing here recomputes a score — the board renders what the engine wrote, and
 * the card rows are built from the STORED SNAPSHOT rather than from the scalar columns,
 * so the board cannot drift from the arithmetic.
 *
 * Gates, independently (mockup §4): CCB_ENABLED, PREOP_SURFACE_ENABLED, and the
 * care-manager cookie (or an admin session). The page checks the same three; neither
 * relies on the other.
 *
 * PHI: patient names are read here and rendered behind the care gate. Nothing is
 * persisted by this route and nothing is transmitted anywhere.
 */
import { NextResponse } from 'next/server';
import { preopAuthed, preopFlagState, preopSurfaceEnabled } from '@/lib/preop/gate';
import { lastSweep, listUpcoming, PREOP_ENGINE_VERSION } from '@/lib/preop/store';
import { toCardRow } from '@/lib/preop/surface-row';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!preopSurfaceEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!(await preopAuthed())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const [list, sweep] = await Promise.all([listUpcoming(), lastSweep()]);
  return NextResponse.json({
    ok: true,
    engine: PREOP_ENGINE_VERSION,
    rows: list.rows.map(toCardRow),
    lastSweepAt: sweep.at,
    // Non-empty ⇒ every coverage number on the board is a floor, and the board says so.
    degradedSources: sweep.degradedSources,
    // Flag state is never a matter of belief on a clinical screen (mockup note 2).
    ...preopFlagState(),
    error: list.error ?? sweep.error ?? null,
  });
}
