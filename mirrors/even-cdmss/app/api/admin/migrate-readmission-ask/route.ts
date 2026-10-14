import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const runtime = 'nodejs';

// Creates the R9 conversation storage (Readmissions R9 — PRD
// CDMSS-READMISSIONS-R9-DUAL-CONTRACT-PRD-27-AUG-2026-GO, O3; migration number 0045; a
// reference copy of this DDL sits in migrations/0045_readmission_ask_turns.sql).
// Additive + idempotent; mirrors migrate-readmission-versions. Auth: ADMIN_TOKEN
// (Bearer / ?token=) OR admin session.
//
// Two pieces, one route:
//   1. readmission_ask_turns — the persisted case conversation, one row per TURN, keyed
//      (dedup_key, engine_version, turn_index). The content is already de-identified when
//      it arrives (R43-8 extended: the de-id rule covers stored turn content, not only
//      model material). `withheld` marks an agent turn that failed its citation check —
//      it is kept, because "the agent could not answer that" is part of the record, and
//      it is never replayed to the model.
//   2. clinical_review_* on readmission_findings — nine nullable columns, D14's parallel
//      human overlay. COLUMNS and not a jsonb blob because the board must FILTER on
//      `decision`. They sit BESIDE avoidable / planned / same_condition /
//      preventable_injury / negligence and this migration does not touch any of those.
//
// NO ENGINE BUMP: READMIT_ENGINE_VERSION stays 'readmission/0.2'. Nothing detected,
// audited or scored changes; this is storage for a conversation and for a human judgement.
// Existing rows simply carry NULL until a care manager states something.
// ⚠️ INFERRED SQL/DDL throughout: this sandbox has no live Neon.

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS readmission_ask_turns (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      dedup_key       TEXT NOT NULL,
      engine_version  TEXT NOT NULL,
      turn_index      INT NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      actor           TEXT,
      withheld        BOOLEAN NOT NULL DEFAULT FALSE,
      overlay_json    JSONB
    )`;
    steps.create_turns_table = 'ok';
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS readmission_ask_turns_key_idx
      ON readmission_ask_turns (dedup_key, engine_version, turn_index)`;
    steps.turns_unique_index = 'ok';
    // D14 — the parallel human overlay. Nine additive nullable columns; NOT a blob (the list
    // filters on decision). Nothing here writes or reads avoidable / planned / same_condition /
    // preventable_injury / negligence.
    await sql`ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_decision TEXT`;
    await sql`ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_clock_class TEXT`;
    await sql`ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_lt24h_kind TEXT`;
    await sql`ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_exclusion_claim TEXT`;
    await sql`ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_quote TEXT`;
    await sql`ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_actor TEXT`;
    await sql`ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_at TIMESTAMPTZ`;
    await sql`ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_turn_id TEXT`;
    await sql`ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_model TEXT`;
    steps.clinical_review_columns = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS readmission_findings_clinical_review_idx
      ON readmission_findings (engine_version, clinical_review_decision)`;
    steps.clinical_review_index = 'ok';
    const turns = (await sql`SELECT count(*)::int AS n FROM readmission_ask_turns`) as Array<{ n: number }>;
    steps.turn_rows = String(turns[0]?.n ?? 0);
    const reviewed = (await sql`SELECT count(*)::int AS n FROM readmission_findings WHERE clinical_review_decision IS NOT NULL`) as Array<{ n: number }>;
    steps.clinical_reviews = String(reviewed[0]?.n ?? 0);
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
