/**
 * ⚠️ RETIRED SURFACE — DO NOT DELETE. The mechanics here are LIVE.
 *
 * Care Conversation Briefs was retired as a care-manager product on 30 Jul 2026 — non-use, not
 * malfunction. The nav card is gone and the batch cron is paused, so this code is now invisible,
 * unused-looking and untraced: exactly the profile a tech-debt sweep deletes. It must not be.
 *
 * These mechanics are the best working example of ClinicalState, MemberState and the longitudinal
 * spine in the system, and they are RE-EXPOSED as a microservice behind /api/v1/patient-summary,
 * which feeds the physician's pre-encounter Patient Summary in Pulse (the OPD HIS). Deleting or
 * "cleaning up" anything here breaks that API.
 *
 * See: CDMSS-CCB-REPURPOSE-PRD-v0.1-30-JUL-2026 and the Patient Summary API kickoff (30 Jul 2026),
 * and the entry in CDMSS-OPEN-ISSUE-REGISTER-23-JUL-2026.md.
 *
 * ⚠️ HAZARD — CCB_ENABLED IS NOT A CCB FLAG. It gates ALL EIGHT /care pages: /care, /care/briefs,
 * /care/m/[uid], /care/[uid], /care/triage, /care/review, /care/lvc, /care/concepts. Setting it to
 * 0 does NOT disable CCB — it 404s the entire care-manager surface and takes down OPD Audit
 * Triage, LVC adjudication, Concept Coder and Review Mode with it. The flag keeps its name by
 * decision; this warning is the mitigation.
 */
/**
 * lib/ccb-detect.ts — CCB daily-batch detector (P2.2). Lists the EHRC-cohort OPD notes for an
 * IST calendar day, read from db13 via the existing Metabase reader.
 *
 * EHRC cohort (grounded 30 Jun): `kx_encounter_id` is empty on every recent note, so the clean
 * discriminator is `type_of_prescription` — the in-hospital `HOSPITAL_*` medical types (~92/day),
 * vs the `GENERAL_PRACTITIONER` telehealth/clinic volume (excluded). Override with CCB_COHORT_TYPES.
 */

import { metabaseQuery } from './metabase';

const DEFAULT_COHORT = [
  'HOSPITAL_GP', 'HOSPITAL_PAEDIATRIC', 'HOSPITAL_GYNAECOLOGY_ASSESSMENT',
  'HOSPITAL_GYNAECOLOGY_OBSTETRICS', 'HOSPITAL_GP_INVESTIGATION_REFERRAL',
];

/** The EHRC-cohort prescription types (env override, sanitised to UPPER_SNAKE). */
export function ccbCohortTypes(): string[] {
  const env = (process.env.CCB_COHORT_TYPES || '').split(',').map((s) => s.trim().toUpperCase().replace(/[^A-Z_]/g, '')).filter(Boolean);
  return env.length ? env : DEFAULT_COHORT;
}

const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);

function quotedTypes(): string {
  return ccbCohortTypes().map((t) => `'${t.replace(/[^A-Z_]/g, '')}'`).join(', ');
}
// Encounters are timestamped in IST; a "day" is an Asia/Kolkata calendar day (matches the OPD audit).
function baseWhere(day: string): string {
  return `ip.is_draft = false AND ip.type_of_prescription IN (${quotedTypes()})`
    + ` AND (ip.timestamp AT TIME ZONE 'Asia/Kolkata')::date = '${day}'`;
}

/** Count EHRC-cohort notes for an IST calendar day. */
export async function countCcbNotesForDay(day: string): Promise<number> {
  if (!isDay(day)) throw new Error('bad day (YYYY-MM-DD)');
  const rows = await metabaseQuery(`SELECT count(*)::int AS n FROM "individuals-prescriptions" ip WHERE ${baseWhere(day)}`);
  return Number(rows[0]?.n ?? 0);
}

/** All EHRC-cohort presc uids for an IST day (capped). The worker dedups against ccb_briefs by uid. */
export async function fetchCcbUidsForDay(day: string, limit = 300): Promise<string[]> {
  if (!isDay(day)) throw new Error('bad day (YYYY-MM-DD)');
  const lim = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = await metabaseQuery(
    `SELECT ip.uid FROM "individuals-prescriptions" ip WHERE ${baseWhere(day)} ORDER BY ip.timestamp ASC LIMIT ${lim}`,
  );
  return rows.map((r) => String(r.uid)).filter(isUid);
}
