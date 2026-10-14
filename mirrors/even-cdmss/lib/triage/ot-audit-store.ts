/**
 * lib/triage/ot-audit-store.ts — persist + read OT note audits (Neon ot_note_audits).
 *
 * Idempotent on (uid, engine_version). Routes may re-run the CREATE TABLE statements
 * as belt-and-suspenders when migrations/ has not been applied yet.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { sql } from '@/lib/db';
import { canonicalDistinctOnSql } from '@/lib/audit-canonical';
import { OT_ENGINE_VERSION } from '@/lib/triage/ot-audit-core';
import { OT_NABH_ENGINE_VERSION, scoreOtNabhFromStored } from '@/lib/triage/ot-nabh';
import type { OtMapStatus } from '@/lib/triage/ot-surgeon-map';
import type { OpdFinding } from '@/lib/opd-note-audit-core';
import type { OtNoteSourceRow } from '@/lib/triage/ot-db13';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

export interface OtAuditRow {
  id: string;
  uid: string;
  hospital_uid: string | null;
  encounter_id: string | null;
  uhid: string | null;
  surgery_name: string | null;
  surgeon_raw: string | null;
  note_day: string;
  doctor_uid: string | null;
  map_status: OtMapStatus;
  findings: unknown;
  n_findings: number;
  engine_version: string;
}

export interface SaveOtAuditInput {
  source: OtNoteSourceRow;
  doctor_uid: string | null;
  map_status: OtMapStatus;
  findings: OpdFinding[];
  engine_version?: string;
  model?: string | null;
  trace_id?: string | null;
}

let ensured = false;

export async function ensureOtAuditTables(): Promise<void> {
  if (ensured) return;
  await run(`
    CREATE TABLE IF NOT EXISTS ot_note_audits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      audited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source TEXT NOT NULL DEFAULT 'standalone',
      note_class TEXT NOT NULL DEFAULT 'ot',
      uid TEXT NOT NULL,
      hospital_uid TEXT,
      facility_id TEXT,
      encounter_id TEXT,
      uhid TEXT,
      surgery_name TEXT,
      surgeon_raw TEXT,
      note_day DATE NOT NULL,
      note_created_at TIMESTAMPTZ,
      note_modified_at TIMESTAMPTZ,
      scraped_at TIMESTAMPTZ,
      note TEXT,
      component_json JSONB,
      doctor_uid TEXT,
      map_status TEXT NOT NULL DEFAULT 'unmapped',
      n_findings INT NOT NULL DEFAULT 0,
      findings JSONB,
      engine_version TEXT NOT NULL DEFAULT 'ot-note-audit/0.1',
      model TEXT,
      trace_id TEXT,
      nabh_score_sum INT,
      nabh_score_max INT,
      nabh_score_pct NUMERIC(6,2),
      nabh_criteria JSONB,
      nabh_engine_version TEXT,
      nabh_scored_at TIMESTAMPTZ
    )`);
  await run(`ALTER TABLE ot_note_audits ADD COLUMN IF NOT EXISTS nabh_score_sum INT`);
  await run(`ALTER TABLE ot_note_audits ADD COLUMN IF NOT EXISTS nabh_score_max INT`);
  await run(`ALTER TABLE ot_note_audits ADD COLUMN IF NOT EXISTS nabh_score_pct NUMERIC(6,2)`);
  await run(`ALTER TABLE ot_note_audits ADD COLUMN IF NOT EXISTS nabh_criteria JSONB`);
  await run(`ALTER TABLE ot_note_audits ADD COLUMN IF NOT EXISTS nabh_engine_version TEXT`);
  await run(`ALTER TABLE ot_note_audits ADD COLUMN IF NOT EXISTS nabh_scored_at TIMESTAMPTZ`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS ot_note_audits_uid_engine_uq ON ot_note_audits (uid, engine_version)`);
  await run(`CREATE INDEX IF NOT EXISTS ot_note_audits_note_day_idx ON ot_note_audits (note_day DESC)`);
  await run(`
    CREATE TABLE IF NOT EXISTS ot_surgeon_map (
      surgeon_key TEXT PRIMARY KEY,
      doctor_uid TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'surfer_seed_n3plus_y',
      seeded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  ensured = true;
}

function parseComponentJson(value: unknown): unknown {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return { raw: String(value).slice(0, 8000) }; }
}

/** Backfill writes NABH columns only. Lander findings are not in the SET list. */
export const OT_NABH_BACKFILL_UPDATE_SQL = `UPDATE ot_note_audits
   SET nabh_score_sum = $2,
       nabh_score_max = $3,
       nabh_score_pct = $4,
       nabh_criteria = $5::jsonb,
       nabh_engine_version = $6,
       nabh_scored_at = NOW()
   WHERE id = $1::uuid
     AND (nabh_scored_at IS NULL OR nabh_engine_version IS DISTINCT FROM $6)`;

export async function saveOtAudit(input: SaveOtAuditInput): Promise<{ status: 'inserted' | 'exists'; id?: string; nabh_score_pct?: number }> {
  await ensureOtAuditTables();
  const engine = input.engine_version || OT_ENGINE_VERSION;
  const src = input.source;
  const findings = input.findings ?? [];
  const component = parseComponentJson(src.component_json);
  const nabh = scoreOtNabhFromStored({
    note: src.note,
    component_json: component,
    surgery_name: src.surgery_name,
    surgeon_raw: src.surgeon,
    note_created_at: src.created_at,
  });
  const rows = await run(
    `INSERT INTO ot_note_audits (
       app_source, note_class, uid, hospital_uid, facility_id, encounter_id, uhid,
       surgery_name, surgeon_raw, note_day, note_created_at, note_modified_at, scraped_at,
       note, component_json, doctor_uid, map_status, n_findings, findings,
       engine_version, model, trace_id,
       nabh_score_sum, nabh_score_max, nabh_score_pct, nabh_criteria, nabh_engine_version, nabh_scored_at
     ) VALUES (
       $1,'ot',$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18::jsonb,$19,$20,$21,
       $22,$23,$24,$25::jsonb,$26,NOW()
     )
     ON CONFLICT (uid, engine_version) DO NOTHING
     RETURNING id::text AS id`,
    [
      APP,
      src.uid,
      src.hospital_uid,
      src.facility_id,
      src.encounter_id,
      src.uhid,
      src.surgery_name,
      src.surgeon,
      src.note_day,
      src.created_at,
      src.modified_at,
      src.fetched_at,
      src.note,
      JSON.stringify(component),
      input.doctor_uid,
      input.map_status,
      findings.length,
      JSON.stringify(findings),
      engine,
      input.model ?? null,
      input.trace_id ?? null,
      nabh.score_sum,
      nabh.score_max,
      nabh.score_pct,
      JSON.stringify(nabh.criteria),
      nabh.engine_version,
    ],
  );
  if (rows[0]?.id) return { status: 'inserted', id: String(rows[0].id), nabh_score_pct: nabh.score_pct };
  return { status: 'exists' };
}

/**
 * Persist ot-nabh/0.1 onto rows the lander already wrote. Does not insert notes,
 * does not change findings, map_status, or doctor_uid.
 */
export async function backfillOtNabhScores(limit = 40): Promise<{ scored: number; failed: number; remaining: number }> {
  await ensureOtAuditTables();
  const cap = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = await run(
    `SELECT id::text AS id, note, component_json, surgery_name, surgeon_raw, note_created_at
     FROM ot_note_audits
     WHERE nabh_scored_at IS NULL OR nabh_engine_version IS DISTINCT FROM $1
     ORDER BY note_day DESC, audited_at DESC
     LIMIT $2`,
    [OT_NABH_ENGINE_VERSION, cap],
  ).catch(() => []);
  let scored = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const nabh = scoreOtNabhFromStored(row);
      await run(OT_NABH_BACKFILL_UPDATE_SQL, [
        String(row.id),
        nabh.score_sum,
        nabh.score_max,
        nabh.score_pct,
        JSON.stringify(nabh.criteria),
        OT_NABH_ENGINE_VERSION,
      ]);
      scored += 1;
    } catch {
      failed += 1;
    }
  }
  const left = await run(
    `SELECT count(*)::int AS n FROM ot_note_audits
     WHERE nabh_scored_at IS NULL OR nabh_engine_version IS DISTINCT FROM $1`,
    [OT_NABH_ENGINE_VERSION],
  ).catch(() => [{ n: 0 }]);
  return { scored, failed, remaining: Number(left[0]?.n ?? 0) };
}

export async function auditedOtUidsAnyVersion(): Promise<Set<string>> {
  await ensureOtAuditTables();
  const rows = await run(
    `SELECT DISTINCT uid FROM ot_note_audits WHERE app_source = $1`,
    [APP],
  ).catch(() => []);
  return new Set(rows.map((r) => String(r.uid)));
}

export async function loadOtSurgeonMap(): Promise<Map<string, string>> {
  await ensureOtAuditTables();
  const rows = await run(`SELECT surgeon_key, doctor_uid FROM ot_surgeon_map`, []).catch(() => []);
  const out = new Map<string, string>();
  for (const r of rows) {
    const key = String(r.surgeon_key || '').trim();
    const uid = String(r.doctor_uid || '').trim();
    if (key && uid) out.set(key, uid);
  }
  return out;
}

/** Upsert Surfer Y-seed rows (unique Pulse uid only). Safe to call on every worker tick. */
export async function seedOtSurgeonMapFromFile(
  seedPath = join(process.cwd(), 'data', 'ot-surgeon-pulse-seed.json'),
): Promise<{ upserted: number }> {
  await ensureOtAuditTables();
  let payload: { mapped?: { surgeon: string; doctor_uid: string }[] };
  try {
    payload = JSON.parse(readFileSync(seedPath, 'utf8')) as typeof payload;
  } catch {
    return { upserted: 0 };
  }
  let upserted = 0;
  for (const row of payload.mapped ?? []) {
    const key = String(row.surgeon || '').replace(/\s+/g, ' ').trim();
    const uid = String(row.doctor_uid || '').trim();
    if (!key || !uid) continue;
    await run(
      `INSERT INTO ot_surgeon_map (surgeon_key, doctor_uid, source)
       VALUES ($1, $2, 'surfer_seed_n3plus_y')
       ON CONFLICT (surgeon_key) DO UPDATE SET doctor_uid = EXCLUDED.doctor_uid`,
      [key, uid],
    );
    upserted += 1;
  }
  return { upserted };
}

/**
 * OT Action-queue load SQL. `canonicalDistinctOnSql` already projects `identity` (`uid`);
 * do not re-list `uid` in `cols` — Neon rejects the outer SELECT with ambiguous column reference.
 */
export function buildOtAuditsForQueueSql(where: string): string {
  return `SELECT id, uid, hospital_uid, encounter_id, uhid, surgery_name, surgeon_raw, note_day,
            doctor_uid, map_status, findings, n_findings, engine_version
     FROM (${canonicalDistinctOnSql({
       table: 'ot_note_audits',
       identity: 'uid',
       cols: `id::text AS id, hospital_uid, encounter_id, uhid, surgery_name, surgeon_raw,
              to_char(note_day,'YYYY-MM-DD') AS note_day,
              doctor_uid, map_status, findings, n_findings, engine_version`,
       where,
     })}) canonical
     LIMIT 8000`;
}

export async function loadOtAuditsForQueue(from: string, to: string): Promise<OtAuditRow[]> {
  await ensureOtAuditTables();
  const where = `app_source = $1 AND engine_version = $2
    AND note_day BETWEEN $3::date AND $4::date`;
  let rows: Record<string, unknown>[];
  try {
    rows = await run(buildOtAuditsForQueueSql(where), [APP, OT_ENGINE_VERSION, from, to]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ot-audit-store] loadOtAuditsForQueue failed:', message);
    throw err;
  }
  return rows.map((r) => ({
    id: String(r.id),
    uid: String(r.uid),
    hospital_uid: r.hospital_uid == null ? null : String(r.hospital_uid),
    encounter_id: r.encounter_id == null ? null : String(r.encounter_id),
    uhid: r.uhid == null ? null : String(r.uhid),
    surgery_name: r.surgery_name == null ? null : String(r.surgery_name),
    surgeon_raw: r.surgeon_raw == null ? null : String(r.surgeon_raw),
    note_day: String(r.note_day || ''),
    doctor_uid: r.doctor_uid == null ? null : String(r.doctor_uid),
    map_status: (String(r.map_status || 'unmapped') as OtMapStatus),
    findings: r.findings,
    n_findings: Number(r.n_findings) || 0,
    engine_version: String(r.engine_version || OT_ENGINE_VERSION),
  }));
}
