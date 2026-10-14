/**
 * lib/cdsco-banned-fdc.ts — loads the bundled CDSCO banned-FDC seed (data/cdsco-banned-fdc.json)
 * once, and exposes the pure check from lib/cdsco-banned-fdc-core.ts pre-bound to that table.
 * Mirrors lib/dose-limits.ts exactly. STAGE 1 (C9): the seed ships with zero entries, so this
 * check is DORMANT — nothing can fire and scores are unchanged until the pharmacist-reviewed
 * seed lands in stage 2.
 */

import TABLE_JSON from '@/data/cdsco-banned-fdc.json';
import {
  bannedFdcFindings as pureBannedFdcFindings,
  bannedFdcNearMisses as pureBannedFdcNearMisses,
  type BannedFdcTable,
} from './cdsco-banned-fdc-core';
import type { OpdMed } from './opd-ingest-core';
import type { OpdFinding } from './opd-note-audit-core';

const TABLE = TABLE_JSON as unknown as BannedFdcTable;

/** Deterministic CDSCO banned-FDC findings for a prescription (empty while the seed is empty). */
export function bannedFdcFindings(meds: OpdMed[]): OpdFinding[] {
  return pureBannedFdcFindings(meds, TABLE);
}

/** Informational near-miss counter (DETERMINISM-TRIO PRD v1.0 §3) — the SAME table binding as the
 *  exact-match check above, so the two can never be measured against different rulebooks. */
export function bannedFdcNearMisses(meds: OpdMed[]): OpdFinding[] {
  return pureBannedFdcNearMisses(meds, TABLE);
}

export const CDSCO_BANNED_FDC_VERSION = TABLE.version;
