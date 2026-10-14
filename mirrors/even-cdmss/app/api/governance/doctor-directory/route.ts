/**
 * GET /api/governance/doctor-directory  (contract §7b.2)
 * The canonical doctor list EPI matches its physicians against (to populate physicians.cdmss_doctor_uid
 * by name). Served from the pre-cleaned/pre-deduped doctor_roster snapshot. No PHI; mobile_last4 only,
 * for disambiguation. GOV_API_KEY (or admin).
 *
 * Duplicate-mobile doctors are collapsed to one canonical uid; the others are listed in alias_uids so
 * a finding keyed on any of them resolves. Disabled doctors are included with disabled: true (the
 * consumer decides what to do with them).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { govKeyValid } from '@/lib/gov-auth';
import { readRoster } from '@/lib/doctor-metrics-store';

export async function GET(req: NextRequest) {
  if (!govKeyValid(req) && !(await isAdminUnlocked())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const roster = await readRoster();
  return NextResponse.json({
    ok: true,
    generated_at: new Date().toISOString(),
    count: roster.length,
    doctors: roster.map((r) => ({
      doctor_uid: r.doctor_uid,
      name: r.name,
      name_normalized: r.name_normalized,
      specialty: r.specialty,
      channel: r.channel,
      mobile_last4: r.mobile_last4,
      has_email: r.has_email,
      audit_active: r.audit_active,
      operational_active: r.operational_active,
      // Round 1: other uids collapsed into this person (same mobile), and the db13 disabled flag.
      alias_uids: r.alias_uids,
      disabled: r.disabled,
    })),
  });
}
