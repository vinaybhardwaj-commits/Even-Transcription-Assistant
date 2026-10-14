/**
 * POST /api/admin/migrate-cognition-join — create WM3's join storage.
 * Auth: an unlocked admin session (`isAdminUnlocked`), else 401.
 *
 * Reference copies of this DDL sit in migrations/0055_cognition_join.sql (the two tables) and
 * migrations/0056_cognition_join_fix3.sql (WM3 fix 3: era_status, its index, and the stability
 * table). Additive + idempotent: safe to run repeatedly, and a no-op once everything exists.
 *
 * ⚠️ ADDITIVE ONLY. The one ALTER adds a NOT NULL column WITH A DEFAULT, so it neither rewrites a
 * value nor invalidates a row; nothing is DROPped and no column is retyped. Does not touch
 * cognition_shadow_events, cognition_reactions, cognition_review_sessions,
 * cognition_belief_updates, opd_note_audits or anything the frozen spine reads. NO ENGINE BUMP.
 *
 * ⚠️ ALL THREE TABLES CARRY PHI (cognition_join_stability holds the triple ids of a sample) and
 * none is readable by the Lab research scope.
 *
 * The DDL is each kickoff's "DDL (exact)" / "Schema, exact" block, transcribed verbatim. Order
 * matters: cognition_triples carries two foreign keys onto cognition_snapshots, and the 0056 ALTER
 * needs cognition_triples to exist.
 */
import { NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST() {
  if (!(await isAdminUnlocked())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const applied: string[] = [];
  try {
    await sql`CREATE TABLE IF NOT EXISTS cognition_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      individual_uid TEXT NOT NULL,
      as_of DATE NOT NULL,
      cut_status TEXT NOT NULL,
      provenance TEXT NOT NULL,
      walk_version TEXT NOT NULL,
      member_state_version TEXT NOT NULL,
      ipd_fold TEXT NOT NULL,
      snapshot_json JSONB,
      snapshot_hash TEXT,
      schema_version TEXT NOT NULL
    )`;
    applied.push('cognition_snapshots');

    await sql`CREATE UNIQUE INDEX IF NOT EXISTS cognition_snapshots_identity_uq
      ON cognition_snapshots (individual_uid, as_of, walk_version, member_state_version, ipd_fold, provenance)`;
    applied.push('cognition_snapshots_identity_uq');

    await sql`CREATE TABLE IF NOT EXISTS cognition_triples (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      trigger_kind TEXT NOT NULL,
      event_ref TEXT NOT NULL,
      event_at TIMESTAMPTZ NOT NULL,
      individual_uid TEXT,
      microworld TEXT NOT NULL,
      provenance TEXT NOT NULL,
      resolve_status TEXT NOT NULL,
      o_before_id UUID REFERENCES cognition_snapshots(id),
      y_kind TEXT,
      y_ref TEXT,
      y_test_date TIMESTAMP,
      y_create_time TIMESTAMPTZ,
      y_visible_at TIMESTAMPTZ,
      y_visible_rule TEXT,
      y_status TEXT NOT NULL,
      y_horizon_days INTEGER NOT NULL DEFAULT 14,
      o_after_id UUID REFERENCES cognition_snapshots(id),
      o_after_as_of DATE,
      reaction_ref UUID,
      reaction_after_cdmss BOOLEAN,
      policy_version TEXT NOT NULL,
      schema_version TEXT NOT NULL
    )`;
    applied.push('cognition_triples');

    await sql`CREATE UNIQUE INDEX IF NOT EXISTS cognition_triples_identity_uq
      ON cognition_triples (trigger_kind, event_ref, schema_version)`;
    applied.push('cognition_triples_identity_uq');

    await sql`CREATE INDEX IF NOT EXISTS cognition_triples_status_idx
      ON cognition_triples (y_status, updated_at)`;
    applied.push('cognition_triples_status_idx');

    // ── 0056 · WM3 fix 3 (era_status, the raw trigger, the stability table) ───────────────────
    //
    // ⚠️ ADDITIVE ONLY, and the additive idiom is what makes it safe on a table that already holds
    // rows: the column is NOT NULL with a DEFAULT, so every existing triple becomes `current`
    // without a backfill — which is exactly what they are, having been opened from eligible shadow
    // events. No existing row's meaning changes, so JOIN_SCHEMA_VERSION stays 'cognition-join/0.1'.
    await sql`ALTER TABLE cognition_triples ADD COLUMN IF NOT EXISTS era_status TEXT NOT NULL DEFAULT 'current'`;
    applied.push('cognition_triples.era_status');

    await sql`CREATE INDEX IF NOT EXISTS cognition_triples_era_idx
      ON cognition_triples (era_status, trigger_kind)`;
    applied.push('cognition_triples_era_idx');

    // The stability log. APPEND-ONLY: each row is one measurement of whether O_before still
    // reconstructs to what was stored, and measurements accumulate rather than overwrite. No FK on
    // triple_ids — it is a jsonb list of what was sampled, and a sample must stay readable even if
    // a triple it names is later removed.
    await sql`CREATE TABLE IF NOT EXISTS cognition_join_stability (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sample_n INTEGER NOT NULL,
      matched_n INTEGER NOT NULL,
      failed_n INTEGER NOT NULL,
      triple_ids JSONB NOT NULL,
      mismatched_ids JSONB NOT NULL,
      walk_version TEXT NOT NULL,
      member_state_version TEXT NOT NULL,
      schema_version TEXT NOT NULL
    )`;
    applied.push('cognition_join_stability');

    return NextResponse.json({ ok: true, applied });
  } catch (e) {
    return NextResponse.json({ ok: false, applied, error: String((e as Error).message) }, { status: 500 });
  }
}
