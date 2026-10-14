import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// Migration 0012 — Reasoning Observability Stage 1 (Invocation Envelope). All additive
// (ADD COLUMN IF NOT EXISTS — no DROP/RENAME); declarative companion:
// migrations/0012_reasoning_fingerprint.sql. Mirrors the migrate-v8 idiom.
//
// Adds:
// - trace_events fingerprint columns (prompt_id/version/hash, rubric_versions,
//   output_schema_version, call_model, call_provider, gen_params, tokens_in/out)
// - traces.prompt_ids (distinct registry ids used in the trace — rollup)
// - trace_events (prompt_id, prompt_version) index
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const steps: Record<string, string> = {};
  try {
    // 1. trace_events — the per-call reasoning fingerprint
    await sql`ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS prompt_id TEXT`;
    await sql`ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS prompt_version TEXT`;
    await sql`ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS prompt_hash TEXT`;
    await sql`ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS rubric_versions JSONB`;
    await sql`ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS output_schema_version TEXT`;
    steps.trace_events_fingerprint = 'ok';

    // 2. trace_events — the call facts (provider-agnostic)
    await sql`ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS call_model TEXT`;
    await sql`ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS call_provider TEXT`;
    await sql`ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS gen_params JSONB`;
    await sql`ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS tokens_in INTEGER`;
    await sql`ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS tokens_out INTEGER`;
    steps.trace_events_call = 'ok';

    // 3. traces — distinct prompt-id rollup for list/filter
    await sql`ALTER TABLE traces ADD COLUMN IF NOT EXISTS prompt_ids JSONB`;
    steps.traces_prompt_ids = 'ok';

    // 4. index for version→outcome + cost-by-prompt-version queries (Stages 2–3)
    await sql`CREATE INDEX IF NOT EXISTS trace_events_prompt_idx ON trace_events (prompt_id, prompt_version)`;
    steps.prompt_idx = 'ok';

    return NextResponse.json({ ok: true, migration: '0012_reasoning_fingerprint', steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
