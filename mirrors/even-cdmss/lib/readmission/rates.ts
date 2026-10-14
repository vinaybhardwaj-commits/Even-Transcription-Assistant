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
 *
 * R9 (CDMSS-READMISSIONS-R9-DUAL-CONTRACT PRD, GO 27 Aug 2026) adds the INCIDENCE pair of reads. They
 * are NEW queries; the two above are untouched, and DENOMINATOR_SQL in particular is byte-stable (T2 —
 * it serves every facility and computeRates partitions in JS, so a SQL-level facility filter there
 * would silently zero the EHBR tab; the new incidence denominator is its own query and DOES filter
 * Even in SQL).
 *   · INCIDENCE NUMERATOR (Neon, parameterised): the same even_even pairs (T3) with the person key and
 *     the two stored INSTANTS the clock rule needs (T1). The person key never leaves the server —
 *     computeIncidence emits counts.
 *   · INCIDENCE DENOMINATOR (db13): ONE scalar, count(DISTINCT uhid) over Even completed IP discharges
 *     whose IST discharge day is inside [SURVEILLANCE_START, ceiling − 30] — IST applied to BOTH
 *     bounds (T4). Its failure does NOT fail the rates read: the board keeps its Eligible numbers and
 *     the incidence card alone goes to its explicit unavailable state (T5). People are not stays.
 */
import { sql } from '../db';
import { metabaseQuery } from '../metabase';
import { READMIT_ENGINE_VERSION } from './store';
import { addDays, computeRates, FOLLOW_UP_30, istDay, SURVEILLANCE_START, type DischargeBucket, type IncidencePair, type RatePair, type RatesResult } from '../readmission-rates-core';

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

/**
 * R9 — Neon, the incidence pairs. VERBATIM (parameterised: $1 = engine version).
 *
 * T3: `finding_class = 'even_even'` is repeated on purpose — out_of_network rows live in the same
 * table with a NULL gap and a date-only readmit value, and they are not incidence-countable.
 * T1: both instants are selected as UTC ISO text and the clock is computed from THEM, never from
 * `gap_days`. `uhid` is the person key (D3); it is read server-side and never emitted.
 */
export const INCIDENCE_NUMERATOR_SQL = `SELECT uhid, index_encounter_id, index_department,
       to_char(index_discharge_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS index_day,
       to_char(index_discharge_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS index_discharge_at,
       to_char(readmit_admit_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS readmit_admit_at
  FROM readmission_findings
 WHERE engine_version = $1 AND finding_class = 'even_even'`;

/** A day literal is only ever interpolated after this test — metabaseQuery takes no bind params. */
const DAY_LITERAL = /^\d{4}-\d{2}-\d{2}$/;

/**
 * R9 — db13, the incidence denominator: distinct PEOPLE, not stays (D3). ONE scalar.
 *
 * T4: the IST calendar day is derived once and compared against BOTH bounds, so the floor and the
 * ceiling are the same clock. (The R7 DENOMINATOR_SQL compares its floor in DB time while grouping in
 * IST; that asymmetry is DOCUMENTED, not fixed, this ship — it must stay byte-stable.)
 * The Even filter is safe HERE (and only here) because this query serves the Even headline alone.
 * `endDay` is `ceiling − 30`, computed by the caller and shape-checked before interpolation.
 */
export function incidenceDenominatorSql(endDay: string): string {
  if (!DAY_LITERAL.test(endDay)) throw new Error(`incidence window end must be YYYY-MM-DD — got '${String(endDay)}'`);
  return `SELECT count(DISTINCT uhid)::int AS n
  FROM kx_discharged_completed_patients
 WHERE encounter_type = 'ip_admission'
   AND facility_name = 'Even'
   AND to_char(discharge_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') BETWEEN '${SURVEILLANCE_START}' AND '${endDay}'`;
}

/** The incidence pairs, or null on any fault (the card degrades; the board does not). */
export async function readIncidenceNumerators(engineVersion = READMIT_ENGINE_VERSION): Promise<IncidencePair[] | null> {
  try {
    const rows = (await sql(INCIDENCE_NUMERATOR_SQL, [engineVersion])) as Record<string, unknown>[];
    return rows.map((r) => ({
      person: s(r.uhid),
      index_encounter_id: String(r.index_encounter_id ?? ''),
      index_day: s(r.index_day),
      index_department: s(r.index_department),
      index_discharge_at: s(r.index_discharge_at),
      readmit_admit_at: s(r.readmit_admit_at),
    }));
  } catch {
    return null;
  }
}

/**
 * The distinct-PEOPLE denominator, or null. T5 — null is the ONLY honest degradation: there is no
 * approximation of people by stays anywhere on this path, so a refused `uhid` column, an absent table
 * or a Metabase fault all end as "incidence unavailable" on the card.
 */
export async function readIncidenceDenominator(endDay: string): Promise<number | null> {
  try {
    const rows = await metabaseQuery(incidenceDenominatorSql(endDay));
    const v = n(rows[0]?.n);
    return v != null && v >= 0 ? Math.floor(v) : null;
  } catch {
    return null;
  }
}

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

/**
 * The cached read. `now` is injectable for tests; the ceiling is the IST calendar day of `now`.
 *
 * FOUR reads now, and the asymmetry is deliberate. Either R7 read failing still fails the WHOLE rates
 * payload (R7-8: a half-computed rate is worse than none). Either R9 incidence read failing does NOT:
 * it degrades to `incidencePairs: []` / `incidenceDenominator: null`, which makes exactly one card say
 * INCIDENCE_UNAVAILABLE_COPY while the Eligible board stands (T5).
 */
export async function readRates(opts?: {
  now?: Date; force?: boolean;
  numerators?: () => Promise<RatePair[] | null>;
  denominators?: () => Promise<DischargeBucket[] | null>;
  incidenceNumerators?: () => Promise<IncidencePair[] | null>;
  incidenceDenominator?: (endDay: string) => Promise<number | null>;
}): Promise<RatesRead> {
  const now = opts?.now ?? new Date();
  const ceilingDay = istDay(now) ?? now.toISOString().slice(0, 10);
  if (!opts?.force && cache && cache.ceilingDay === ceilingDay && now.getTime() - cache.at < RATES_CACHE_MS && cache.read.ok) {
    return { ...cache.read, cached: true };
  }
  const incidenceEnd = addDays(ceilingDay, -FOLLOW_UP_30);
  const safe = async <T,>(fn: () => Promise<T | null>): Promise<T | null> => { try { return await fn(); } catch { return null; } };
  const [pairs, discharges, incPairs, incDenom] = await Promise.all([
    safe(opts?.numerators ?? readNumerators),
    safe(opts?.denominators ?? readDenominators),
    safe(opts?.incidenceNumerators ?? readIncidenceNumerators),
    safe(() => (opts?.incidenceDenominator ?? readIncidenceDenominator)(incidenceEnd)),
  ]);
  const computedAt = now.toISOString();
  let read: RatesRead;
  if (!pairs) read = { ok: false, reason: 'numerators', computedAt };
  else if (!discharges) read = { ok: false, reason: 'denominators', computedAt };
  else {
    try {
      // BOTH incidence reads must have succeeded. `incPairs` null (the Neon read failed) is passed
      // through as null, which makes the incidence block absent and the lead card say so — printing
      // "0 of 1,124 people" off a failed numerator would be the same lie in the other direction as
      // printing a stays denominator (T5).
      const rates = computeRates({ pairs, discharges, ceilingDay, incidencePairs: incPairs, incidenceDenominator: incDenom });
      read = { ok: true, rates, computedAt, cached: false, engineVersion: READMIT_ENGINE_VERSION };
    } catch {
      read = { ok: false, reason: 'compute', computedAt };
    }
  }
  if (read.ok) cache = { ceilingDay, at: now.getTime(), read };
  return read;
}

/** Test seam. */
export function _resetRatesCache(): void { cache = null; }
