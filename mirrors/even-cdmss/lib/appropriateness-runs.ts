/**
 * lib/appropriateness-runs.ts — research retention for the /appropriateness modes.
 *
 * Persists one row per COMPLETED run (check | pathway | audit) into appropriateness_runs
 * (migration 0006), storing the full DE-IDENTIFIED output JSON. This is the research
 * record researchers re-export to Excel, and the audit log of every use surfaced in
 * /admin/appropriateness-runs. Anonymous (CAT has no clinician login). PHI: the case-audit
 * extractor strips name/UHID, so no direct identifiers are captured.
 *
 * Note: appropriateness_runs is NOT in lib/db's STAMP_TABLES, so app_source uses the
 * column DEFAULT ('standalone') — no auto-injection to coordinate with.
 */

import { randomUUID } from 'crypto';
import { sql } from './db';
import { CLINICAL_STATE_VERSION, type ClinicalState } from './clinical-state/schema';

const run = sql as unknown as (q: string, p: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

export type RunMode = 'check' | 'pathway' | 'audit';

export interface SaveRunInput {
  mode: RunMode;
  scenario?: string | null;
  docType?: string | null;
  summary?: string | null;
  nSources?: number;
  nFindings?: number;
  input?: unknown;
  output: unknown;
  deIdentified?: boolean;
  /** Right Care × ClinicalState Slice 1: the state constructed from the run's own
   *  de-identified input (migration 0011). Null/omitted → both columns stay NULL. */
  clinicalState?: ClinicalState | null;
}

export interface RunListRow {
  id: string;
  created_at: string;
  mode: RunMode;
  scenario: string | null;
  doc_type: string | null;
  summary: string | null;
  n_sources: number;
  n_findings: number;
}

export interface RunRow extends RunListRow {
  app_source: string;
  input: unknown;
  output: unknown;
  de_identified: boolean;
}

/** Persist a completed run. Returns the new run id. Soft-fails to '' (never breaks the response). */
export async function saveRun(rec: SaveRunInput): Promise<string> {
  const id = randomUUID();
  try {
    const base = [
      id, rec.mode,
      rec.scenario ? rec.scenario.slice(0, 2000) : null,
      rec.docType ?? null,
      rec.summary ? rec.summary.slice(0, 500) : null,
      Number(rec.nSources ?? 0) || 0,
      Number(rec.nFindings ?? 0) || 0,
      JSON.stringify(rec.input ?? null),
      JSON.stringify(rec.output ?? {}),
      rec.deIdentified !== false,
    ];
    // The 0011 columns are named only when a state was actually built (flag on), so the
    // no-state path issues the exact pre-0011 statement — retention can never break on a
    // deploy that races the migration.
    if (rec.clinicalState) {
      await run(
        `INSERT INTO appropriateness_runs (id, mode, scenario, doc_type, summary, n_sources, n_findings, input, output, de_identified, clinical_state, clinical_state_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb,$12)`,
        [...base, JSON.stringify(rec.clinicalState), CLINICAL_STATE_VERSION],
      );
    } else {
      await run(
        `INSERT INTO appropriateness_runs (id, mode, scenario, doc_type, summary, n_sources, n_findings, input, output, de_identified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)`,
        base,
      );
    }
    return id;
  } catch (e) {
    console.warn('[appropriateness-runs] saveRun failed', (e as Error).message);
    return '';
  }
}

export async function listRuns(opts: { mode?: RunMode; limit?: number } = {}): Promise<RunListRow[]> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const params: unknown[] = [APP];
  let where = 'app_source = $1';
  if (opts.mode) { params.push(opts.mode); where += ` AND mode = $${params.length}`; }
  try {
    const rows = await run(
      `SELECT id, created_at, mode, scenario, doc_type, summary, n_sources, n_findings
       FROM appropriateness_runs WHERE ${where} ORDER BY created_at DESC LIMIT ${limit}`,
      params,
    );
    return rows as unknown as RunListRow[];
  } catch (e) {
    console.warn('[appropriateness-runs] listRuns failed', (e as Error).message);
    return [];
  }
}

export async function getRun(id: string): Promise<RunRow | null> {
  try {
    const rows = await run(`SELECT * FROM appropriateness_runs WHERE id = $1 LIMIT 1`, [id]);
    return (rows[0] as unknown as RunRow) ?? null;
  } catch (e) {
    console.warn('[appropriateness-runs] getRun failed', (e as Error).message);
    return null;
  }
}
