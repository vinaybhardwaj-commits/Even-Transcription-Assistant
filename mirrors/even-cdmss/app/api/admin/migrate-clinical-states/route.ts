import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { libraryCounts } from '@/lib/stay-library/store';

export const runtime = 'nodejs';

// Creates the per-stay ClinicalState document library (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-
// 27-AUG-2026, P2 / O9; migration number 0047; a reference copy of this DDL sits in
// migrations/0047_clinical_states.sql). Additive + idempotent; mirrors migrate-case-ask
// (0046), which mirrored migrate-readmission-ask (0045). Auth: ADMIN_TOKEN
// (Bearer / ?token=) OR admin session.
//
// ONE piece, one route: clinical_states — one row per stay document, keyed
// (doc_kind, source_uid, schema_version). Four document classes and no more this ship
// (O10): discharge, ot, pac, progress.
//
// A CLASS THAT PRODUCED NOTHING STILL GETS A ROW, with status 'not_auditable' and a reason
// inside state_json. A missing OT note means we have not seen the theatre record — it does
// not mean there was no operation (D13) — and an absence recorded as a missing ROW would be
// indistinguishable from a stay nobody built.
//
// NO ENGINE BUMP, NO SCHEMA BUMP: IPD stays 'ipd-discharge-audit/0.2', ClinicalState stays
// 'clinical-state/1.2'. This route ALTERs nothing — it cannot touch an audit, a feedback
// row, an episode or a member-state snapshot.
// ⚠️ INFERRED SQL/DDL throughout: this sandbox has no live Neon.

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS clinical_states (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      doc_kind        TEXT NOT NULL,
      source_uid      TEXT NOT NULL,
      member_uid      TEXT,
      encounter_ref   TEXT,
      schema_version  TEXT NOT NULL,
      status          TEXT NOT NULL,
      state_json      JSONB NOT NULL
    )`;
    steps.create_clinical_states = 'ok';
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS clinical_states_doc_idx
      ON clinical_states (doc_kind, source_uid, schema_version)`;
    steps.doc_unique_index = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS clinical_states_encounter_idx
      ON clinical_states (encounter_ref, schema_version)`;
    steps.encounter_index = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS clinical_states_member_idx
      ON clinical_states (member_uid, schema_version)`;
    steps.member_index = 'ok';
    const counts = await libraryCounts();
    steps.rows = String(counts.total);
    steps.by_kind = JSON.stringify(counts.byKind);
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
