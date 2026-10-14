export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { ensureDoctorMetricsTables } from '@/lib/doctor-metrics-store';

/** One-click, idempotent: create doctor_operational_metrics + doctor_roster. Admin or ?token=ADMIN_TOKEN. */
export async function GET(req: NextRequest) {
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }
  try { await ensureDoctorMetricsTables(); return NextResponse.json({ ok: true, migrated: 'doctor_operational_metrics + doctor_roster' }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
