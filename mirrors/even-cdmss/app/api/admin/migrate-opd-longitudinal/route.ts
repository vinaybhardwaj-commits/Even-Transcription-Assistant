import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const runtime = 'nodejs';

// Stage 3 (opd-longitudinal/0.1) — add the additive `longitudinal` jsonb column to opd_note_audits.
// Idempotent (ADD COLUMN IF NOT EXISTS). Own-DB only; the longitudinal pass writes this column via a
// separate UPDATE keyed on (uid, engine_version). Run this ONCE before enabling OPD_LONGITUDINAL_ENABLED.
// Auth: ADMIN_TOKEN (Bearer / ?token=) OR a logged-in admin session (one-click from the dashboard).
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`ALTER TABLE opd_note_audits ADD COLUMN IF NOT EXISTS longitudinal JSONB`;
    steps.longitudinal = 'ok';
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
