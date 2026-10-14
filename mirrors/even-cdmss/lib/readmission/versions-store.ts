/**
 * lib/readmission/versions-store.ts — the R8.1 snapshot table's DB layer
 * (CDMSS-READMISSIONS-R8.1-FINDING-VERSIONS PRD v1.0; table readmission_finding_versions,
 * created by /api/admin/migrate-readmission-versions; reference DDL in migrations/0035).
 *
 * TWO postures in one file, and the asymmetry is the point (O2):
 *   · insertSnapshot THROWS on any failure. A history table that fails quietly is worse
 *     than no history table. This is the only write in the readmissions area that is
 *     allowed to block its caller — the replay route surfaces the throw; the overwrite
 *     path in store.ts runs its own INSERT inside the same statement as the UPDATE and
 *     does not use this function.
 *   · listVersionsForCase FAILS SAFE (house posture for reads): any DB error — including
 *     the migration not having run — returns an empty list with an honest error line,
 *     never a 500.
 *
 * O4: nothing user-facing reads this table. The list exists for the admin replay route
 * and for audit_query research, not for the board, the badge, the case page or rates.
 *
 * ⚠️ INFERRED SQL throughout: this sandbox has no live Neon.
 */

import { sql } from '../db';
import { CAPTURE_REASONS, type VersionSnapshot } from '../readmission-versions-core';
import { READMIT_ENGINE_VERSION } from './store';

/**
 * Insert ONE snapshot row. THROWS on failure — never swallowed here (O2). The caller
 * decides what a blocked write means (the replay route: a 500 with the message; snapshots
 * already inserted for earlier runs stand, honestly).
 */
export async function insertSnapshot(s: VersionSnapshot): Promise<string> {
  if (!CAPTURE_REASONS.includes(s.captureReason)) {
    throw new Error(`capture_reason must be one of ${CAPTURE_REASONS.join(' | ')} — got '${String(s.captureReason)}'`);
  }
  if (!s.dedupKey || !s.engineVersion) throw new Error('snapshot requires dedup_key and engine_version');
  const rows = (await sql(
    `INSERT INTO readmission_finding_versions
       (capture_reason, dedup_key, engine_version, avoidable, planned, same_condition,
        preventable_injury, audit_status, model, provider, audited_at, template_coverage,
        row_snapshot, trace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14)
     RETURNING id`,
    [
      s.captureReason, s.dedupKey, s.engineVersion, s.avoidable, s.planned, s.sameCondition,
      s.preventableInjury, s.auditStatus, s.model, s.provider, s.auditedAt,
      s.templateCoverage != null ? JSON.stringify(s.templateCoverage) : null,
      JSON.stringify(s.rowSnapshot), s.traceId,
    ],
  )) as Array<{ id: string }>;
  if (!rows.length || !rows[0]?.id) throw new Error('snapshot insert returned no row');
  return rows[0].id;
}

/** One stored version, as the per-case list returns it (timestamps as UTC ISO text). */
export interface VersionListRow extends Record<string, unknown> {
  id: string;
  captured_at: string;
  capture_reason: string;
  dedup_key: string;
  engine_version: string;
  avoidable: string | null;
  planned: string | null;
  same_condition: string | null;
  preventable_injury: string | null;
  audit_status: string | null;
  model: string | null;
  provider: string | null;
  audited_at: string | null;
  template_coverage: unknown;
  row_snapshot: unknown;
  trace_id: string | null;
}

const LIST_LIMIT = 200;

/**
 * Every snapshot for one case at the engine version, newest first. FAIL-SAFE: a DB error
 * returns { rows: [], error } — the honest empty list, never a throw, never a 500.
 */
export async function listVersionsForCase(
  dedupKey: string,
  engineVersion: string = READMIT_ENGINE_VERSION,
): Promise<{ rows: VersionListRow[]; error: string | null }> {
  if (!dedupKey) return { rows: [], error: 'dedup_key required' };
  try {
    const rows = (await sql(
      `SELECT id,
              to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS captured_at,
              capture_reason, dedup_key, engine_version, avoidable, planned, same_condition,
              preventable_injury, audit_status, model, provider,
              to_char(audited_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS audited_at,
              template_coverage, row_snapshot, trace_id
         FROM readmission_finding_versions
        WHERE dedup_key = $1 AND engine_version = $2
        ORDER BY captured_at DESC
        LIMIT ${LIST_LIMIT}`,
      [dedupKey, engineVersion],
    )) as VersionListRow[];
    return { rows, error: null };
  } catch (e) {
    return { rows: [], error: `versions list unavailable: ${String((e as Error).message).slice(0, 300)}` };
  }
}
