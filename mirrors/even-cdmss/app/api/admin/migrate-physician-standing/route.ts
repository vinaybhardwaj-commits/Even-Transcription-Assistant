import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// Creates the MS standing-overlay storage (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, S4;
// spec §6.3; migration number 0050 — the spec said 0046, but 0046-0049 were taken). A reference
// copy of this DDL sits in migrations/0050_physician_standing.sql. Additive + idempotent; mirrors
// migrate-case-ask. Auth: ADMIN_TOKEN (Bearer / ?token=) OR admin session.
//
// ONE piece, one route: physician_standing — one row per STATEMENT, append-only. A superintendent
// changing his mind is a second row, never an edited first one.
//
// ⚠️ CREATE ONLY. This route ALTERs nothing and DROPs nothing. It does not touch opd_note_audits,
// ipd_discharge_audits, either feedback table, or case_ask_turns, so it cannot move a score, a
// band, a verdict or a stored conversation. NO ENGINE BUMP.
//
// ⚠️ INFERRED SQL/DDL throughout: this sandbox has no live Neon.

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS physician_standing (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      case_type       TEXT NOT NULL,
      case_key        TEXT NOT NULL,
      engine_version  TEXT NOT NULL,
      standing        TEXT NOT NULL,
      quote           TEXT NOT NULL,
      actor           TEXT,
      turn_id         TEXT,
      model           TEXT,
      window_days     INT,
      authority       TEXT NOT NULL DEFAULT 'medical_superintendent',
      stated          BOOLEAN NOT NULL DEFAULT TRUE
    )`;
    steps.create_standing_table = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS physician_standing_case_idx
      ON physician_standing (case_type, case_key, created_at DESC)`;
    steps.standing_case_index = 'ok';
    const rows = (await sql`SELECT count(*)::int AS n FROM physician_standing`) as Array<{ n: number }>;
    steps.standing_rows = String(rows[0]?.n ?? 0);
    const cases = (await sql`SELECT count(DISTINCT (case_type, case_key))::int AS n FROM physician_standing`) as Array<{ n: number }>;
    steps.cases_with_a_standing = String(cases[0]?.n ?? 0);
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
