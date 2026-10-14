import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const runtime = 'nodejs';

// Creates the R10-B retrieved-artefact store (Readmissions R10 — PRD
// CDMSS-READMISSIONS-R10-RECORD-REACH-PRD-27-AUG-2026-GO §4.2, R10-D6 / R10-D7; migration number
// 0048; a reference copy of this DDL sits in migrations/0048_readmission_retrieved_artefacts.sql).
// Additive + idempotent; mirrors migrate-readmission-ask. Auth: ADMIN_TOKEN (Bearer / ?token=) OR
// an admin session.
//
// ONE TABLE, TWO UNIQUE KEYS, and both earn their place (R10-D7):
//   (dedup_key, engine_version, artefact_id)  — a citation resolves to ONE artefact, for ever;
//   (dedup_key, engine_version, source_key)   — an artefact is bound to ONE id, for ever.
// Together with saveRetrievedArtefact's ON CONFLICT DO NOTHING they make FIRST FETCH WIN: a stored
// artefact is never rewritten, so re-fetch drift mid-thread is not a policy but an impossibility.
//
// NO ENGINE BUMP: READMIT_ENGINE_VERSION stays 'readmission/0.2'. Nothing detected, audited or
// scored changes; existing rows and existing threads are untouched, and before this runs the Ask box
// simply has no retrieved-record memory (the `X…` namespace resolves nothing, so an uncited
// whole-record claim is WITHHELD — the citation gate degrades closed).
// ⚠️ INFERRED SQL/DDL throughout: this sandbox has no live Neon.

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS readmission_retrieved_artefacts (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      dedup_key       TEXT NOT NULL,
      engine_version  TEXT NOT NULL,
      artefact_id     TEXT NOT NULL,
      source_key      TEXT NOT NULL,
      kind            TEXT NOT NULL,
      artefact_date   TEXT,
      label           TEXT NOT NULL DEFAULT '',
      content         TEXT NOT NULL,
      actor           TEXT,
      turn_id         TEXT
    )`;
    steps.create_table = 'ok';
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS readmission_retrieved_artefacts_id_idx
      ON readmission_retrieved_artefacts (dedup_key, engine_version, artefact_id)`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS readmission_retrieved_artefacts_source_idx
      ON readmission_retrieved_artefacts (dedup_key, engine_version, source_key)`;
    steps.unique_indexes = 'ok';
    const counts = (await sql`SELECT count(*)::int AS n FROM readmission_retrieved_artefacts`) as Array<{ n: number }>;
    steps.rows = String(counts[0]?.n ?? 0);
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
