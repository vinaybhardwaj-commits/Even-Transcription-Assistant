import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const runtime = 'nodejs';

// Creates the opd_note_audits table (M2). Idempotent. Mirrors migrations/0007_opd_note_audits.sql.
// Auth: ADMIN_TOKEN (Bearer / ?token=) OR a logged-in admin session cookie — so the migration
// can be run one-click from the dashboard without handling the token (like the Re-audit button).
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS opd_note_audits (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      audited_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source           TEXT NOT NULL DEFAULT 'standalone',
      uid                  TEXT NOT NULL,
      consult_uid          TEXT,
      doctor_uid           TEXT,
      kx_encounter_id      TEXT,
      note_date            TIMESTAMPTZ,
      prescription_type    TEXT,
      consult_type         TEXT,
      de_identified        BOOLEAN NOT NULL DEFAULT TRUE,
      note_quality_index   INT NOT NULL,
      band                 TEXT NOT NULL,
      score_documentation       INT,
      score_note_quality        INT,
      score_appropriateness     INT,
      score_prescribing_safety  INT,
      score_patient_centred     INT,
      pdqi9                JSONB,
      completeness_pct     INT,
      n_missing_mandatory  INT,
      n_findings           INT NOT NULL DEFAULT 0,
      n_low_value          INT NOT NULL DEFAULT 0,
      n_context_dependent  INT NOT NULL DEFAULT 0,
      n_interaction_alerts INT NOT NULL DEFAULT 0,
      findings             JSONB,
      suggestions          JSONB,
      engine_version       TEXT NOT NULL DEFAULT 'opd-note-audit/0.1',
      model                TEXT,
      trace_id             TEXT,
      latency_ms           INT
    )`;
    steps.table = 'ok';
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS opd_note_audits_uid_engine_uq ON opd_note_audits (uid, engine_version)`;
    await sql`CREATE INDEX IF NOT EXISTS opd_note_audits_note_date_idx ON opd_note_audits (note_date DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS opd_note_audits_doctor_idx ON opd_note_audits (doctor_uid)`;
    await sql`CREATE INDEX IF NOT EXISTS opd_note_audits_band_idx ON opd_note_audits (band)`;
    await sql`CREATE INDEX IF NOT EXISTS opd_note_audits_consult_type_idx ON opd_note_audits (consult_type)`;
    steps.indexes = 'ok';
    // v0.2 — persist the specific missing NABH-OPD fields so the dashboard can show an
    // exact documentation-gap breakdown (Top issues). Backfilled (no-LLM) for older rows.
    await sql`ALTER TABLE opd_note_audits ADD COLUMN IF NOT EXISTS missing_fields JSONB`;
    steps.missing_fields = 'ok';
    // v0.5 — persist the numbered CDMSS corpus Sources retrieved for the audit, so the case
    // view can show first-class citations (clickable PMID) + a Sources panel like Right Care.
    await sql`ALTER TABLE opd_note_audits ADD COLUMN IF NOT EXISTS sources JSONB`;
    steps.sources = 'ok';
    // #1 — auditor/care-manager feedback on an audit, captured in the comparison screen.
    // Anonymous by default (author optional); verdict ∈ agree|disagree|needs_action; one row per comment.
    await sql`CREATE TABLE IF NOT EXISTS opd_audit_feedback (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source  TEXT NOT NULL DEFAULT 'standalone',
      audit_id    UUID NOT NULL,
      uid         TEXT,
      verdict     TEXT,
      comment     TEXT,
      author      TEXT
    )`;
    await sql`CREATE INDEX IF NOT EXISTS opd_audit_feedback_audit_idx ON opd_audit_feedback (audit_id, created_at DESC)`;
    steps.feedback = 'ok';
    // Feedback instrumentation v1.0 (PRD §4.2) — per-finding triage + note-level missed capture.
    // Additive: legacy rows default to scope='audit' and read exactly as before. finding_ref is set
    // for scope='finding'; signal_type is denormalised for batch analytics. Current state = latest
    // row per (audit_id, finding_ref). Must run BEFORE the new route/page deploy (inserts of the new
    // columns fail otherwise — the known column-add gotcha).
    await sql`ALTER TABLE opd_audit_feedback ADD COLUMN IF NOT EXISTS scope       TEXT NOT NULL DEFAULT 'audit'`;
    await sql`ALTER TABLE opd_audit_feedback ADD COLUMN IF NOT EXISTS finding_ref TEXT`;
    await sql`ALTER TABLE opd_audit_feedback ADD COLUMN IF NOT EXISTS signal_type TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS opd_audit_feedback_finding_idx ON opd_audit_feedback (finding_ref, created_at DESC)`;
    steps.feedback_instrumentation = 'ok';
    // Gold-Label Review-Mode v1.0 (§3, Feature D) — the ONE additive column this build needs.
    // `category` carries the missed-finding category (§1.6 whitelist, validated in opd-feedback-core).
    // Impact tags reuse (scope='impact', verdict) — no column. Run BEFORE the new route/UI deploy
    // (an insert of `category` fails otherwise — the known column-add gotcha).
    await sql`ALTER TABLE opd_audit_feedback ADD COLUMN IF NOT EXISTS category TEXT`;
    steps.feedback_category = 'ok';
    // Feedback study filter (§8, 1 Aug 2026) — the ONE additive column this build needs. `study`
    // names the labelling study a row belongs to; NULL = production. Every production read filters
    // `study IS NOT DISTINCT FROM NULL` so study rows can never contaminate rollups, learning or the
    // clinician-facing pages (three D12-allowlisted activity reads stay unfiltered, commented at the
    // read). Run BEFORE the new route/UI deploy — reads AND writes both fail on the missing column
    // otherwise (the known column-add gotcha).
    await sql`ALTER TABLE opd_audit_feedback ADD COLUMN IF NOT EXISTS study TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS opd_audit_feedback_study_idx ON opd_audit_feedback (study, created_at DESC)`;
    steps.feedback_study = 'ok';
    // Right Care indicator v1 (RIGHT-CARE-INDICATOR-PRD §6). Additive, engine 0.81.3 is metadata-only.
    // complexity_band + complexity_inputs are computed at audit time (NULL = unbanded; backfilled by
    // /api/admin/complexity-backfill). lvc_recommendations gains category + plain_rationale (Branch 2 seeds).
    await sql`ALTER TABLE opd_note_audits ADD COLUMN IF NOT EXISTS complexity_band   TEXT`;
    await sql`ALTER TABLE opd_note_audits ADD COLUMN IF NOT EXISTS complexity_inputs JSONB`;
    await sql`CREATE INDEX IF NOT EXISTS opd_note_audits_complexity_idx ON opd_note_audits (complexity_band)`;
    await sql`ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS category        TEXT`;
    await sql`ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS plain_rationale TEXT`;
    steps.right_care = 'ok';
    // Right Care Branch 2 seeds (RIGHT-CARE-INDICATOR-PRD §7 / decisions 15 + plain_rationale seeding).
    // Both idempotent + isolated (their own try) so a seed hiccup never fails the schema migration.
    try {
      // (15) house-account exclusion list — DO NOTHING preserves any later hand-edit by V.
      await sql`INSERT INTO app_settings (key, value)
                VALUES ('right_care_doctor_exclusions', '["jE0Io6Y1Nh3E7OkbxcLY"]')
                ON CONFLICT (key) DO NOTHING`;
      steps.rc_exclusions_seed = 'ok';
    } catch (e) { steps.rc_exclusions_seed = `err: ${String((e as Error).message).slice(0, 80)}`; }
    try {
      // plain_rationale seed: one line per rule DERIVED from its own `statement` text (real content,
      // never hallucinated), only where NULL → idempotent. V reviews/refines as a data UPDATE (§7).
      const seeded = (await sql`
        UPDATE lvc_recommendations
           SET plain_rationale = left(btrim(statement), 240)
         WHERE plain_rationale IS NULL AND statement IS NOT NULL AND btrim(statement) <> ''
         RETURNING id`) as Array<{ id: string }>;
      steps.plain_rationale_seed = `seeded ${seeded.length}`;
    } catch (e) { steps.plain_rationale_seed = `err: ${String((e as Error).message).slice(0, 80)}`; }
    // Data-Quality Fix C (decision 1): retro-flag the 166 house-account audits (KEEP + EXCLUDE) and
    // make EVERY user-facing read filter `excluded_reason IS NULL`. Additive + idempotent.
    await sql`ALTER TABLE opd_note_audits ADD COLUMN IF NOT EXISTS excluded_reason TEXT`;
    const flagged = (await sql`
      UPDATE opd_note_audits SET excluded_reason = 'house_account'
       WHERE doctor_uid = ANY(ARRAY['jE0Io6Y1Nh3E7OkbxcLY','0bNLwwdtvCy8xw5w11VY','iyoFsE8BSNtp3wDfwyQP','Wa0ItOcg2VAOerUbwGa3','6lBF0FPc03eNhrxgrCV6','DzuoUgxvw3NXZgo3P7T2','v1OyiGME6gQpWt0nQOWm'])
         AND excluded_reason IS NULL
       RETURNING id`) as Array<{ id: string }>;
    steps.excluded_reason = `flagged ${flagged.length}`;
    const cols = (await sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'opd_note_audits'`) as Array<{ n: number }>;
    steps.columns = String(cols[0]?.n ?? 0);
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
