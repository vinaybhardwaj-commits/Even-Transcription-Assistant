/**
 * POST /api/admin/quieting-dryrun — server-side dry-run preview for a proposed demote rule
 * (PRD CDMSS-QUIETING-DEMOTE-SYSTEM §6): "would have quieted N findings in the last 30 days",
 * computed READ-ONLY against stored audits. Backs the preview banner and the activation screen.
 * Admin-gated. No writes of any kind.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ruleViolatesSeverityFloor, type Suppression } from '@/lib/audit-suppression-core';
import { demoteDryRunCount } from '@/lib/audit-suppression-store';

export async function POST(req: NextRequest) {
  // The Quieting tab (care surface) shows live counts too, so care OR admin may read. Read-only.
  const ok = (await isCareUnlocked().catch(() => false)) || (await isAdminUnlocked().catch(() => false));
  if (!ok) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  let b: Record<string, unknown>;
  try { b = (await req.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const rule: Suppression = {
    signal_type: String(b.signal_type || ''),
    discriminator: b.discriminator == null || b.discriminator === '' ? null : String(b.discriminator),
    match_kind: b.match_kind === 'subject_contains' ? 'subject_contains' : b.match_kind === 'lvc_category' ? 'lvc_category' : 'type_only',
    scope: 'all', doctor_uid: null, action: 'demote', active: true, status: 'active',
  };
  if (!rule.signal_type) return NextResponse.json({ ok: false, error: 'signal_type required' }, { status: 400 });
  if (ruleViolatesSeverityFloor(rule)) {
    return NextResponse.json({ ok: false, error: `severity floor: '${rule.signal_type}' cannot be quieted`, floor: true }, { status: 409 });
  }
  try {
    const windowDays = Math.min(90, Math.max(1, Number(b.window_days ?? 30) | 0));
    const preview = await demoteDryRunCount(rule, windowDays);
    return NextResponse.json({ ok: true, window_days: windowDays, ...preview });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
