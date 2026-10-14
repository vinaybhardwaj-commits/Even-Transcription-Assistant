/**
 * lib/readmission/freshness.ts — the freshness line's three live reads
 * (READMIT-RECENT-VIEW-BUILDER-BRIEF-17-SEP-2026, item C). Server-only. READ-ONLY, fail-safe: each
 * read degrades to null on its own fault, never a 500, never each other's fault.
 *
 *   · feedCurrentTo — db13, ONE scalar: MAX(discharge_date) over every IP discharge (both facilities'
 *     aliases pass through unfiltered — the 19-Aug `Even-EHRC` relabel needs no special casing here
 *     because nothing is filtered BY facility_name).
 *   · newestReturnAt / lastAuditAt — Neon, ONE row: MAX(readmit_admit_at) / MAX(audited_at) over the
 *     current engine's even_even findings.
 *   · lastCheckAt — not a read at all: the per-instance stamp the check route set (check-state.ts),
 *     null when no check has run on this instance yet.
 *
 * PHI: every value is a bare timestamp. No id, no name, nothing patient-identifying.
 */
import { sql } from '../db';
import { metabaseQuery } from '../metabase';
import { READMIT_ENGINE_VERSION } from './store';
import { getLastCheckAt } from './check-state';
import type { FreshnessInfo } from '../readmission-rates-core';

/** db13 — VERBATIM (no bind params; both facility aliases pass through because nothing filters on
 *  facility_name). */
export const FEED_CURRENT_TO_SQL = `SELECT to_char(MAX(discharge_date) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS feed_current_to
  FROM kx_discharged_completed_patients
 WHERE encounter_type = 'ip_admission'`;

/** Neon — VERBATIM (parameterised: $1 = engine version). */
export const FINDINGS_FRESHNESS_SQL = `SELECT to_char(MAX(readmit_admit_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS newest_return_at,
       to_char(MAX(audited_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_audit_at
  FROM readmission_findings
 WHERE engine_version = $1 AND finding_class = 'even_even'`;

const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

async function readFeedCurrentTo(): Promise<string | null> {
  try {
    const rows = await metabaseQuery(FEED_CURRENT_TO_SQL);
    return s(rows[0]?.feed_current_to);
  } catch {
    return null;
  }
}

async function readFindingsFreshness(engineVersion: string): Promise<{ newestReturnAt: string | null; lastAuditAt: string | null }> {
  try {
    const rows = (await sql(FINDINGS_FRESHNESS_SQL, [engineVersion])) as Record<string, unknown>[];
    return { newestReturnAt: s(rows[0]?.newest_return_at), lastAuditAt: s(rows[0]?.last_audit_at) };
  } catch {
    return { newestReturnAt: null, lastAuditAt: null };
  }
}

export async function readFreshness(engineVersion: string = READMIT_ENGINE_VERSION): Promise<FreshnessInfo> {
  const [feedCurrentTo, findings] = await Promise.all([readFeedCurrentTo(), readFindingsFreshness(engineVersion)]);
  return { feedCurrentTo, newestReturnAt: findings.newestReturnAt, lastAuditAt: findings.lastAuditAt, lastCheckAt: getLastCheckAt() };
}
