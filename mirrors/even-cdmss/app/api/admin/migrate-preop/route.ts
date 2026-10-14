import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { PREOP_ENGINE_VERSION } from '@/lib/preop/store';

export const runtime = 'nodejs';

// Creates the Pre-op Risk Agent's tables (PRD CDMSS-PREOP-RISK-AGENT-v1.1-LOCKED §5/§6,
// Build Plan B1; reference DDL in migrations/0042_preop_risk.sql). Additive + idempotent;
// mirrors migrate-readmissions / migrate-readmission-versions.
// Auth: ADMIN_TOKEN (Bearer / ?token=) OR admin session.
//
//   preop_findings         — ONE live row per surgical episode, keyed
//                            (episode_key, engine_version) where episode_key is
//                            surgery_cases._doc_id. Holds the current snapshot as jsonb
//                            plus scalar copies of everything the board filters or sorts
//                            on, so a reader never has to open a blob to build a card.
//   preop_finding_versions — append-only history, one row per READING that was replaced
//                            ('overwrite') or deliberately re-run ('replay'). This table
//                            IS the mockup's snapshot timeline (readmissions R8.1 rail).
//   preop_sweeps           — one row per worker tick. ⚠️ A THIRD table, beyond the two
//                            the Build Plan names, and flagged for V: the board's "last
//                            sweep 14:00 IST" stamp has to come from somewhere, and the
//                            only alternative — touching every finding row every tick —
//                            would destroy the "second tick writes nothing" guarantee
//                            that the B2 idempotency gate is measured against.
//
// NO GRANTS, deliberately. The house rule puts grants in migrations because the
// migration runner is the only owner-privileged path on Vercel — but every sibling table
// here (readmission_findings, readmission_finding_versions, ipd_audits, …) is created by
// and read through the SAME DATABASE_URL role, and none of their migrations issues a
// grant. Inventing a grantee name would be a guess that fails the migration outright. If
// V's Neon has a separate reader role for this surface, the GRANT belongs in this file.
//
// ⚠️ INFERRED SQL/DDL throughout: this sandbox has no live Neon. Proven by running it.

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS preop_findings (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source           TEXT NOT NULL DEFAULT 'standalone',
      episode_key          TEXT NOT NULL,
      engine_version       TEXT NOT NULL DEFAULT 'preop-risk/0.1',
      individual_uid       TEXT,
      uhid                 TEXT,
      patient_name         TEXT,
      age                  INT,
      sex                  TEXT,
      procedure            TEXT,
      hospital             TEXT,
      department           TEXT,
      surgeon              TEXT,
      surgery_date         DATE,
      tier                 TEXT,
      rcri_lo              INT,
      rcri_hi              INT,
      mfi_lo               INT,
      mfi_hi               INT,
      cci_lo               INT,
      cci_hi               INT,
      needs_review         BOOLEAN NOT NULL DEFAULT FALSE,
      booking_only         BOOLEAN NOT NULL DEFAULT FALSE,
      pac_on_file          BOOLEAN NOT NULL DEFAULT FALSE,
      pac_status           TEXT,
      pac_report_uid       TEXT,
      pac_finalized_at     TIMESTAMPTZ,
      pac_verdict          TEXT,
      why_line             TEXT,
      missing_line         TEXT,
      situation_line       TEXT,
      snapshot             JSONB NOT NULL,
      snapshot_fingerprint TEXT NOT NULL,
      version_no           INT NOT NULL DEFAULT 1,
      reviewed_at          TIMESTAMPTZ,
      reviewed_by          TEXT,
      reviewed_version     INT,
      computed_at          TIMESTAMPTZ,
      trace_id             TEXT
    )`;
    steps.create_findings = 'ok';
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS preop_findings_key_engine_uq
      ON preop_findings (episode_key, engine_version)`;
    await sql`CREATE INDEX IF NOT EXISTS preop_findings_surgery_idx
      ON preop_findings (engine_version, surgery_date)`;
    await sql`CREATE INDEX IF NOT EXISTS preop_findings_tier_idx ON preop_findings (tier)`;
    await sql`CREATE INDEX IF NOT EXISTS preop_findings_review_idx
      ON preop_findings (needs_review, surgery_date)`;
    await sql`CREATE INDEX IF NOT EXISTS preop_findings_individual_idx ON preop_findings (individual_uid)`;
    steps.findings_indexes = 'ok';
    // B4 (Amendment A1-3): the booking workflow's own PAC state, beside — never instead
    // of — the bridged report. Additive and nullable; deliberately OUTSIDE the snapshot
    // fingerprint, so the sweep refreshes these two columns without minting a version.
    await sql`ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS pac_workflow_status TEXT`;
    await sql`ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS pac_workflow_logged_at TIMESTAMPTZ`;
    steps.b4_pac_workflow_columns = 'ok';
    // B5 + B6 (reference DDL: migrations/0043_preop_rails.sql). The two LLM rails'
    // artefacts, each in its own column and each deliberately OUTSIDE the snapshot
    // fingerprint — so neither rail can mint a snapshot version merely by existing, and
    // the flag-off/flag-on score-equality proof is a property of the schema, not of care.
    //   extraction_*  the stored reading + the fingerprint OF ITS SOURCE TEXT. That
    //                 fingerprint is the anti-flap key: unchanged text ⇒ the stored
    //                 reading is reused verbatim and no model runs at all.
    //   narrative_*   the stored prose + the SNAPSHOT fingerprint it was written for, so
    //                 a narrative that has fallen behind its score is detectable rather
    //                 than merely old, and `narrative_valid` records CODE's verdict on
    //                 citation integrity (an invalid narrative is kept for review and
    //                 never rendered).
    // Additive and nullable throughout; every existing row reads NULL and behaves as it
    // did before the columns existed.
    await sql`ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS extraction JSONB`;
    await sql`ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS extraction_fingerprint TEXT`;
    await sql`ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS extraction_model TEXT`;
    await sql`ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS extraction_provider TEXT`;
    await sql`ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMPTZ`;
    await sql`ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS narrative JSONB`;
    await sql`ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS narrative_fingerprint TEXT`;
    await sql`ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS narrative_model TEXT`;
    await sql`ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS narrative_provider TEXT`;
    await sql`ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS narrative_at TIMESTAMPTZ`;
    await sql`ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS narrative_valid BOOLEAN`;
    steps.b5_b6_rail_columns = 'ok';
    // B8b (reference DDL: migrations/0044_preop_suggestions.sql). Every Confirm and every
    // Dismiss a clinician makes on the case page. Two jobs, and both matter:
    //   · OPERATIONAL — the sweep re-reads this table and turns each confirm into a HUMAN
    //     observation, which is what makes a confirmation durable across recomputes. It is
    //     bound to the SOURCE FINGERPRINT the suggestion was made against, so an edited note
    //     retires the confirmation instead of silently carrying it onto text nobody read.
    //   · EVIDENTIAL — this is the gold-label store the B8d promotion gate reads. A field
    //     class earns `score` mode by accumulating decisions here with measured precision.
    // Append-only: a later decision supersedes an earlier one at READ time (DISTINCT ON),
    // so the record of somebody changing their mind survives.
    await sql`CREATE TABLE IF NOT EXISTS preop_suggestion_decisions (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      decided_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source         TEXT NOT NULL DEFAULT 'standalone',
      episode_key        TEXT NOT NULL,
      engine_version     TEXT NOT NULL,
      input_id           TEXT NOT NULL,
      status             TEXT NOT NULL,
      span               TEXT,
      field              TEXT,
      decision           TEXT NOT NULL,
      decided_by         TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL
    )`;
    await sql`CREATE INDEX IF NOT EXISTS preop_suggestion_decisions_episode_idx
      ON preop_suggestion_decisions (engine_version, episode_key, input_id, source_fingerprint, decided_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS preop_suggestion_decisions_class_idx
      ON preop_suggestion_decisions (engine_version, input_id, decision, decided_at DESC)`;
    steps.b8_decisions = 'ok';

    await sql`CREATE TABLE IF NOT EXISTS preop_finding_versions (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      captured_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source           TEXT NOT NULL DEFAULT 'standalone',
      capture_reason       TEXT NOT NULL,
      episode_key          TEXT NOT NULL,
      engine_version       TEXT NOT NULL,
      version_no           INT,
      tier                 TEXT,
      rcri_lo              INT,
      rcri_hi              INT,
      mfi_lo               INT,
      mfi_hi               INT,
      cci_lo               INT,
      cci_hi               INT,
      snapshot_fingerprint TEXT,
      capture_note         TEXT,
      computed_at          TIMESTAMPTZ,
      row_snapshot         JSONB NOT NULL,
      trace_id             TEXT
    )`;
    steps.create_versions = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS preop_finding_versions_key_idx
      ON preop_finding_versions (episode_key, engine_version, captured_at ASC)`;
    await sql`CREATE INDEX IF NOT EXISTS preop_finding_versions_reason_idx
      ON preop_finding_versions (capture_reason, captured_at DESC)`;
    steps.versions_indexes = 'ok';

    await sql`CREATE TABLE IF NOT EXISTS preop_sweeps (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ran_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source     TEXT NOT NULL DEFAULT 'standalone',
      engine_version TEXT NOT NULL,
      episodes       INT NOT NULL DEFAULT 0,
      inserted       INT NOT NULL DEFAULT 0,
      updated        INT NOT NULL DEFAULT 0,
      unchanged      INT NOT NULL DEFAULT 0,
      skipped        INT NOT NULL DEFAULT 0,
      by_tier        JSONB,
      pac_linked     INT NOT NULL DEFAULT 0,
      ms             INT NOT NULL DEFAULT 0,
      notes          TEXT
    )`;
    await sql`CREATE INDEX IF NOT EXISTS preop_sweeps_engine_idx
      ON preop_sweeps (engine_version, ran_at DESC)`;
    // B4: the board's degraded strip needs the fault list as data, not as prose parsed
    // back out of `notes`. Additive and nullable — existing heartbeat rows carry NULL.
    await sql`ALTER TABLE preop_sweeps ADD COLUMN IF NOT EXISTS degraded_sources JSONB`;
    steps.create_sweeps = 'ok';

    const f = (await sql`SELECT count(*)::int AS n FROM preop_findings`) as Array<{ n: number }>;
    const v = (await sql`SELECT count(*)::int AS n FROM preop_finding_versions`) as Array<{ n: number }>;
    const s = (await sql`SELECT count(*)::int AS n FROM preop_sweeps`) as Array<{ n: number }>;
    const r = (await sql`SELECT count(*) FILTER (WHERE extraction IS NOT NULL)::int AS ex,
                                count(*) FILTER (WHERE narrative IS NOT NULL)::int AS na
                           FROM preop_findings`) as Array<{ ex: number; na: number }>;
    steps.rows = `findings ${f[0]?.n ?? 0} · versions ${v[0]?.n ?? 0} · sweeps ${s[0]?.n ?? 0}`;
    steps.rails = `extractions ${r[0]?.ex ?? 0} · narratives ${r[0]?.na ?? 0}`;
    const dcount = (await sql`SELECT count(*)::int AS n FROM preop_suggestion_decisions`) as Array<{ n: number }>;
    steps.decisions = `suggestion decisions ${dcount[0]?.n ?? 0}`;
    return NextResponse.json({ ok: true, engine: PREOP_ENGINE_VERSION, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
