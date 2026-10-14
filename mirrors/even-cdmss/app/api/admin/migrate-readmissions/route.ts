import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { deriveJudgements, JUDGEMENT_RULE_VERSION, type JudgementInput } from '@/lib/readmission-reconcile-core';
import { READMIT_ENGINE_VERSION } from '@/lib/readmission/store';

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
//
// R1 (CDMSS-READMISSIONS-R1-PRD v1.1 §5, 17 Aug 2026): three additive columns —
// preventable_injury, negligence, judgement_rule_version — plus a VERSIONED, idempotent
// backfill that re-derives both judgements from the `finding` jsonb in JS for every
// audited row that is missing them or was stamped under an older rule version. Batched
// ≤ 200 per request; re-run until `remaining` is 0. A future rule change bumps
// JUDGEMENT_RULE_VERSION and the same step re-derives — nothing goes silently stale.
// ⚠️ INFERRED SQL/DDL throughout: this sandbox has no live Neon.

const BACKFILL_BATCH = 200;

/** jsonb tolerance — Neon usually parses, a TEXT round trip does not. */
function asBlob(v: unknown): JudgementInput | null {
  if (v == null) return null;
  if (typeof v === 'object') return v as JudgementInput;
  if (typeof v === 'string') { try { return JSON.parse(v) as JudgementInput; } catch { return null; } }
  return null;
}

/**
 * One backfill batch. Rows are selected by the STALENESS predicate, ENGINE-SCOPED to the
 * current READMIT_ENGINE_VERSION (R2-5): rows orphaned by an engine bump are never
 * rescanned — the surface and the badge cannot see them, so re-deriving them is wasted
 * work. A row whose blob cannot be read still gets 'unknown'/'unknown' — that is the
 * rule's own answer for "nothing to read", and stamping the version keeps the batch from
 * revisiting it forever.
 */
async function backfillJudgements(): Promise<{ scanned: number; updated: number; remaining: number; ruleVersion: string; engineVersion: string }> {
  const rows = (await sql(
    `SELECT id, finding FROM readmission_findings
      WHERE audit_status = 'audited'
        AND engine_version = $2
        AND (preventable_injury IS NULL OR negligence IS NULL
             OR judgement_rule_version IS DISTINCT FROM $1)
      ORDER BY audited_at ASC NULLS LAST
      LIMIT ${BACKFILL_BATCH}`,
    [JUDGEMENT_RULE_VERSION, READMIT_ENGINE_VERSION],
  )) as Array<{ id: string; finding: unknown }>;
  let updated = 0;
  for (const r of rows) {
    const j = deriveJudgements(asBlob(r.finding));
    const out = (await sql(
      `UPDATE readmission_findings
          SET preventable_injury = $2, negligence = $3, judgement_rule_version = $4
        WHERE id = $1
        RETURNING id`,
      [r.id, j.preventableInjury, j.negligence, JUDGEMENT_RULE_VERSION],
    )) as Array<{ id: string }>;
    if (out.length) updated++;
  }
  const rem = (await sql(
    `SELECT count(*)::int AS n FROM readmission_findings
      WHERE audit_status = 'audited'
        AND engine_version = $2
        AND (preventable_injury IS NULL OR negligence IS NULL
             OR judgement_rule_version IS DISTINCT FROM $1)`,
    [JUDGEMENT_RULE_VERSION, READMIT_ENGINE_VERSION],
  )) as Array<{ n: number }>;
  return { scanned: rows.length, updated, remaining: Number(rem[0]?.n ?? 0), ruleVersion: JUDGEMENT_RULE_VERSION, engineVersion: READMIT_ENGINE_VERSION };
}

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
    // R1 (PRD v1.1 §5) — additive + idempotent, nullable. Existing rows carry NULL until
    // the backfill below (or a fresh audit) writes them.
    await sql`ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS preventable_injury TEXT`;
    await sql`ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS negligence TEXT`;
    await sql`ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS judgement_rule_version TEXT`;
    steps.r1_judgement_columns = 'ok';
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
    // R1 versioned backfill — one batch per request, idempotent, re-run until remaining = 0.
    const backfill = await backfillJudgements();
    steps.r1_judgement_backfill = `scanned ${backfill.scanned}, updated ${backfill.updated}, remaining ${backfill.remaining} @ ${backfill.ruleVersion} (engine ${backfill.engineVersion})`;
    return NextResponse.json({ ok: true, steps, backfill });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
