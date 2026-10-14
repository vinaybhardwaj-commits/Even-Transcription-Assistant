/**
 * Shared fixtures for the Lab v2 suite. Not itself a test file — the runner's glob is
 * `lib/**\/__tests__/*.test.ts`, so this is imported, never executed as a suite.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { embedded, type Db } from '../db';
import { applyMigrations } from '../store';

export function migrationFile() {
  const path = join(process.cwd(), 'migrations', 'lab-v2', '0001_platform.sql');
  const sql = readFileSync(path, 'utf8');
  return { name: '0001_platform.sql', sql, checksum: createHash('sha256').update(sql).digest('hex') };
}

/** A real Postgres (PGlite) with the shipped migration applied. No network, no fixtures. */
export async function freshDb(): Promise<Db> {
  const db = await embedded();
  await applyMigrations(db, [migrationFile()]);
  return db;
}

/** Force a lease into the past, the way a killed function would leave it. */
export async function expireLease(db: Db, itemId: string): Promise<void> {
  await db.query(`UPDATE lab_v2.items SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [itemId]);
}

export const ARM = {
  engine: 'opd_note_audit',
  engine_version: 'test/1.0',
  stages: { analysis: { provider: 'bedrock', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', max_cost_microusd: 50_000 } },
  prompt_hashes: {},
  rubric_hash: null,
  retrieval: { corpus_revision: null, k: null, reranker: null },
};

/** A minimal db13-shaped OPD note row: enough for rowToOpdCase, no identifying content. */
export const SYNTHETIC_NOTE: Record<string, unknown> = {
  uid: 'test-note-0001',
  consult_uid: 'test-consult-0001',
  doctor_uid: 'test-doctor-0001',
  kx_encounter_id: 'test-enc-0001',
  type_of_prescription: 'GENERAL_PRACTITIONER',
  consult_type: 'GENERAL_PRACTITIONER',
  timestamp: '2026-09-01T10:00:00Z',
  dpipe_pc: 'cough for three days',
  dpipe_dx: 'acute upper respiratory infection',
  dpipe_pom: 'rest, fluids, review if fever persists',
  medications: [],
  diagnosis_icd_codes: [],
  impression_icd_codes: [],
};

/** The six frozen inputs of §4.2 (decision 10). All six, or opdFrozenSchema rejects it. */
export const FROZEN = {
  note: SYNTHETIC_NOTE,
  specialty: 'General Practitioner',
  complexity: { band: null, inputs: null },
  lvc_rules: [{ id: 'test-rule-1', hash: 'abc123', keywords: ['vitamin d'], category: 'other' }],
  suppressions: [] as Record<string, unknown>[],
  quieting_config: { rules: [] as Record<string, unknown>[], gen: 0 },
};

/** An LLM leg that returns one low-value finding, so a suppression has something to bite. */
export const REPLY_ONE_FINDING = JSON.stringify({
  findings: [{
    subject: 'Vitamin D level ordered without indication',
    domain: 'low_value_care', verdict: 'low-value',
    rationale: 'no documented indication for 25(OH)D testing', confidence: 0.9,
  }],
  pdqi9: { thorough: 3 },
});
