// lib/proms/schedule.ts — PROMs surgical-series DETECTION (wired, fail-safe). Reads db13 THROUGH
// Metabase and compiles the due instruments over the FROZEN catalog. Decision D: detection = flag OR
// surgery_cases, member-keyed, one series, cancelled → clean exit; post-op windows anchor on the
// kx_billing discharge date, falling back to planned_surgery_date.
//
// ⚠ INFERRED SQL (no live DB in this build). Every query is FAIL-SAFE (error → empty/null, never a
// 500, never wrong data) and listed VERBATIM in the report for Cowork to validate live. The
// surgery_cases read + the plan-of-management flag join are MEASURED recipes (PRD §2); the
// kx_billing/kx_uhid discharge SHAPE is INFERRED — column names validated against db13 before go-live.

import { metabaseQuery } from '../metabase';
import { classifyFamily, archetypeFor, instrumentsDue, type DueInstrument } from './schedule-core';
import type { Archetype } from './catalog';
import { getAdhocSetForSeries } from './adhoc-store';
import { compileItemBank, bankById } from './item-bank-core';

const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);
const day = (v: unknown): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, 10) : null; };
const str = (v: unknown): string | null => { const s = v == null ? '' : String(v).trim(); return s || null; };

export interface AdhocSetView {
  id: string; status: 'draft' | 'frozen'; genVersion: string | null;
  items: { id: string; text: string | null; scale: string; sourceSet: string; escalation: string | null; rationale: string | null }[];
}
export interface Tier3State {
  available: boolean;                 // unmapped family + no set yet → the CM may generate one
  set: AdhocSetView | null;           // the current draft (reviewable) or frozen (administered) set
}

export interface SurgicalSeries {
  individualUid: string;
  source: 'surgery_cases' | 'flag';
  procedureName: string | null;
  surgeryTypeUid: string | null;
  family: string;
  archetype: Archetype;
  status: string | null;
  plannedDate: string | null;
  dischargeDate: string | null;
  anchorDate: string;
  due: DueInstrument[];
  tier3?: Tier3State | null;          // Tier-3 (0.2b-2): present only for unmapped families with TIER3_ENABLED
}

// ── VERBATIM SQL (PRD §2). individualUid is isUid-guarded before interpolation. ──
export const surgeryCasesSql = (uid: string): string =>
  `SELECT individual_uid, procedure_name, NULLIF(surgery_type_uid,'') AS surgery_type_uid,
       NULLIF(prescription_uid,'') AS prescription_uid, planned_surgery_date, status, created_at
FROM surgery_cases
WHERE individual_uid = '${uid}'
ORDER BY planned_surgery_date DESC NULLS LAST`;

export const flagSql = (uid: string): string =>
  `SELECT dp.individual_uid, pm.requires_surgery_or_procedure, pm.surgery_or_procedure_recommendation, p.uploaded_at
FROM dpipe_prescription_pipeline__plan_of_management pm
JOIN dpipe_prescription_pipeline dp ON dp._id = pm._parent_id
JOIN "individuals-prescriptions" p ON p._doc_id = dp.presc_uid
WHERE dp.individual_uid = '${uid}' AND pm.requires_surgery_or_procedure = true
ORDER BY p.uploaded_at DESC`;

export const dischargeSql = (uid: string): string =>
  `SELECT b.admission_date_time, b.discharge_date_time
FROM individuals i
JOIN kx_billing_records b ON b.uhid = i.kx_uhid
WHERE i._doc_id = '${uid}' AND b.discharge_date_time IS NOT NULL
ORDER BY b.discharge_date_time DESC LIMIT 1`;

/** Pull the procedure name out of the plan-of-management jsonb recommendation (best-effort). */
function flagProcedureName(row: Record<string, unknown>): string | null {
  try {
    const raw = row.surgery_or_procedure_recommendation;
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(arr)) {
      for (const r of arr) {
        const nm = r?.surgery_or_procedure?.name ?? r?.name;
        if (nm && String(nm).trim()) return String(nm).trim();
      }
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * Detect a member's surgical series and compile the due list. Soft-fails to null (panel hides) on any
 * error or no evidence. `now` (YYYY-MM-DD) is PASSED IN (the route stamps it — no Date.now here).
 */
export async function fetchSurgicalSeries(individualUid: string, now: string): Promise<SurgicalSeries | null> {
  if (!isUid(individualUid)) return null;
  try {
    const [cases, flags] = await Promise.all([
      metabaseQuery(surgeryCasesSql(individualUid)).catch(() => [] as Record<string, unknown>[]),
      metabaseQuery(flagSql(individualUid)).catch(() => [] as Record<string, unknown>[]),
    ]);

    // Booking path: prefer surgery_cases. CANCELLED (latest) → clean exit; else the latest non-cancelled.
    let source: SurgicalSeries['source'] | null = null;
    let procedureName: string | null = null;
    let surgeryTypeUid: string | null = null;
    let plannedDate: string | null = null;
    let status: string | null = null;
    let anchorDate: string | null = null;

    if (cases.length) {
      const nonCancelled = cases.filter((c) => String(c.status ?? '').toUpperCase() !== 'CANCELLED');
      if (!nonCancelled.length) return null;   // every booking cancelled → no series (Decision D)
      const b = nonCancelled[0];               // latest by planned_surgery_date DESC
      source = 'surgery_cases';
      procedureName = str(b.procedure_name);
      surgeryTypeUid = str(b.surgery_type_uid);
      plannedDate = day(b.planned_surgery_date);
      status = str(b.status);
      anchorDate = plannedDate ?? day(b.created_at);
    } else if (flags.length) {
      source = 'flag';
      procedureName = flagProcedureName(flags[0]);
      anchorDate = day(flags[0].uploaded_at);
    }

    if (!source || !anchorDate) return null;   // no surgical evidence

    // Discharge anchor (INFERRED shape) — fail-safe to null → falls back to plannedDate (Decision D).
    const dischargeRows = await metabaseQuery(dischargeSql(individualUid)).catch(() => [] as Record<string, unknown>[]);
    const dischargeDate = dischargeRows.length ? day(dischargeRows[0].discharge_date_time) : null;

    const family = classifyFamily({ surgeryTypeUid, procedureName });
    if (family === 'excluded') return null;   // reserved sentinel (e.g. kidney biopsy) → no series, panel hides
    const archetype = archetypeFor(family);
    const due = instrumentsDue(family, {
      anchorDate,
      plannedSurgeryDate: plannedDate,
      dischargeDate: dischargeDate ?? plannedDate,   // post-op anchors on discharge, else planned
      cancelled: false,
    }, now);

    // Tier-3 (0.2b-2): unmapped family + flag on → attach the adhoc state (existing set to review/administer,
    // or `available` so the panel offers "generate"). Mapped families are UNCHANGED (T2). Off ⇒ undefined.
    let tier3: Tier3State | undefined;
    if (family === 'unknown' && process.env.TIER3_ENABLED === '1') {
      const set = await getAdhocSetForSeries(`psr:${individualUid}`);   // soft-fails to null (never throws)
      tier3 = { available: !set, set: set ? resolveAdhocSetView(set) : null };
    }

    return { individualUid, source, procedureName, surgeryTypeUid, family, archetype, status, plannedDate, dischargeDate, anchorDate, due, tier3 };
  } catch {
    return null;   // fail-safe — the panel hides, never a 500
  }
}

/** Resolve a stored adhoc set's item ids → bank items (verbatim text/scale/sourceSet) for the panel.
 *  Rationale is not persisted, so it reads null on reload (present only right after generation). */
function resolveAdhocSetView(set: { id: string; status: 'draft' | 'frozen'; gen_version: string | null; item_ids: string[] }): AdhocSetView {
  const byId = bankById(compileItemBank());
  const items = set.item_ids
    .map((id) => byId.get(id))
    .filter((b): b is NonNullable<typeof b> => !!b)
    .map((b) => ({ id: b.id, text: b.text, scale: b.scale as string, sourceSet: b.sourceSet, escalation: b.escalation, rationale: null }));
  return { id: set.id, status: set.status, genVersion: set.gen_version, items };
}
