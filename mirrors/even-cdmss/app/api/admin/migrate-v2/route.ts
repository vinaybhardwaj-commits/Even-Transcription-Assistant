import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const steps: Record<string, string> = {};
  try {
    // user_profiles — lightweight, PIN auth, no passwords per PRD
    await sql`CREATE TABLE IF NOT EXISTS user_profiles (
      id            BIGSERIAL PRIMARY KEY,
      display_name  TEXT NOT NULL,
      role          TEXT,
      pin_hash      TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`;
    steps.user_profiles = 'ok';

    // user_queries — log every Ask/DDx/Drugs query for digest generation
    await sql`CREATE TABLE IF NOT EXISTS user_queries (
      id            BIGSERIAL PRIMARY KEY,
      user_id       BIGINT REFERENCES user_profiles(id) ON DELETE SET NULL,
      session_id    TEXT,
      feature       TEXT NOT NULL,
      query_text    TEXT NOT NULL,
      expanded_query TEXT,
      answer_text   TEXT,
      citation_ids  BIGINT[],
      duration_ms   INT,
      meta          JSONB,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`;
    steps.user_queries = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS user_queries_user_idx ON user_queries (user_id, created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS user_queries_feature_idx ON user_queries (feature, created_at DESC)`;
    steps.user_queries_indexes = 'ok';

    // coaching_sessions — Socratic multi-turn (Phase 3)
    await sql`CREATE TABLE IF NOT EXISTS coaching_sessions (
      id            BIGSERIAL PRIMARY KEY,
      user_id       BIGINT REFERENCES user_profiles(id) ON DELETE SET NULL,
      topic         TEXT,
      difficulty    TEXT,
      turns         JSONB DEFAULT '[]'::jsonb,
      outcome       TEXT,
      accuracy      REAL,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      ended_at      TIMESTAMPTZ
    )`;
    steps.coaching_sessions = 'ok';

    // flashcards — SM-2 spaced repetition (Phase 4)
    await sql`CREATE TABLE IF NOT EXISTS flashcards (
      id            BIGSERIAL PRIMARY KEY,
      user_id       BIGINT REFERENCES user_profiles(id) ON DELETE CASCADE,
      front_text    TEXT NOT NULL,
      back_text     TEXT NOT NULL,
      source_query_id BIGINT REFERENCES user_queries(id) ON DELETE SET NULL,
      sm2_easiness  REAL DEFAULT 2.5,
      sm2_interval_days INT DEFAULT 1,
      sm2_repetitions INT DEFAULT 0,
      next_review_at TIMESTAMPTZ DEFAULT NOW(),
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`;
    steps.flashcards = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS flashcards_due_idx ON flashcards (user_id, next_review_at)`;
    steps.flashcards_idx = 'ok';

    // Seed a default profile so we can log queries before auth lands
    await sql`INSERT INTO user_profiles (id, display_name, role)
              VALUES (1, 'Anonymous', 'rmo')
              ON CONFLICT (id) DO NOTHING`;
    steps.seed_default_profile = 'ok';

    const counts = (await sql`
      SELECT 'user_profiles' AS t, COUNT(*)::int AS n FROM user_profiles UNION ALL
      SELECT 'user_queries', COUNT(*)::int FROM user_queries UNION ALL
      SELECT 'coaching_sessions', COUNT(*)::int FROM coaching_sessions UNION ALL
      SELECT 'flashcards', COUNT(*)::int FROM flashcards
    `) as Array<{t: string; n: number}>;
    steps.row_counts = JSON.stringify(counts);

    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
