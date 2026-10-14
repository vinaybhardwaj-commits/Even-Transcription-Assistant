import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const runtime = 'nodejs';

/**
 * Creates the three IPD Episode Audit tables (PRD §7). Mirrors
 * migrations/0052_ipd_episode_audits.sql byte-for-byte in intent; the .sql file is the reference
 * copy, this route is the executable path, because `migrations/` is not bundled into the Vercel
 * serverless function.
 *
 * ⚠️ REPEATABLE, BUT NO LONGER PURELY ADDITIVE — AND THIS HEADER USED TO SAY OTHERWISE.
 *
 * It read "Idempotent — every statement is IF NOT EXISTS, so running it twice is a no-op". That
 * stopped being true in round 17, when `DROP COLUMN IF EXISTS de_identified` was added, and the
 * sentence sat directly above it for two rounds telling every reader the route could not destroy
 * anything. A header that grants that assurance falsely is worse than no header, because it is
 * read instead of the code.
 *
 * What is true: every statement is safe to REPEAT — running it twice does the same as running it
 * once — but one of them REMOVES something the first time it runs. See the note at the DROP
 * itself (search `DROP COLUMN IF EXISTS`, around line 143) for what it removes and why nothing
 * depends on it. Any future DROP carries its own note there, and this paragraph stays.
 *
 * Auth is the shipped pattern: ADMIN_TOKEN (Bearer / ?token=) OR a logged-in admin session.
 *
 * ⚠️ THIS IS THE ROUTE V MUST RUN before the worker writes anything:
 *     POST /api/admin/migrate-ipd-episode-audits   (on the preview deployment)
 * Preview and Production share DATABASE_URL, so it writes to the real Neon database.
 */
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS ipd_episode_audits (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      audited_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source            TEXT NOT NULL DEFAULT 'standalone',
      engine_version        TEXT NOT NULL,
      run_seq               INTEGER NOT NULL DEFAULT 1,
      is_current            BOOLEAN NOT NULL DEFAULT TRUE,
      encounter_id          TEXT NOT NULL,
      ip_uid                TEXT NOT NULL,
      member_id             TEXT,
      facility_name         TEXT,
      speciality            TEXT,
      admitted_at           TIMESTAMPTZ,
      discharged_at         TIMESTAMPTZ,
      los_days              INTEGER,
      discharge_type        TEXT,
      extraction_version    TEXT,
      divergence_index      INTEGER,
      divergence_band       TEXT,
      band_uncertain        BOOLEAN DEFAULT FALSE,
      scoring_status        TEXT NOT NULL DEFAULT 'ok',
      completeness_pct      INTEGER DEFAULT 0,
      n_findings            INTEGER DEFAULT 0,
      n_divergence_pass     INTEGER DEFAULT 0,
      n_fidelity_pass       INTEGER DEFAULT 0,
      n_omission            INTEGER DEFAULT 0,
      n_commission          INTEGER DEFAULT 0,
      n_timing              INTEGER DEFAULT 0,
      n_sequencing          INTEGER DEFAULT 0,
      n_divergent           INTEGER DEFAULT 0,
      n_context_dependent   INTEGER DEFAULT 0,
      n_unassessable        INTEGER DEFAULT 0,
      n_concordant          INTEGER DEFAULT 0,
      n_low_value           INTEGER DEFAULT 0,
      n_dropped_invalid     INTEGER DEFAULT 0,
      n_parse_failed        INTEGER DEFAULT 0,
      n_unassessable_rejected INTEGER DEFAULT 0,
      n_judged_omissions_dropped INTEGER DEFAULT 0,
      n_findings_truncated  INTEGER DEFAULT 0,
      -- ROUND 12 ITEM 2. Both halves of the grouping, always: how many resolver findings
      -- are PRESENTED, and how many expected-course entries they stand for. One without
      -- the other either hides the collapse or describes an episode nobody is shown.
      n_resolver_grouped    INTEGER DEFAULT 0,
      n_resolver_ungrouped  INTEGER DEFAULT 0,
      judge_temperature     DOUBLE PRECISION,
      resolution_counts     JSONB,
      capped_count          INTEGER DEFAULT 0,
      checkpoint_policy     TEXT DEFAULT 'standard',
      checkpoint_concurrency INTEGER,
      checkpoint_wall_ms    INTEGER,
      prompt_events         INTEGER,
      assembled_events      INTEGER,
      diff_prompt_chars     INTEGER,
      digest_entries        INTEGER,
      penalty_total         INTEGER DEFAULT 0,
      expectations_evaluated INTEGER DEFAULT 0,
      stage_timings         JSONB,
      checkpoint_count      INTEGER DEFAULT 0,
      evidence_tiers        JSONB,
      real_course           JSONB,
      findings              JSONB,
      -- ROUND 12 / DECISION 35. Commentary is generated ON DEMAND now, the first time an episode's
      -- detail page is opened, so pass B runs long after the pipeline has exited and cannot rebuild
      -- its own inputs from memory. Everything else it needs is already on this row or on the
      -- checkpoint rows; the admission context was the one input built during assembly and never
      -- persisted. NULL commentary is a normal, complete, scorable episode — never a failure.
      admission_context     TEXT,
      commentary            JSONB,
      model_checkpoint      TEXT,
      model_judge           TEXT,
      trace_id              TEXT,
      error_detail          TEXT,
      raw_judge_error       JSONB
    )`;
    steps.audits_table = 'ok';

    // ── repairs for a table an earlier run of this route already created ──────────────────────
    // CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so every column and default
    // added after the first successful run has to be applied explicitly. Same shape as the 0014
    // `report` column added to ipd_discharge_audits. All of this is idempotent.
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS error_detail TEXT`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS raw_judge_error JSONB`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS n_parse_failed INTEGER DEFAULT 0`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS scoring_status TEXT NOT NULL DEFAULT 'ok'`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS capped_count INTEGER DEFAULT 0`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS n_unassessable_rejected INTEGER DEFAULT 0`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS n_judged_omissions_dropped INTEGER DEFAULT 0`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS judge_temperature DOUBLE PRECISION`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS resolution_counts JSONB`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS divergence_band TEXT`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS band_uncertain BOOLEAN DEFAULT FALSE`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS checkpoint_policy TEXT DEFAULT 'standard'`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS checkpoint_concurrency INTEGER`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS checkpoint_wall_ms INTEGER`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS prompt_events INTEGER`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS assembled_events INTEGER`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS diff_prompt_chars INTEGER`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS digest_entries INTEGER`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS penalty_total INTEGER DEFAULT 0`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS expectations_evaluated INTEGER DEFAULT 0`;
    // ⚠️⚠️ THE ONLY DESTRUCTIVE STATEMENT IN THIS ROUTE, AND IT IS DELIBERATE (round 17 item 5,
    // acknowledged explicitly in round 18 item 3).
    //
    // Everything else here is additive — CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
    // SET DEFAULT — and can be run any number of times against any state without losing anything.
    // This one DROPS A COLUMN, irreversibly, on EVERY invocation. A reader skimming the route is
    // entitled to assume it cannot destroy data; from this line on, that assumption is wrong, so
    // the justification is written here rather than left to be inferred:
    //
    //   · `de_identified` was BOOLEAN DEFAULT TRUE and the pipeline never wrote it, so every row
    //     carried TRUE regardless of what ran — it asserted nothing that could be false.
    //   · Nothing reads it. No view, no index, no query in this repo, no UI field.
    //   · It read TRUE throughout the period when `real_course` carried a theatre assistant's name
    //     in an OT note (round 14 item 9), so the one claim it made was the one that was untrue.
    //
    // No row therefore loses a value anyone chose or could have checked. If a future column needs
    // dropping, it gets its own note like this one — a DROP must never appear here unexplained.
    await sql`ALTER TABLE ipd_episode_audits DROP COLUMN IF EXISTS de_identified`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS stage_timings JSONB`;
    await sql`ALTER TABLE ipd_episode_audits ALTER COLUMN app_source SET DEFAULT 'standalone'`;
    steps.audits_columns = 'ok';

    // DEFAULT 0 on every counted column (see the DDL note): a null counter is not "zero findings",
    // it is "unknown", and it makes an aggregate skip the row instead of counting it.
    // divergence_index is deliberately absent: it may be NULL under scoring_status
    // 'no_expectations', and a DEFAULT 0 would make "not scorable" indistinguishable from "the
    // worst episode we have ever seen".
    for (const col of [
      'completeness_pct', 'n_findings', 'n_divergence_pass', 'n_fidelity_pass',
      'n_omission', 'n_commission', 'n_timing', 'n_sequencing', 'n_divergent', 'n_context_dependent',
      'n_unassessable', 'n_concordant', 'n_low_value', 'n_dropped_invalid', 'n_parse_failed',
      'capped_count', 'n_unassessable_rejected', 'n_judged_omissions_dropped', 'checkpoint_count',
    ]) {
      // identifier interpolation, not a value: `col` comes from this literal list and never from a
      // request, so there is nothing here for a caller to influence.
      await sql(`ALTER TABLE ipd_episode_audits ALTER COLUMN ${col} SET DEFAULT 0`);
    }
    await sql`ALTER TABLE ipd_episode_audits ALTER COLUMN divergence_index DROP DEFAULT`;
    steps.audits_defaults = 'ok';

    // ── every run is kept (V, 2026-09-02) ────────────────────────────────────────────────────
    // Order matters on an existing table: add the columns, BACKFILL is_current for rows written
    // under the old upsert (each encounter had exactly one row, so every one of them is current
    // and run_seq 1 is correct), THEN drop the old unique index, THEN add the new ones. Dropping
    // first would allow a concurrent writer to create the duplicate the new index then rejects.
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS run_seq INTEGER NOT NULL DEFAULT 1`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT TRUE`;
    await sql`UPDATE ipd_episode_audits SET is_current = TRUE WHERE is_current IS NULL`;
    await sql`DROP INDEX IF EXISTS ipd_episode_audits_encounter_engine_uq`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ipd_episode_audits_encounter_engine_run_uq ON ipd_episode_audits (encounter_id, engine_version, run_seq)`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ipd_episode_audits_current_uq ON ipd_episode_audits (encounter_id, engine_version) WHERE is_current`;
    steps.audits_runs = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS ipd_episode_audits_discharged_idx ON ipd_episode_audits (discharged_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS ipd_episode_audits_speciality_idx ON ipd_episode_audits (speciality)`;
    await sql`CREATE INDEX IF NOT EXISTS ipd_episode_audits_ip_uid_idx ON ipd_episode_audits (ip_uid)`;
    steps.audits_indexes = 'ok';

    await sql`CREATE TABLE IF NOT EXISTS ipd_episode_checkpoints (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      episode_audit_id   UUID REFERENCES ipd_episode_audits(id) ON DELETE CASCADE,
      day_index          INTEGER NOT NULL,
      checkpoint_type    TEXT NOT NULL,
      generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      input_cutoff_at    TIMESTAMPTZ NOT NULL,
      input_event_count  INTEGER,
      retrieval_query    TEXT,
      retrieval_failed   BOOLEAN DEFAULT FALSE,
      citation_ids       INTEGER[],
      expected_course    JSONB,
      status             TEXT,
      error_detail       TEXT,
      model              TEXT,
      trace_id           TEXT,
      uncited_entry_count INTEGER DEFAULT 0,
      entry_count         INTEGER DEFAULT 0,
      citation_sources    JSONB,
      retrieved_titles    TEXT[],
      retrieval_offtopic  BOOLEAN DEFAULT FALSE,
      retrieval_skipped   BOOLEAN DEFAULT FALSE,
      offtopic_excerpt_count INTEGER DEFAULT 0,
      day0_query_from_ot  BOOLEAN DEFAULT FALSE,
      temperature         DOUBLE PRECISION,
      seed                INTEGER,
      max_tokens          INTEGER,
      finish_reason       TEXT,
      attempts            INTEGER DEFAULT 0,
      entries_truncated   INTEGER DEFAULT 0
    )`;
    await sql`CREATE INDEX IF NOT EXISTS ipd_episode_checkpoints_audit_idx ON ipd_episode_checkpoints (episode_audit_id)`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS uncited_entry_count INTEGER DEFAULT 0`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS entry_count INTEGER DEFAULT 0`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS citation_sources JSONB`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS retrieved_titles TEXT[]`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS retrieval_offtopic BOOLEAN DEFAULT FALSE`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS offtopic_excerpt_count INTEGER DEFAULT 0`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS day0_query_from_ot BOOLEAN DEFAULT FALSE`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS temperature DOUBLE PRECISION`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS seed INTEGER`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS retrieval_skipped BOOLEAN DEFAULT FALSE`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS max_tokens INTEGER`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS finish_reason TEXT`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0`;
    await sql`ALTER TABLE ipd_episode_checkpoints ADD COLUMN IF NOT EXISTS entries_truncated INTEGER DEFAULT 0`;
    steps.checkpoints_table = 'ok';

    // ── citation_ids must be INTEGER[] ────────────────────────────────────────────────────────
    // The store inserts `$8::int[]`. If this column were ever created as TEXT[], Postgres would
    // reject every checkpoint INSERT — and that INSERT is inside a catch, so the rows would
    // disappear in silence, taking input_cutoff_at and input_event_count (the blinding proof) with
    // them. This engine has only ever declared INTEGER[], so on any table it created the repair
    // below is a no-op; it exists so a table created by some other hand cannot poison the writer.
    //
    // GUARDED ON THE CATALOGUE so it is genuinely idempotent: an unconditional ALTER TYPE rewrites
    // the whole table on every run. `_int4` is the pg_type name for integer[].
    const citationType = (await sql`
      SELECT a.atttypid::regtype::text AS t
      FROM pg_attribute a
      WHERE a.attrelid = 'ipd_episode_checkpoints'::regclass
        AND a.attname = 'citation_ids' AND a.attnum > 0 AND NOT a.attisdropped
    `) as Array<{ t: string }>;
    const current = citationType[0]?.t ?? 'unknown';
    if (current === 'integer[]') {
      steps.checkpoints_citation_ids = 'integer[] — already correct, no rewrite';
    } else {
      // USING …::text[]::integer[] converts a text[] column elementwise; on an empty table it is
      // trivially safe, and on a populated one it fails loudly rather than dropping data.
      await sql`ALTER TABLE ipd_episode_checkpoints
                ALTER COLUMN citation_ids TYPE INTEGER[] USING citation_ids::text[]::integer[]`;
      steps.checkpoints_citation_ids = `repaired from ${current} to integer[]`;
    }

    await sql`CREATE TABLE IF NOT EXISTS ipd_episode_skips (
      encounter_id    TEXT NOT NULL,
      engine_version  TEXT NOT NULL,
      reason          TEXT NOT NULL,
      first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempts        INTEGER NOT NULL DEFAULT 1,
      discharged_at   TIMESTAMPTZ,
      diagnostics     JSONB,
      detail          TEXT,
      PRIMARY KEY (encounter_id, engine_version)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS ipd_episode_skips_discharged_idx ON ipd_episode_skips (discharged_at DESC)`;
    await sql`ALTER TABLE ipd_episode_skips ADD COLUMN IF NOT EXISTS diagnostics JSONB`;
    await sql`ALTER TABLE ipd_episode_skips ADD COLUMN IF NOT EXISTS detail TEXT`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS n_findings_truncated INTEGER DEFAULT 0`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS n_resolver_grouped INTEGER DEFAULT 0`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS n_resolver_ungrouped INTEGER DEFAULT 0`;
    await sql`ALTER TABLE ipd_episode_audits ADD COLUMN IF NOT EXISTS admission_context TEXT`;
    steps.skips_table = 'ok';

    const counts = (await sql`SELECT count(*)::int AS n FROM ipd_episode_audits`) as Array<{ n: number }>;
    steps.rows = String(counts[0]?.n ?? 0);
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
