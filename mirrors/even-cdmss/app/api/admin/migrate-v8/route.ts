import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// Migration v8 — CALC.1 prep. All additive (no DROP/RENAME). Bundled per §15.5 with
// the calculator code that consumes it.
//
// Adds:
// - user_queries.calculator_meta + pushed_to_context (PRD §6)
// - traces.parent_trace_id + index (PRD §15.3 — extraction/sidebar/Drugs handoff linking)
// - sidebar_cache table (PRD §4.5 + §6 — 7-day-per-user qwen sidebar cache)
// - app_settings table seeded with tooltip_cache_version = '1' (PRD §3.14 + §6)
// - rate_limits table (PRD §15.1 — per-user sliding-window counter)
// - helpful indices
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const steps: Record<string, string> = {};
  try {
    // 1. user_queries extensions
    await sql`ALTER TABLE user_queries ADD COLUMN IF NOT EXISTS calculator_meta JSONB`;
    await sql`ALTER TABLE user_queries ADD COLUMN IF NOT EXISTS pushed_to_context JSONB`;
    steps.user_queries_cols = 'ok';

    await sql`CREATE INDEX IF NOT EXISTS user_queries_feature_user_idx
              ON user_queries (user_id, feature, created_at DESC)`;
    steps.user_queries_idx = 'ok';

    // 2. traces.parent_trace_id (PRD §15.3)
    await sql`ALTER TABLE traces ADD COLUMN IF NOT EXISTS parent_trace_id TEXT
              REFERENCES traces(trace_id) ON DELETE SET NULL`;
    await sql`CREATE INDEX IF NOT EXISTS traces_parent_idx ON traces (parent_trace_id)`;
    steps.traces_parent = 'ok';

    // 3. sidebar_cache (PRD §4.5 + §6)
    await sql`CREATE TABLE IF NOT EXISTS sidebar_cache (
      id           BIGSERIAL PRIMARY KEY,
      user_id      BIGINT REFERENCES user_profiles(id) ON DELETE CASCADE,
      calculator   TEXT NOT NULL,
      content      TEXT NOT NULL,
      trace_id     TEXT,
      generated_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at   TIMESTAMPTZ NOT NULL,
      UNIQUE (user_id, calculator)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS sidebar_cache_expires_idx
              ON sidebar_cache (expires_at)`;
    steps.sidebar_cache = 'ok';

    // 4. app_settings (PRD §3.14 + §6)
    await sql`CREATE TABLE IF NOT EXISTS app_settings (
      key          TEXT PRIMARY KEY,
      value        TEXT NOT NULL,
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_by   BIGINT REFERENCES user_profiles(id)
    )`;
    await sql`INSERT INTO app_settings (key, value) VALUES ('tooltip_cache_version', '1')
              ON CONFLICT (key) DO NOTHING`;
    steps.app_settings = 'ok';

    // 5. rate_limits (PRD §15.1)
    // Sliding-window counter per user × bucket × window. bucket = 'calc_submit', 'extract',
    // 'sidebar', etc. window_start = floor(now() / window_size_seconds).
    await sql`CREATE TABLE IF NOT EXISTS rate_limits (
      user_id       BIGINT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
      bucket        TEXT NOT NULL,
      window_start  BIGINT NOT NULL,
      count         INT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, bucket, window_start)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS rate_limits_window_idx
              ON rate_limits (window_start)`;
    steps.rate_limits = 'ok';

    return NextResponse.json({ ok: true, migration: 'v8', steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
