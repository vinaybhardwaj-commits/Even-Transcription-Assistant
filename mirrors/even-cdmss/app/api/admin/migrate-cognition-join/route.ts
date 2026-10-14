/**
 * POST /api/admin/migrate-cognition-join — create WM3's join storage.
 * Auth: an unlocked admin session (`isAdminUnlocked`), else 401.
 *
 * A reference copy of this DDL sits in migrations/0055_cognition_join.sql. Additive + idempotent:
 * safe to run repeatedly, and a no-op once both tables and all three indexes exist.
 *
 * ⚠️ CREATE ONLY. ALTERs nothing, DROPs nothing. Does not touch cognition_shadow_events,
 * cognition_reactions, cognition_review_sessions, cognition_belief_updates, opd_note_audits or
 * anything the frozen spine reads. NO ENGINE BUMP.
 *
 * ⚠️ BOTH TABLES CARRY PHI and are not readable by the Lab research scope.
 *
 * The DDL is the kickoff's "DDL (exact)" block, transcribed verbatim. Order matters:
 * cognition_triples carries two foreign keys onto cognition_snapshots.
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

    return NextResponse.json({ ok: true, applied });
  } catch (e) {
    return NextResponse.json({ ok: false, applied, error: String((e as Error).message) }, { status: 500 });
  }
}
