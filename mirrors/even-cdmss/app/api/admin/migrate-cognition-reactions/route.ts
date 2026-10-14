/**
 * POST /api/admin/migrate-cognition-reactions — create WM2 v1's reaction store.
 * Auth: an unlocked admin session (`isAdminUnlocked`), else 401.
 *
 * A reference copy of this DDL sits in migrations/0053_cognition_reactions.sql. Additive +
 * idempotent: safe to run repeatedly, and a no-op once the table and both indexes exist.
 *
 * ⚠️ CREATE ONLY. ALTERs nothing, DROPs nothing. Does not touch opd_gov_signal,
 * opd_gov_signal_event, opd_audit_feedback, opd_note_audits or cognition_shadow_events — it cannot
 * move a score, a band, a verdict, a governance thread or a shadow decision. NO ENGINE BUMP.
 *
 * The DDL is the kickoff's "DDL (exact)" block, transcribed verbatim.
 */
import { NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST() {
  if (!(await isAdminUnlocked())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const applied: string[] = [];
  try {
    await sql`CREATE TABLE IF NOT EXISTS cognition_reactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source TEXT NOT NULL DEFAULT 'standalone',
      signal_id UUID NOT NULL,
      reference TEXT NOT NULL,
      clinical_state_ref TEXT,
      cdmss_doctor_uid TEXT NOT NULL,
      physician_id TEXT NOT NULL,
      reaction TEXT NOT NULL,
      provenance TEXT NOT NULL DEFAULT 'CLINICIAN_REPORTED_BELIEF',
      after_cdmss BOOLEAN NOT NULL DEFAULT TRUE,
      surface TEXT NOT NULL DEFAULT 'portal_findings',
      schema_version TEXT NOT NULL
    )`;
    applied.push('cognition_reactions');

    await sql`CREATE UNIQUE INDEX IF NOT EXISTS cognition_reactions_identity_uq
      ON cognition_reactions (signal_id, physician_id)`;
    applied.push('cognition_reactions_identity_uq');

    await sql`CREATE INDEX IF NOT EXISTS cognition_reactions_doctor_idx
      ON cognition_reactions (cdmss_doctor_uid, created_at DESC)`;
    applied.push('cognition_reactions_doctor_idx');

    return NextResponse.json({ ok: true, applied });
  } catch (e) {
    return NextResponse.json({ ok: false, applied, error: String((e as Error).message) }, { status: 500 });
  }
}
