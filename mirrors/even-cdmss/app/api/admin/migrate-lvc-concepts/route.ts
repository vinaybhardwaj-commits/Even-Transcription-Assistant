import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const runtime = 'nodejs';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

// Applies migrations/0020_lvc_concepts.sql (CDMSS-CONCEPT-CODER-PRD v1.0 §3). Idempotent. Auth:
// ADMIN_TOKEN (Bearer/?token=) OR a logged-in admin session cookie — so V can run it one-click.
// Creates the three Phase 1 tables + the resumable state/tick tables. lvc_concept_evidence (PRD §3)
// is Phase 2 (the evidence drawer) and is deliberately NOT created here.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await run(`CREATE TABLE IF NOT EXISTS lvc_concepts (
      concept_id  TEXT PRIMARY KEY,
      direction   TEXT NOT NULL,
      action      TEXT NOT NULL,
      target      TEXT NOT NULL,
      n_strings   INT  NOT NULL DEFAULT 0,
      volume      INT  NOT NULL DEFAULT 0,
      review_lane TEXT NOT NULL DEFAULT 'clean',
      first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`, []);
    await run(`CREATE INDEX IF NOT EXISTS lvc_concepts_lane_idx ON lvc_concepts (review_lane, volume DESC)`, []);
    await run(`CREATE INDEX IF NOT EXISTS lvc_concepts_direction_idx ON lvc_concepts (direction)`, []);
    steps.lvc_concepts = 'ok';

    await run(`CREATE TABLE IF NOT EXISTS lvc_concept_rulings (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      concept_id      TEXT NOT NULL REFERENCES lvc_concepts (concept_id),
      context         TEXT,
      verdict         TEXT NOT NULL,
      rationale       TEXT NOT NULL,
      ratified_by     TEXT NOT NULL,
      ratified_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      active          BOOLEAN NOT NULL DEFAULT TRUE,
      sample_size     INT NOT NULL,
      reviewed_n      INT NOT NULL,
      sample_seed     TEXT NOT NULL,
      n_not_belonging INT NOT NULL
    )`, []);
    await run(`CREATE INDEX IF NOT EXISTS lvc_concept_rulings_concept_idx ON lvc_concept_rulings (concept_id, active)`, []);
    steps.lvc_concept_rulings = 'ok';

    await run(`CREATE TABLE IF NOT EXISTS lvc_concept_strings (
      norm         TEXT PRIMARY KEY,
      concept_id   TEXT NOT NULL,
      context      TEXT,
      confidence   TEXT,
      source       TEXT NOT NULL DEFAULT 'extracted',
      model        TEXT,
      extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`, []);
    await run(`CREATE INDEX IF NOT EXISTS lvc_concept_strings_concept_idx ON lvc_concept_strings (concept_id)`, []);
    await run(`CREATE INDEX IF NOT EXISTS lvc_concept_strings_source_idx ON lvc_concept_strings (source)`, []);
    steps.lvc_concept_strings = 'ok';

    await run(`CREATE TABLE IF NOT EXISTS even_concept_state (
      uid         TEXT PRIMARY KEY,
      coded_epoch BIGINT NOT NULL DEFAULT 0,
      coded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      n_stamped   INT NOT NULL DEFAULT 0
    )`, []);
    await run(`CREATE INDEX IF NOT EXISTS even_concept_state_epoch_idx ON even_concept_state (coded_epoch)`, []);
    steps.even_concept_state = 'ok';

    await run(`CREATE TABLE IF NOT EXISTS even_concept_ticks (
      ts        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status    TEXT NOT NULL,
      processed INT DEFAULT 0,
      stamped   INT DEFAULT 0,
      extracted INT DEFAULT 0,
      rejected  INT DEFAULT 0,
      epoch     BIGINT,
      note      TEXT
    )`, []);
    await run(`CREATE INDEX IF NOT EXISTS even_concept_ticks_ts_idx ON even_concept_ticks (ts DESC)`, []);
    steps.even_concept_ticks = 'ok';

    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
