/**
 * GET /api/opd-triage/signal-health — Tier 0 self-healing view (PRD §7).
 * Per signal_type: validated-FP rate, trend, top reason codes, and whether a suppression could help.
 * Plus the current active suppressions. Auth: care-manager cookie OR admin.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { loadTypeDecisions } from '@/lib/opd-triage-store';
import { computeSignalHealth } from '@/lib/signal-health-core';
import { listSuppressions } from '@/lib/audit-suppression-store';

async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function GET(req: NextRequest) {
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const days = Math.max(7, Math.min(365, Number(req.nextUrl.searchParams.get('days')) || 90));

  const [decisions, suppressions] = await Promise.all([
    loadTypeDecisions(days).catch(() => []),
    listSuppressions(false).catch(() => []),
  ]);
  const health = computeSignalHealth(decisions, { recentDays: 14 });

  return NextResponse.json({
    ok: true,
    window_days: days,
    decided_total: decisions.length,
    health,
    suppressions,
    advisory: 'Validated false-positive rates from care-manager triage. A suppression may only remove flagged FPs if it removes no validated signal (dual-label safety).',
  });
}
