/**
 * POST /api/admin/migrate-cognition-shadow — create WM1's shadow-agent storage.
 * Auth: ADMIN_TOKEN (Bearer / ?token=) OR an admin session cookie. Mirrors migrate-physician-standing.
 *
 * A reference copy of this DDL sits in migrations/0051_cognition_shadow.sql. Additive + idempotent:
 * safe to run repeatedly, and a no-op once the table exists.
 *
 * ⚠️ CREATE ONLY. ALTERs nothing, DROPs nothing. Does not touch opd_note_audits,
 * ipd_discharge_audits, clinical_states or case_ask_turns — it cannot move a score, a band, a
 * verdict or a stored conversation. NO ENGINE BUMP.
 *
 * ⚠️ INFERRED DDL: this sandbox has no live Neon, and the PRD's §4 was unavailable (see the .sql
 * header). Validate against §4 before running.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS cognition_shadow_events (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source      TEXT NOT NULL DEFAULT 'standalone',
      trigger_kind    TEXT NOT NULL,
      event_ref       TEXT NOT NULL,
      event_at        TIMESTAMPTZ,
      doctor_uid      TEXT,
      engine_version  TEXT,
      microworld      TEXT NOT NULL,
      match_rule      TEXT NOT NULL,
      eligible        BOOLEAN NOT NULL DEFAULT FALSE,
      would_ask       BOOLEAN NOT NULL DEFAULT FALSE,
      objective       TEXT,
      reason          TEXT NOT NULL,
      o_status        TEXT,
      policy_version  TEXT NOT NULL,
      schema_version  TEXT NOT NULL
    )`;
    steps.create_shadow_table = 'ok';

    await sql`CREATE UNIQUE INDEX IF NOT EXISTS cognition_shadow_events_identity_uq
      ON cognition_shadow_events (trigger_kind, event_ref, policy_version)`;
    steps.identity_unique_index = 'ok';

    await sql`CREATE INDEX IF NOT EXISTS cognition_shadow_events_budget_idx
      ON cognition_shadow_events (policy_version, would_ask, created_at DESC)`;
    steps.budget_index = 'ok';

    await sql`CREATE INDEX IF NOT EXISTS cognition_shadow_events_doctor_idx
      ON cognition_shadow_events (doctor_uid, created_at DESC)`;
    steps.doctor_index = 'ok';

    const rows = (await sql`SELECT count(*)::int AS n FROM cognition_shadow_events`) as Array<{ n: number }>;
    steps.shadow_rows = String(rows[0]?.n ?? 0);
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
