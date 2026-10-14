import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// The stay library's hardening migration (CDMSS-STAY-LIBRARY-HARDENING-PRD-v1.0-29-AUG-2026,
// H-D2 / H-D11; migration number 0049, reference copy in
// migrations/0049_stay_library_hardening.sql). Additive + idempotent; mirrors
// migrate-clinical-states (0047), which mirrored migrate-case-ask (0046). Auth: ADMIN_TOKEN
// (Bearer / ?token=) OR admin session.
//
// H3: three additive columns on clinical_states — last_checked_at, check_count, superseded_by —
// so "we looked on date X and it was absent" stops being indistinguishable from "nobody ever
// looked". Absence rows are never deleted; supersession is an UPDATE that points at the real row.
//
// H1: clinical_state_versions — the prior reading of a library row, kept before it is overwritten.
// One row per OVERWRITE, written in the same SQL statement as the overwrite itself (a CTE in
// lib/stay-library/store.ts), so a failed snapshot blocks the overwrite instead of losing it. A
// fresh insert writes nothing here. `reason` is a closed set of two: 'upsert_overwrite' and
// (H3) 'superseded'.
//
// Every statement is additive: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, ADD COLUMN
// IF NOT EXISTS. Nothing is dropped, nothing is rewritten, and no existing value changes — so this
// route cannot touch an audit, a feedback row, an episode or a member-state snapshot, and the
// library rows it adds columns to keep every value they had. No engine version, no schema version,
// no flag. Running it twice is the same as running it once.
//
// SELF-VERIFYING: the response reports what pg_class actually holds afterwards, so the operator
// reads the database's answer rather than this route's optimism.
// ⚠️ INFERRED SQL/DDL throughout: this sandbox has no live Neon.

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS clinical_state_versions (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      snapshotted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      clinical_state_id UUID NOT NULL,
      doc_kind          TEXT NOT NULL,
      source_uid        TEXT NOT NULL,
      schema_version    TEXT NOT NULL,
      status            TEXT NOT NULL,
      state_json        JSONB NOT NULL,
      reason            TEXT NOT NULL
    )`;
    steps.create_clinical_state_versions = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS clinical_state_versions_state_idx
      ON clinical_state_versions (clinical_state_id, snapshotted_at)`;
    steps.state_index = 'ok';

    // H3 (H-D7): the three absence columns. ADD COLUMN IF NOT EXISTS is additive and idempotent —
    // it changes no existing value, and every row already on the table reads check_count 0 and
    // last_checked_at NULL, which is the honest statement that nobody has re-looked yet.
    await sql`ALTER TABLE clinical_states ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ`;
    await sql`ALTER TABLE clinical_states ADD COLUMN IF NOT EXISTS check_count     INTEGER NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE clinical_states ADD COLUMN IF NOT EXISTS superseded_by   UUID`;
    steps.absence_columns = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS clinical_states_relook_idx
      ON clinical_states (status, last_checked_at, created_at)`;
    steps.relook_index = 'ok';

    // What the database says it now has — table presence, then the version rows already kept.
    const present = (await sql`SELECT to_regclass('public.clinical_state_versions') IS NOT NULL AS ok`) as Array<{ ok: boolean }>;
    steps.verified_table = present[0]?.ok ? 'present' : 'MISSING';
    const counted = (await sql`SELECT reason, count(*)::int AS n FROM clinical_state_versions GROUP BY reason`) as Array<{ reason: string; n: number }>;
    steps.versions_by_reason = JSON.stringify(
      Object.fromEntries(counted.map((r) => [String(r.reason), Number(r.n ?? 0)])),
    );
    const cols = (await sql`SELECT column_name FROM information_schema.columns
       WHERE table_name = 'clinical_states'
         AND column_name IN ('last_checked_at','check_count','superseded_by')`) as Array<{ column_name: string }>;
    steps.verified_absence_columns = cols.map((c) => String(c.column_name)).sort().join(',') || 'MISSING';
    // The re-look's own starting position: how many absence rows are waiting, and how many of them
    // nobody has ever looked at again. Both are zero-work answers the operator can sanity-check.
    const absences = (await sql`SELECT count(*)::int AS total,
              count(*) FILTER (WHERE last_checked_at IS NULL)::int AS never_checked
         FROM clinical_states
        WHERE status = 'not_auditable' AND source_uid LIKE 'absent:%' AND superseded_by IS NULL`) as Array<{ total: number; never_checked: number }>;
    steps.absence_rows = JSON.stringify({
      total: Number(absences[0]?.total ?? 0), never_checked: Number(absences[0]?.never_checked ?? 0),
    });
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
