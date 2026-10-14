import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const runtime = 'nodejs';

// Creates the readmission_findings table (Readmission Agent Phase 1 — PRD
// CDMSS-READMISSION-AGENT-PRD-v0.7 §10). Additive + idempotent; mirrors
// migrate-ipd-audits. Auth: ADMIN_TOKEN (Bearer / ?token=) OR admin session.
//
// One row per detected readmission finding, keyed by the PRD §8d dedup key:
// Even→Even = index|readmit encounter ids; out-of-network = index|form:<uid>.
// UPSERT on (dedup_key, engine_version). PHI posture (§8b): the row carries
// uhid/encounter ids as LINK-BACK keys only — never a patient name, never a raw
// document; `finding` is the de-identified reconciliation output.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS readmission_findings (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      audited_at            TIMESTAMPTZ,
      app_source            TEXT NOT NULL DEFAULT 'standalone',
      dedup_key             TEXT NOT NULL,
      engine_version        TEXT NOT NULL DEFAULT 'readmission/0.1',
      finding_class         TEXT NOT NULL,
      index_encounter_id    TEXT NOT NULL,
      readmit_encounter_id  TEXT,
      form_uid              TEXT,
      uhid                  TEXT,
      member_uid            TEXT,
      lane                  TEXT NOT NULL,
      tags                  JSONB,
      gap_days              INT,
      index_department      TEXT,
      readmit_department    TEXT,
      index_doctor          TEXT,
      readmit_doctor        TEXT,
      index_discharge_at    TIMESTAMPTZ,
      readmit_admit_at      TIMESTAMPTZ,
      payer_index           TEXT,
      payer_readmit         TEXT,
      cm_note               TEXT,
      form_is_planned       BOOLEAN,
      form_same_condition   BOOLEAN,
      audit_status          TEXT NOT NULL DEFAULT 'detected',
      not_auditable_reason  TEXT,
      planned               TEXT,
      same_condition        TEXT,
      avoidable             TEXT,
      lab_timing_profile    TEXT,
      n_omissions           INT NOT NULL DEFAULT 0,
      needs_human_review    BOOLEAN,
      promoted_to_full      BOOLEAN NOT NULL DEFAULT FALSE,
      finding               JSONB,
      attempts              INT NOT NULL DEFAULT 0,
      last_error            TEXT,
      model                 TEXT,
      provider              TEXT,
      trace_id              TEXT
    )`;
    steps.create_table = 'ok';
    // Phase 1.5 (substrate addendum §5) — additive + idempotent. The coverage tier the
    // finding was built under, what its labs actually came from, and the omission
    // evidence rows, each as its own column so a reviewer can filter without opening
    // every `finding` blob. Safe on a table that already holds Phase-1 rows: existing
    // rows simply carry NULL until they are re-audited.
    await sql`ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS lab_tier TEXT`;
    await sql`ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS lab_source_provenance JSONB`;
    await sql`ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS omission_evidence JSONB`;
    steps.phase15_columns = 'ok';
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS readmission_findings_key_engine_uq ON readmission_findings (dedup_key, engine_version)`;
    steps.unique_key_engine = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS readmission_findings_lane_idx ON readmission_findings (lane)`;
    await sql`CREATE INDEX IF NOT EXISTS readmission_findings_status_idx ON readmission_findings (audit_status)`;
    await sql`CREATE INDEX IF NOT EXISTS readmission_findings_readmit_at_idx ON readmission_findings (readmit_admit_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS readmission_findings_index_enc_idx ON readmission_findings (index_encounter_id)`;
    await sql`CREATE INDEX IF NOT EXISTS readmission_findings_lab_tier_idx ON readmission_findings (lab_tier)`;
    steps.indexes = 'ok';
    const counts = (await sql`SELECT count(*)::int AS n FROM readmission_findings`) as Array<{ n: number }>;
    steps.rows = String(counts[0]?.n ?? 0);
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
