import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// Creates the shared case-conversation storage (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026,
// P1 / O5; migration number 0046; a reference copy of this DDL sits in
// migrations/0046_case_ask_turns.sql). Additive + idempotent; mirrors
// migrate-readmission-ask. Auth: ADMIN_TOKEN (Bearer / ?token=) OR admin session.
//
// ONE piece, one route: case_ask_turns — the persisted conversation on the OPD note audit
// and the IPD discharge audit, one row per TURN, keyed
// (case_type, case_key, engine_version, turn_index). Content is already de-identified when it
// arrives (§3.3 extends the de-id rule to stored turn content, not only model material).
// `withheld` marks an agent turn that failed its citation check or hit the O7 daily ceiling —
// it is kept, because "the agent could not answer that" is part of the record, and it is never
// replayed to the model.
//
// NOT HERE, deliberately (O5): no overlay column, on this table or any other. OPD and IPD get
// no clinical_review this ship. This route ALTERs nothing — it does not touch
// opd_note_audits, ipd_discharge_audits, or either feedback table — so it cannot move a score,
// a band or a verdict.
//
// READMISSIONS UNTOUCHED: readmission_ask_turns and the nine clinical_review_* columns from
// migration 0045 are not read, altered or dropped here.
//
// NO ENGINE BUMP: OPD stays 'opd-note-audit/0.81.21', IPD stays 'ipd-discharge-audit/0.2'.
// ⚠️ INFERRED SQL/DDL throughout: this sandbox has no live Neon.

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS case_ask_turns (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      case_type       TEXT NOT NULL,
      case_key        TEXT NOT NULL,
      engine_version  TEXT NOT NULL,
      turn_index      INT NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      actor           TEXT,
      withheld        BOOLEAN NOT NULL DEFAULT FALSE
    )`;
    steps.create_turns_table = 'ok';
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS case_ask_turns_key_idx
      ON case_ask_turns (case_type, case_key, engine_version, turn_index)`;
    steps.turns_unique_index = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS case_ask_turns_day_idx
      ON case_ask_turns (case_type, case_key, engine_version, role, created_at)`;
    steps.turns_day_index = 'ok';
    const turns = (await sql`SELECT count(*)::int AS n FROM case_ask_turns`) as Array<{ n: number }>;
    steps.turn_rows = String(turns[0]?.n ?? 0);
    const threads = (await sql`SELECT count(DISTINCT (case_type, case_key, engine_version))::int AS n FROM case_ask_turns`) as Array<{ n: number }>;
    steps.threads = String(threads[0]?.n ?? 0);
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
