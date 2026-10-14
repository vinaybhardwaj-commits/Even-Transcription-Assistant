/**
 * lib/triage/ot-db13.ts — read-only Metabase db13 access for the OT note lander.
 *
 * Source: public.kx_clinical_template_ot_notes (final-only). Grain = uid.
 * Never SELECTs patient identity chrome (name / mobile). Never reads Chart
 * surgery bookings as note grain.
 */

import { metabaseQuery } from '@/lib/metabase';

const TABLE = 'kx_clinical_template_ot_notes';
const esc = (s: string) => s.replace(/'/g, "''");
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isUid = (s: string) => /^[A-Za-z0-9_-]{6,80}$/.test(s);

export interface OtNoteSourceRow {
  uid: string;
  hospital_uid: string | null;
  facility_id: string | null;
  encounter_id: string | null;
  uhid: string | null;
  surgery_name: string | null;
  surgeon: string | null;
  note: string | null;
  component_json: unknown;
  note_day: string;
  created_at: string | null;
  modified_at: string | null;
  fetched_at: string | null;
  status: string | null;
}

const COLS = `uid, hospital_uid, facility_id, encounter_id, uhid, surgery_name, surgeon,
  note, component_json, status,
  to_char((created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS note_day,
  created_at, modified_at, fetched_at`;

function mapRow(r: Record<string, unknown>): OtNoteSourceRow | null {
  const uid = r.uid == null ? '' : String(r.uid).trim();
  if (!uid) return null;
  const note_day = String(r.note_day || '').slice(0, 10);
  if (!isDay(note_day)) return null;
  const s = (v: unknown) => (v == null || v === '' ? null : String(v));
  return {
    uid,
    hospital_uid: s(r.hospital_uid),
    facility_id: s(r.facility_id),
    encounter_id: s(r.encounter_id),
    uhid: s(r.uhid),
    surgery_name: s(r.surgery_name),
    surgeon: s(r.surgeon),
    note: s(r.note),
    component_json: r.component_json ?? null,
    note_day,
    created_at: s(r.created_at),
    modified_at: s(r.modified_at),
    fetched_at: s(r.fetched_at),
    status: s(r.status),
  };
}

/** Count final OT notes whose created_at IST calendar day equals `day`. */
export async function countOtNotesForDay(day: string): Promise<number> {
  if (!isDay(day)) return 0;
  const rows = await metabaseQuery(
    `SELECT count(*)::int AS n
     FROM ${TABLE}
     WHERE status = 'final'
       AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = DATE '${esc(day)}'`,
  ).catch(() => []);
  return Number((rows[0] as { n?: unknown } | undefined)?.n ?? 0);
}

/**
 * Final OT notes for one IST note_day, excluding already-audited uids.
 * Ordered oldest-first so a partial sweep resumes deterministically.
 */
export async function fetchOtNotesForDay(
  day: string,
  excludeUids: ReadonlySet<string> | readonly string[],
  limit = 20,
): Promise<OtNoteSourceRow[]> {
  if (!isDay(day)) return [];
  const lim = Math.max(1, Math.min(100, Math.floor(limit)));
  const excluded = [...(excludeUids instanceof Set ? excludeUids : excludeUids)]
    .map((u) => String(u).trim())
    .filter(isUid);
  const notIn = excluded.length
    ? `AND uid NOT IN (${excluded.map((u) => `'${esc(u)}'`).join(',')})`
    : '';
  const rows = await metabaseQuery(
    `SELECT ${COLS}
     FROM ${TABLE}
     WHERE status = 'final'
       AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = DATE '${esc(day)}'
       ${notIn}
     ORDER BY created_at ASC NULLS LAST, uid ASC
     LIMIT ${lim}`,
  ).catch(() => []);
  const out: OtNoteSourceRow[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const mapped = mapRow(r);
    if (mapped) out.push(mapped);
  }
  return out;
}

export async function fetchOtNoteByUid(uid: string): Promise<OtNoteSourceRow | null> {
  if (!isUid(uid)) return null;
  const rows = await metabaseQuery(
    `SELECT ${COLS}
     FROM ${TABLE}
     WHERE uid = '${esc(uid)}' AND status = 'final'
     LIMIT 1`,
  ).catch(() => []);
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? mapRow(r) : null;
}
