/**
 * lib/doctor-metrics-refresh.ts — the daily unified-metrics refresh (server).
 *
 * Pulls db13 (via the existing Metabase client) and rebuilds two Neon snapshots:
 *  1. doctor_operational_metrics — latest weekly row per canonical doctors.uid
 *     (mv_doctor_weekly_performance joined doctor_email → doctors.email → doctors.uid).
 *  2. doctor_roster — the canonical matching source (db13 doctors run through the identity recipe).
 * Read-only against db13; writes only Neon (staff data, not PHI). Replaces the weekly Claude task.
 */

import { sql } from './db';
import { metabaseQuery } from './metabase';
import { buildRoster, type RosterInput } from './doctor-directory-core';
import {
  upsertOperationalMetrics, upsertRoster, operationalActiveUids,
  type OperationalMetric,
} from './doctor-metrics-store';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';
const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v).trim());
const n = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Latest weekly operational row per doctor, keyed to canonical doctors.uid. */
async function refreshOperational(): Promise<number> {
  const rows = await metabaseQuery(
    `SELECT DISTINCT ON (m.doctor_email)
        d.uid AS doctor_uid, m.doctor_specialty AS specialty, m.doctor_channel_type AS channel,
        to_char(m.week::timestamptz, 'YYYY-MM-DD') AS week, m.total_consults, m.csat_pct, m.patient_noshow_rate,
        m.cancellation_rate, m.missing_prescription_rate
     FROM mv_doctor_weekly_performance m
     JOIN doctors d ON lower(d.email) = lower(m.doctor_email)
     WHERE m.doctor_email IS NOT NULL AND d.uid IS NOT NULL
     ORDER BY m.doctor_email, m.week::timestamptz DESC`);
  const metrics: OperationalMetric[] = rows.map((r) => ({
    doctor_uid: String(r.doctor_uid), week: s(r.week), total_consults: n(r.total_consults),
    csat_pct: n(r.csat_pct), patient_noshow_rate: n(r.patient_noshow_rate), cancellation_rate: n(r.cancellation_rate),
    missing_prescription_rate: n(r.missing_prescription_rate), specialty: s(r.specialty), channel: s(r.channel),
  }));
  return upsertOperationalMetrics(metrics);
}

/** Rebuild the canonical roster from db13 doctors, tagged with audit/operational activity. */
async function refreshRoster(): Promise<{ built: number; upserted: number }> {
  const [docRows, auditRows, opUids] = await Promise.all([
    metabaseQuery(`SELECT uid, name_with_prefix AS name, email, mobile,
        karexpert_metadata__practitioner_id AS kx_id
      FROM doctors WHERE uid IS NOT NULL AND coalesce(disabled, false) = false`),
    run(`SELECT DISTINCT doctor_uid FROM opd_note_audits WHERE app_source=$1 AND doctor_uid IS NOT NULL`, [APP]).catch(() => []),
    operationalActiveUids().catch(() => [] as string[]),
  ]);
  const auditSet = new Set((auditRows as Record<string, unknown>[]).map((r) => String(r.doctor_uid)));
  const opSet = new Set(opUids);

  const inputs: RosterInput[] = docRows.map((r) => {
    const uid = String(r.uid);
    return {
      doctor_uid: uid, name: String(r.name || ''), email: s(r.email), mobile: s(r.mobile),
      specialty: null, channel: null,
      audit_active: auditSet.has(uid), operational_active: opSet.has(uid),
    };
  });
  const roster = buildRoster(inputs);
  const upserted = await upsertRoster(roster);
  return { built: roster.length, upserted };
}

export interface RefreshResult { ok: true; operational_upserted: number; roster_built: number; roster_upserted: number }

/** Full daily refresh: operational first (so the roster can tag operational_active), then roster. */
export async function refreshDoctorMetrics(): Promise<RefreshResult> {
  const operational_upserted = await refreshOperational();
  const { built, upserted } = await refreshRoster();
  return { ok: true, operational_upserted, roster_built: built, roster_upserted: upserted };
}
