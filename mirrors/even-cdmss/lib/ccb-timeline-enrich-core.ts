/**
 * lib/ccb-timeline-enrich-core.ts — CCB v2 Build B: the four timeline enrichment sources (PURE).
 *
 * The dossier's timeline reads OPD + diagnostics + radiology + IPD. These four add the rest of the
 * member's footprint:
 *
 *   kx_lab_reports / kx_radiology_reports   by uhid            → kind 'order'   (the order ledger)
 *   surgery_cases                           by individual_uid  → kind 'surgery'
 *   "individuals-hcu_bookings"              by _parent_id      → kind 'hcu'     (+ docUrl)
 *   "individuals-ip_events"                 by individual_uid  → kind 'event'
 *
 * PURE: no DB, no network. Validated interpolation only (isUid/isUhidLike), mirroring the
 * validate-then-interpolate style of ccb-dossier-core / ccb-search-core. Hyphenated table names are
 * double-quoted. Dates are rendered to the IST calendar day, matching the rest of the dossier.
 *
 * COLUMN DISCIPLINE (see the build report): every column selected below is one the kickoff verified
 * live in db13 on 10 Jul. Nothing is guessed — a single unknown column would error the read, and
 * the wired layer soft-fails it to `[]`, silently dropping the whole source. `_create_time` is cast
 * `::timestamptz` before the time-zone shift so the builder works whether the column is text or
 * already a timestamp.
 */

import type { TimelineItem } from './ccb-dossier-core';

// Validators inlined so the strip-types test loader stays dependency-free — the same reason
// ccb-dossier-core inlines them. Identical regexes; keep them in step.
export const isUid = (u: string): boolean => /^[A-Za-z0-9_-]{6,64}$/.test(u);
export const isUhidLike = (u: string): boolean => /^[A-Za-z0-9][A-Za-z0-9/_-]{2,39}$/.test(u);

/** Single-quote escape + length clamp for a validated literal. */
function sqlStr(s: string, max = 64): string {
  return String(s ?? '').slice(0, max).replace(/'/g, "''");
}

function lim(n: number, max = 100): number {
  return Math.max(1, Math.min(max, Math.floor(n)));
}

/** `<col>` (timestamptz or text) → the IST calendar day, as YYYY-MM-DD. */
function istDay(col: string): string {
  return `to_char(${col}::timestamptz AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')`;
}

const asStr = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

// ── SQL builders ────────────────────────────────────────────────────────────────

/**
 * The kx order ledger: what was ORDERED (not necessarily resulted). Keyed by `uhid` — the member's
 * `kx_uhid`, NOT their individual_uid. Joining on the wrong key here would silently attribute one
 * member's orders to another, so the uhid is validated before it reaches the string.
 */
export function kxOrdersSql(table: 'lab' | 'radiology', kxUhid: string, limit = 40): string {
  if (!isUhidLike(kxUhid)) throw new Error('bad uhid');
  const tbl = table === 'radiology' ? 'kx_radiology_reports' : 'kx_lab_reports';
  const extra = table === 'radiology' ? ', body_part, laterality' : '';
  return `SELECT service_name, treating_ordering_doctor, patient_type${extra},`
    + ` ${istDay('service_date')} AS order_date`
    + ` FROM ${tbl} WHERE uhid = '${sqlStr(kxUhid, 40)}'`
    + ` ORDER BY service_date DESC NULLS LAST LIMIT ${lim(limit)}`;
}

/** The surgery funnel. Keyed by individual_uid. */
export function surgeryCasesSql(individualUid: string, limit = 40): string {
  if (!isUid(individualUid)) throw new Error('bad individual uid');
  return `SELECT procedure_name, status, clinical__status, ot__status, admission__bed_no,`
    + ` financial__insurer_name, ${istDay('_create_time')} AS case_date`
    + ` FROM surgery_cases WHERE individual_uid = '${individualUid}'`
    + ` ORDER BY _create_time DESC NULLS LAST LIMIT ${lim(limit)}`;
}

/** Health-checkup bookings. Parent-keyed (`_parent_id` = individual_uid). Carries the report PDF. */
export function hcuBookingsSql(individualUid: string, limit = 40): string {
  if (!isUid(individualUid)) throw new Error('bad individual uid');
  return `SELECT status, consolidated_report_url, report_url, processed_report_url,`
    + ` ${istDay('_create_time')} AS booking_date`
    + ` FROM "individuals-hcu_bookings" WHERE _parent_id = '${individualUid}'`
    + ` ORDER BY _create_time DESC NULLS LAST LIMIT ${lim(limit)}`;
}

/**
 * In-patient events. Keyed by individual_uid.
 *
 * Only `_create_time` is selected. The kickoff asked me to inspect a live row for an event-label
 * column; this sandbox has no database, and naming a column that does not exist would error the
 * query and silently drop the entire source. So the row is titled generically ("IP event") and the
 * mapper opportunistically reads a label if one ever appears in the row. Flagged in the report.
 */
export function ipEventsSql(individualUid: string, limit = 40): string {
  if (!isUid(individualUid)) throw new Error('bad individual uid');
  return `SELECT ${istDay('_create_time')} AS event_date`
    + ` FROM "individuals-ip_events" WHERE individual_uid = '${individualUid}'`
    + ` ORDER BY _create_time DESC NULLS LAST LIMIT ${lim(limit)}`;
}

// ── Row → TimelineItem mappers ──────────────────────────────────────────────────

/** "Lab ordered: CBC" / "Radiology ordered: USG · Abdomen (Left)". */
export function kxOrderTimeline(rows: Record<string, unknown>[], table: 'lab' | 'radiology'): TimelineItem[] {
  const title = table === 'radiology' ? 'Radiology ordered' : 'Lab ordered';
  return (rows || []).map((r) => {
    const service = asStr(r.service_name);
    const bits: string[] = [];
    if (service) bits.push(service);
    if (table === 'radiology') {
      const part = asStr(r.body_part);
      const lat = asStr(r.laterality);
      const anat = [part, lat].filter(Boolean).join(' · ');
      if (anat) bits.push(anat);
    }
    const doctor = asStr(r.treating_ordering_doctor);
    if (doctor) bits.push(doctor);
    const ptype = asStr(r.patient_type);
    if (ptype) bits.push(ptype);
    return {
      date: asStr(r.order_date),
      kind: 'order' as const,
      title,
      subtitle: bits.join(' · ') || null,
      refUid: null,
    };
  });
}

/**
 * The furthest stage the case reached. OT is downstream of clinical, which is downstream of the
 * case status — so the first non-empty of [ot__status, clinical__status, status] is the frontier.
 */
export function furthestSurgeryStage(row: Record<string, unknown>): string | null {
  return asStr(row.ot__status) ?? asStr(row.clinical__status) ?? asStr(row.status);
}

export function surgeryTimeline(rows: Record<string, unknown>[]): TimelineItem[] {
  return (rows || []).map((r) => {
    const bits: string[] = [];
    const stage = furthestSurgeryStage(r);
    if (stage) bits.push(stage);
    const bed = asStr(r.admission__bed_no);
    if (bed) bits.push(`Bed ${bed}`);
    const insurer = asStr(r.financial__insurer_name);
    if (insurer) bits.push(insurer);
    return {
      date: asStr(r.case_date),
      kind: 'surgery' as const,
      title: asStr(r.procedure_name) ?? 'Surgery case',
      subtitle: bits.join(' · ') || null,
      refUid: null,
    };
  });
}

/** `coalesce(processed_report_url, consolidated_report_url, report_url)`, in that order. */
export function hcuDocUrl(row: Record<string, unknown>): string | null {
  return asStr(row.processed_report_url) ?? asStr(row.consolidated_report_url) ?? asStr(row.report_url);
}

export function hcuTimeline(rows: Record<string, unknown>[]): TimelineItem[] {
  return (rows || []).map((r) => {
    const url = hcuDocUrl(r);
    const item: TimelineItem = {
      date: asStr(r.booking_date),
      kind: 'hcu',
      title: 'Health check-up',
      subtitle: asStr(r.status),
      refUid: null,
    };
    if (url) item.docUrl = url; // absent, not null, when there is no report — old snapshots match
    return item;
  });
}

export function ipEventTimeline(rows: Record<string, unknown>[]): TimelineItem[] {
  return (rows || []).map((r) => ({
    date: asStr(r.event_date),
    kind: 'event' as const,
    // Opportunistic: if a label column is ever added to the SELECT, it titles the row for free.
    title: asStr(r.event_type) ?? asStr(r.event_name) ?? asStr(r.event) ?? 'IP event',
    subtitle: null,
    refUid: null,
  }));
}
