/**
 * lib/triage/ot-admin-read.ts — admin OT Audit list + detail reads.
 *
 * Scores come from persisted nabh_* columns. This module does not score.
 * Pulse names are fetched only for rows whose curated hop is mapped.
 */

import { sql } from '@/lib/db';
import { canonicalDistinctOnSql } from '@/lib/audit-canonical';
import { fetchDoctorNames, metabaseQuery } from '@/lib/metabase';
import { parseJson } from '@/lib/opd-audit-ui';
import { ensureOtAuditTables } from '@/lib/triage/ot-audit-store';
import { OT_ENGINE_VERSION } from '@/lib/triage/ot-audit-core';
import type { OtAdminListRow } from '@/lib/triage/ot-admin-present';

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export interface OtAdminDetail extends OtAdminListRow {
  encounter_id: string | null;
  note: string | null;
  nabh_score_sum: number | null;
  nabh_score_max: number | null;
  nabh_criteria: unknown;
  nabh_scored_at: string | null;
  findings: unknown;
}

const LIST_WHERE = `app_source = $1 AND engine_version = '${OT_ENGINE_VERSION}' AND note_day BETWEEN $2::date AND $3::date`;

export function buildOtAdminListSql(): string {
  return `SELECT id, uid, hospital_uid, uhid, surgery_name, surgeon_raw, note_day,
            doctor_uid, map_status, n_findings, engine_version, nabh_score_pct, nabh_engine_version
     FROM (${canonicalDistinctOnSql({
       table: 'ot_note_audits',
       identity: 'uid',
       cols: `id::text AS id, hospital_uid, uhid, surgery_name, surgeon_raw,
              to_char(note_day,'YYYY-MM-DD') AS note_day,
              doctor_uid, map_status, n_findings, engine_version,
              nabh_score_pct, nabh_engine_version`,
       where: LIST_WHERE,
     })}) canonical
     ORDER BY note_day DESC, uid ASC
     LIMIT 2000`;
}

function mapList(r: Record<string, unknown>): OtAdminListRow {
  return {
    id: String(r.id),
    uid: String(r.uid),
    hospital_uid: str(r.hospital_uid),
    uhid: str(r.uhid),
    surgery_name: str(r.surgery_name),
    surgeon_raw: str(r.surgeon_raw),
    note_day: String(r.note_day || '').slice(0, 10),
    doctor_uid: str(r.doctor_uid),
    map_status: String(r.map_status || 'unmapped'),
    n_findings: Number(r.n_findings) || 0,
    engine_version: String(r.engine_version || ''),
    nabh_score_pct: num(r.nabh_score_pct),
    nabh_engine_version: str(r.nabh_engine_version),
  };
}

export async function loadOtAdminWindow(from: string, to: string): Promise<OtAdminListRow[]> {
  await ensureOtAuditTables();
  const rows = await run(buildOtAdminListSql(), [APP, from, to]);
  return rows.map(mapList);
}

/** even_hospitals uid → name. Same directory the pre-op board uses. Fail-soft to {}. */
export async function loadHospitalLabels(): Promise<Record<string, string>> {
  try {
    const rows = await metabaseQuery(`SELECT _doc_id, name FROM even_hospitals LIMIT 100`);
    const out: Record<string, string> = {};
    for (const r of rows) {
      const uid = str(r._doc_id);
      const name = str(r.name);
      if (uid && name) out[uid] = name;
    }
    return out;
  } catch {
    return {};
  }
}

/** Pulse display names for mapped hops only. Unmapped uids are not looked up. */
export async function loadMappedPulseNames(rows: readonly OtAdminListRow[]): Promise<Record<string, string>> {
  const uids = rows
    .filter((r) => r.map_status === 'mapped' && r.doctor_uid)
    .map((r) => r.doctor_uid as string);
  if (!uids.length) return {};
  try {
    return await fetchDoctorNames(uids);
  } catch {
    return {};
  }
}

export async function loadOtAdminDetail(id: string): Promise<OtAdminDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  await ensureOtAuditTables();
  const rows = await run(
    `SELECT id::text AS id, uid, hospital_uid, encounter_id, uhid, surgery_name, surgeon_raw,
            to_char(note_day,'YYYY-MM-DD') AS note_day,
            doctor_uid, map_status, n_findings, findings, engine_version, note,
            nabh_score_sum, nabh_score_max, nabh_score_pct, nabh_criteria,
            nabh_engine_version, nabh_scored_at
     FROM ot_note_audits WHERE id = $1::uuid LIMIT 1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  const base = mapList(r);
  return {
    ...base,
    encounter_id: str(r.encounter_id),
    note: r.note == null ? null : String(r.note),
    nabh_score_sum: num(r.nabh_score_sum) == null ? null : Math.trunc(Number(r.nabh_score_sum)),
    nabh_score_max: num(r.nabh_score_max) == null ? null : Math.trunc(Number(r.nabh_score_max)),
    nabh_criteria: parseJson(r.nabh_criteria, null),
    nabh_scored_at: r.nabh_scored_at == null ? null : String(r.nabh_scored_at),
    findings: parseJson(r.findings, []),
  };
}
