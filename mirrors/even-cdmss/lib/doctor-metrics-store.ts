/**
 * lib/doctor-metrics-store.ts — unified doctor metrics + canonical roster (Neon, WIRED).
 *
 * Two tables refreshed by the daily CDMSS cron (replacing the weekly Claude task):
 *  - doctor_operational_metrics: the latest weekly operational snapshot per canonical doctors.uid,
 *    pulled from db13 mv_doctor_weekly_performance (joined doctor_email → doctors.uid).
 *  - doctor_roster: the canonical matching source EPI pulls (GET /doctor-directory), built by the
 *    doctor-directory-core recipe.
 * Tables created by /api/admin/migrate-doctor-metrics.
 */

import { sql } from './db';
import type { RosterRow } from './doctor-directory-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export async function ensureDoctorMetricsTables(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS doctor_operational_metrics (
    doctor_uid                text PRIMARY KEY,
    week                      date,
    total_consults            integer,
    csat_pct                  numeric,
    patient_noshow_rate       numeric,
    cancellation_rate         numeric,
    missing_prescription_rate numeric,
    specialty                 text,
    channel                   text,
    updated_at                timestamptz NOT NULL DEFAULT now()
  )`, []);
  await run(`CREATE TABLE IF NOT EXISTS doctor_roster (
    doctor_uid         text PRIMARY KEY,
    name               text,
    name_normalized    text,
    specialty          text,
    channel            text,
    mobile_last4       text,
    has_email          boolean NOT NULL DEFAULT false,
    audit_active       boolean NOT NULL DEFAULT false,
    operational_active boolean NOT NULL DEFAULT false,
    updated_at         timestamptz NOT NULL DEFAULT now()
  )`, []);
  await run(`CREATE INDEX IF NOT EXISTS doctor_roster_name_idx ON doctor_roster (name_normalized)`, []);
}

export interface OperationalMetric {
  doctor_uid: string; week: string | null; total_consults: number | null;
  csat_pct: number | null; patient_noshow_rate: number | null; cancellation_rate: number | null;
  missing_prescription_rate: number | null; specialty: string | null; channel: string | null;
}

/** Replace the operational snapshot with a freshly-pulled set (one row per doctor_uid). */
export async function upsertOperationalMetrics(rows: OperationalMetric[]): Promise<number> {
  let n = 0;
  for (const r of rows) {
    if (!r.doctor_uid) continue;
    await run(
      `INSERT INTO doctor_operational_metrics
        (doctor_uid, week, total_consults, csat_pct, patient_noshow_rate, cancellation_rate, missing_prescription_rate, specialty, channel, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (doctor_uid) DO UPDATE SET
         week=EXCLUDED.week, total_consults=EXCLUDED.total_consults, csat_pct=EXCLUDED.csat_pct,
         patient_noshow_rate=EXCLUDED.patient_noshow_rate, cancellation_rate=EXCLUDED.cancellation_rate,
         missing_prescription_rate=EXCLUDED.missing_prescription_rate, specialty=EXCLUDED.specialty,
         channel=EXCLUDED.channel, updated_at=now()`,
      [r.doctor_uid, r.week, r.total_consults, r.csat_pct, r.patient_noshow_rate, r.cancellation_rate, r.missing_prescription_rate, r.specialty, r.channel]);
    n++;
  }
  return n;
}

/** The contract §7b.1 operational block for one doctor (null when absent from the matview). */
export interface OperationalBlock {
  week: string | null; total_consults: number | null; csat_pct: number | null;
  patient_noshow_rate: number | null; cancellation_rate: number | null;
  missing_prescription_rate: number | null; channel: string | null; as_of: string | null;
}
const numOrNull = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

export async function getOperationalBlock(doctorUid: string): Promise<OperationalBlock | null> {
  const rows = await run(
    `SELECT to_char(week,'YYYY-MM-DD') week, total_consults, csat_pct, patient_noshow_rate,
            cancellation_rate, missing_prescription_rate, channel, to_char(updated_at,'YYYY-MM-DD') as_of
     FROM doctor_operational_metrics WHERE doctor_uid=$1 LIMIT 1`, [doctorUid]).catch(() => []);
  const r = rows[0];
  if (!r) return null;
  return {
    week: r.week ? String(r.week) : null, total_consults: numOrNull(r.total_consults), csat_pct: numOrNull(r.csat_pct),
    patient_noshow_rate: numOrNull(r.patient_noshow_rate), cancellation_rate: numOrNull(r.cancellation_rate),
    missing_prescription_rate: numOrNull(r.missing_prescription_rate),
    channel: r.channel ? String(r.channel) : null, as_of: r.week ? String(r.week) : (r.as_of ? String(r.as_of) : null),
  };
}

/** Batch operational blocks for many doctors (roster view). */
export async function getOperationalBlocks(doctorUids: string[]): Promise<Record<string, OperationalBlock>> {
  const uids = [...new Set(doctorUids.filter(Boolean))];
  if (!uids.length) return {};
  const rows = await run(
    `SELECT doctor_uid, to_char(week,'YYYY-MM-DD') week, total_consults, csat_pct, patient_noshow_rate,
            cancellation_rate, missing_prescription_rate, channel
     FROM doctor_operational_metrics WHERE doctor_uid = ANY($1)`, [uids]).catch(() => []);
  const out: Record<string, OperationalBlock> = {};
  for (const r of rows as Record<string, unknown>[]) {
    out[String(r.doctor_uid)] = {
      week: r.week ? String(r.week) : null, total_consults: numOrNull(r.total_consults), csat_pct: numOrNull(r.csat_pct),
      patient_noshow_rate: numOrNull(r.patient_noshow_rate), cancellation_rate: numOrNull(r.cancellation_rate),
      missing_prescription_rate: numOrNull(r.missing_prescription_rate),
      channel: r.channel ? String(r.channel) : null, as_of: r.week ? String(r.week) : null,
    };
  }
  return out;
}

/** doctor_uids that have an operational snapshot (for roster activity flags). */
export async function operationalActiveUids(): Promise<string[]> {
  const rows = await run(`SELECT doctor_uid FROM doctor_operational_metrics`, []).catch(() => []);
  return (rows as Record<string, unknown>[]).map((r) => String(r.doctor_uid));
}

/** Replace the canonical roster with a freshly-built set. */
export async function upsertRoster(rows: RosterRow[]): Promise<number> {
  let n = 0;
  for (const r of rows) {
    await run(
      `INSERT INTO doctor_roster
        (doctor_uid, name, name_normalized, specialty, channel, mobile_last4, has_email, audit_active, operational_active, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (doctor_uid) DO UPDATE SET
         name=EXCLUDED.name, name_normalized=EXCLUDED.name_normalized, specialty=EXCLUDED.specialty,
         channel=EXCLUDED.channel, mobile_last4=EXCLUDED.mobile_last4, has_email=EXCLUDED.has_email,
         audit_active=EXCLUDED.audit_active, operational_active=EXCLUDED.operational_active, updated_at=now()`,
      [r.doctor_uid, r.name, r.name_normalized, r.specialty, r.channel, r.mobile_last4, r.has_email, r.audit_active, r.operational_active]);
    n++;
  }
  return n;
}

export async function readRoster(): Promise<RosterRow[]> {
  const rows = await run(
    `SELECT doctor_uid, name, name_normalized, specialty, channel, mobile_last4, has_email, audit_active, operational_active
     FROM doctor_roster ORDER BY (audit_active OR operational_active) DESC, name_normalized ASC LIMIT 2000`, []).catch(() => []);
  return (rows as Record<string, unknown>[]).map((r) => ({
    doctor_uid: String(r.doctor_uid), name: String(r.name || ''), name_normalized: String(r.name_normalized || ''),
    specialty: r.specialty == null ? null : String(r.specialty), channel: r.channel == null ? null : String(r.channel),
    mobile_last4: r.mobile_last4 == null ? null : String(r.mobile_last4),
    has_email: r.has_email === true, audit_active: r.audit_active === true, operational_active: r.operational_active === true,
  }));
}
