/**
 * lib/readmission/rates.ts — the two reads behind GET /api/care/readmissions/rates (R7 PRD v1.0,
 * R7-1 / R7-2 / R7-8) and the ≤ 15-minute cache. Server-only. READ-ONLY — nothing here mutates.
 *
 *   · NUMERATORS (Neon, parameterised): every detected Even→Even pair at the current engine version,
 *     as the facts the pure core needs — IST index-discharge day, gap, index department, lane, audit
 *     status, stored judgements. The encounter id is read ONLY to resolve the facility by prefix
 *     (the rates payload never carries it — computeRates emits aggregates).
 *   · DENOMINATORS (db13, Metabase, no bind params): IP discharges since the surveillance start,
 *     GROUPED by facility × IST day × department × disposition (`discharge_type_value`, values
 *     grounded live 19 Aug 2026 — see TRUE_IPD_EXCLUDED_DISPOSITIONS). Aggregates only; no patient
 *     column is selected.
 *   · Either read failing → { ok:false } and the route answers "rates unavailable right now" (R7-8):
 *     a rate is a number people quote, so a half-computed one is worse than none.
 *   · Cache: one in-memory entry per server instance, ≤ RATES_CACHE_MS old, keyed by the IST ceiling
 *     day; the payload carries its computed-at stamp so the page can say how fresh it is.
 */
import { sql } from '../db';
import { metabaseQuery } from '../metabase';
import { READMIT_ENGINE_VERSION } from './store';
import { computeRates, istDay, SURVEILLANCE_START, type DischargeBucket, type RatePair, type RatesResult } from '../readmission-rates-core';

export const RATES_CACHE_MS = 15 * 60_000;

export type RatesRead =
  | { ok: true; rates: RatesResult; computedAt: string; cached: boolean; engineVersion: string }
  | { ok: false; reason: 'numerators' | 'denominators' | 'compute'; computedAt: string };

const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const n = (v: unknown): number | null => { const x = Number(v); return Number.isFinite(x) ? x : null; };

/** Neon — the pairs. VERBATIM (parameterised: $1 = engine version). */
export const NUMERATOR_SQL = `SELECT index_encounter_id, lane, audit_status, gap_days, index_department, avoidable, planned, preventable_injury,
       to_char(index_discharge_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS index_day
  FROM readmission_findings
 WHERE engine_version = $1 AND finding_class = 'even_even'`;

/** db13 — the discharge buckets. VERBATIM (no parameters; the start date is a constant). */
export const DENOMINATOR_SQL = `SELECT facility_name,
       to_char(discharge_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
       treating_sub_department_name AS department,
       discharge_type_value AS disposition,
       count(*)::int AS n
  FROM kx_discharged_completed_patients
 WHERE encounter_type = 'ip_admission'
   AND discharge_date >= '${SURVEILLANCE_START}'
 GROUP BY 1, 2, 3, 4`;

export async function readNumerators(engineVersion = READMIT_ENGINE_VERSION): Promise<RatePair[] | null> {
  try {
    const rows = (await sql(NUMERATOR_SQL, [engineVersion])) as Record<string, unknown>[];
    return rows.map((r) => ({
      index_encounter_id: String(r.index_encounter_id ?? ''),
      index_day: s(r.index_day),
      gap_days: n(r.gap_days),
      index_department: s(r.index_department),
      lane: s(r.lane),
      audit_status: s(r.audit_status),
      avoidable: s(r.avoidable),
      planned: s(r.planned),
      preventable_injury: s(r.preventable_injury),
    }));
  } catch {
    return null;
  }
}

export async function readDenominators(): Promise<DischargeBucket[] | null> {
  try {
    const rows = await metabaseQuery(DENOMINATOR_SQL);
    return rows.map((r) => ({ facility: s(r.facility_name), day: s(r.day), department: s(r.department), disposition: s(r.disposition), n: n(r.n) ?? 0 }));
  } catch {
    return null;
  }
}

let cache: { ceilingDay: string; at: number; read: RatesRead } | null = null;

/** The cached read. `now` is injectable for tests; the ceiling is the IST calendar day of `now`. */
export async function readRates(opts?: { now?: Date; force?: boolean; numerators?: () => Promise<RatePair[] | null>; denominators?: () => Promise<DischargeBucket[] | null> }): Promise<RatesRead> {
  const now = opts?.now ?? new Date();
  const ceilingDay = istDay(now) ?? now.toISOString().slice(0, 10);
  if (!opts?.force && cache && cache.ceilingDay === ceilingDay && now.getTime() - cache.at < RATES_CACHE_MS && cache.read.ok) {
    return { ...cache.read, cached: true };
  }
  const safe = async <T,>(fn: () => Promise<T | null>): Promise<T | null> => { try { return await fn(); } catch { return null; } };
  const [pairs, discharges] = await Promise.all([safe(opts?.numerators ?? readNumerators), safe(opts?.denominators ?? readDenominators)]);
  const computedAt = now.toISOString();
  let read: RatesRead;
  if (!pairs) read = { ok: false, reason: 'numerators', computedAt };
  else if (!discharges) read = { ok: false, reason: 'denominators', computedAt };
  else {
    try {
      read = { ok: true, rates: computeRates({ pairs, discharges, ceilingDay }), computedAt, cached: false, engineVersion: READMIT_ENGINE_VERSION };
    } catch {
      read = { ok: false, reason: 'compute', computedAt };
    }
  }
  if (read.ok) cache = { ceilingDay, at: now.getTime(), read };
  return read;
}

/** Test seam. */
export function _resetRatesCache(): void { cache = null; }
