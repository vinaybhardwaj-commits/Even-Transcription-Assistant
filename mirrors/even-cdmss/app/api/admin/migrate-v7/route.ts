import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS traces (
      id              BIGSERIAL PRIMARY KEY,
      trace_id        TEXT NOT NULL UNIQUE,
      user_id         BIGINT REFERENCES user_profiles(id) ON DELETE SET NULL,
      feature         TEXT NOT NULL,
      input           JSONB,
      started_at      TIMESTAMPTZ DEFAULT NOW(),
      finished_at     TIMESTAMPTZ,
      total_ms        INT,
      status          TEXT DEFAULT 'running',
      error_message   TEXT,
      meta            JSONB
    )`;
    steps.traces = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS traces_feature_idx ON traces (feature, started_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS traces_status_idx ON traces (status, started_at DESC)`;
    steps.traces_idx = 'ok';

    await sql`CREATE TABLE IF NOT EXISTS trace_events (
      id              BIGSERIAL PRIMARY KEY,
      trace_id        TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
      seq             INT NOT NULL,
      ts              TIMESTAMPTZ DEFAULT NOW(),
      kind            TEXT NOT NULL,
      stage           TEXT,
      payload         JSONB,
      latency_ms      INT
    )`;
    steps.trace_events = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS trace_events_trace_idx ON trace_events (trace_id, seq)`;
    await sql`CREATE INDEX IF NOT EXISTS trace_events_kind_idx ON trace_events (kind, ts DESC)`;
    steps.trace_events_idx = 'ok';

    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
