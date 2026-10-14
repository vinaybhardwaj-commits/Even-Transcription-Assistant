// Telemetry for the interaction checker: logs every check (drugs in, pairs out)
// so pharmacy can review real usage, find misses (queries that returned nothing)
// and false alerts, and tune the rules/reference over time. Drug names only — no
// patient identifiers. Best-effort: a logging failure never breaks the check.

import { sql } from './db';
import type { DdiPair } from './rxlabelguard';

let ensured = false;
async function ensureTable(): Promise<void> {
  if (ensured) return;
  await sql`CREATE TABLE IF NOT EXISTS ddi_query_log (
    id BIGSERIAL PRIMARY KEY,
    drugs JSONB NOT NULL,
    pairs JSONB NOT NULL DEFAULT '[]'::jsonb,
    pair_count INT NOT NULL DEFAULT 0,
    sources TEXT[] DEFAULT '{}',
    max_severity TEXT,
    app_source TEXT DEFAULT 'medaudit',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS ddi_query_log_created_idx ON ddi_query_log (created_at DESC)`;
  ensured = true;
}

const SEV_RANK: Record<string, number> = { contraindicated: 5, major: 4, moderate: 3, minor: 2, unknown: 1, none: 0 };

export async function logDdiQuery(drugs: string[], pairs: DdiPair[]): Promise<void> {
  try {
    await ensureTable();
    const sources = [...new Set(pairs.map((p) => p.source))];
    let maxSev = 'none';
    for (const p of pairs) if ((SEV_RANK[p.severity] || 0) > (SEV_RANK[maxSev] || 0)) maxSev = p.severity;
    const slim = pairs.map((p) => ({ a: p.drug_a, b: p.drug_b, severity: p.severity, source: p.source }));
    await sql`
      INSERT INTO ddi_query_log (drugs, pairs, pair_count, sources, max_severity)
      VALUES (${JSON.stringify(drugs)}::jsonb, ${JSON.stringify(slim)}::jsonb, ${pairs.length}, ${sources}, ${maxSev})`;
  } catch {
    /* best-effort telemetry — never blocks the interaction check */
  }
}
