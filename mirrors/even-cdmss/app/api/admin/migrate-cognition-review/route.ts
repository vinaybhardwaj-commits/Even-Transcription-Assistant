/**
 * POST /api/admin/migrate-cognition-review — create WM6's sequential-review storage.
 * Auth: an unlocked admin session (`isAdminUnlocked`), else 401.
 *
 * A reference copy of this DDL sits in migrations/0054_cognition_review.sql. Additive +
 * idempotent: safe to run repeatedly, and a no-op once both tables and both indexes exist.
 *
 * ⚠️ CREATE ONLY. ALTERs nothing, DROPs nothing. Does not touch cognition_shadow_events,
 * cognition_reactions, opd_gov_signal, opd_note_audits or clinical_states — it cannot move a score,
 * a band, a verdict, a governance thread, a shadow decision or a reaction. NO ENGINE BUMP.
 *
 * The DDL is the kickoff's "DDL (exact)" block, transcribed verbatim. The tables are created in
 * order: cognition_belief_updates carries a foreign key onto cognition_review_sessions.
 */
import { NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST() {
  if (!(await isAdminUnlocked())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const applied: string[] = [];
  try {
    await sql`CREATE TABLE IF NOT EXISTS cognition_review_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      individual_uid_hash TEXT NOT NULL,
      microworld TEXT NOT NULL,
      reviewer_role TEXT NOT NULL,
      variants TEXT[] NOT NULL DEFAULT '{}',
      walk_version TEXT NOT NULL,
      member_state_version TEXT NOT NULL,
      ipd_fold TEXT NOT NULL,
      cuts JSONB NOT NULL,
      cut_count INTEGER NOT NULL,
      revealed_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      completed_at TIMESTAMPTZ,
      schema_version TEXT NOT NULL
    )`;
    applied.push('cognition_review_sessions');

    await sql`CREATE INDEX IF NOT EXISTS cognition_review_sessions_subject_idx
      ON cognition_review_sessions (individual_uid_hash, created_at DESC)`;
    applied.push('cognition_review_sessions_subject_idx');

    await sql`CREATE TABLE IF NOT EXISTS cognition_belief_updates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      session_id UUID NOT NULL REFERENCES cognition_review_sessions(id) ON DELETE CASCADE,
      step_index INTEGER NOT NULL,
      cut_date DATE NOT NULL,
      variant_id TEXT,
      reviewer_role TEXT NOT NULL,
      provenance TEXT NOT NULL DEFAULT 'CLINICIAN_REPORTED_BELIEF',
      trigger TEXT NOT NULL DEFAULT 'retrospective_replay',
      after_cdmss BOOLEAN NOT NULL DEFAULT FALSE,
      payload JSONB NOT NULL,
      seconds_spent INTEGER NOT NULL,
      schema_version TEXT NOT NULL
    )`;
    applied.push('cognition_belief_updates');

    await sql`CREATE UNIQUE INDEX IF NOT EXISTS cognition_belief_updates_step_uq
      ON cognition_belief_updates (session_id, step_index, COALESCE(variant_id, 'base'))`;
    applied.push('cognition_belief_updates_step_uq');

    return NextResponse.json({ ok: true, applied });
  } catch (e) {
    return NextResponse.json({ ok: false, applied, error: String((e as Error).message) }, { status: 500 });
  }
}
