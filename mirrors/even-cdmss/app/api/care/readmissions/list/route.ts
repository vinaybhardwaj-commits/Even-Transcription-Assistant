/**
 * GET /api/care/readmissions/list — the read behind /care/readmissions
 * (CDMSS-READMISSION-PHASE-2-CARE-SURFACE-PRD-v1.0 §2/§3).
 *
 * READ-ONLY. Three reads, all fail-safe, none of which mutates anything:
 *   1. Neon — the audited findings the agent already stored (listFindingsForSurface).
 *   2. db13 — the patient NAME for display (decision 5) and age/sex, joined by
 *      encounter id. A failed join costs the name, never the card: the identity line
 *      falls back to the UHID already on the finding row.
 *   3. db13 — the IP-discharge denominator for the 30-day-rate tile. Unavailable →
 *      the tile shows "—" rather than a rate built on a guessed denominator.
 *   4. Neon — R1 (READMISSIONS-R1 PRD v1.1 §6): the index extract for each row, ONE
 *      batch query on discharge_extracted_cases, emitted per row as `indexCase`
 *      (additive payload). Join down → indexCase: null → thinner card, chips unknown.
 *   5. db13 — R3 (READMISSIONS-R3 PRD v1.0 §3.2): the RETURN STAY'S HOSPITAL BILL, ONE
 *      batched SUM(net_amt) over kx_billing_records for every readmit encounter id, computed
 *      fresh on every read and never stored (R3-2). Emitted per row as the `returnBill`
 *      value object (R3-5 — the encounter id stays off the client) plus the top-level
 *      `billsResolved` honesty flag. Fault → every card `unknown`, never a 500 (R3-6).
 *
 * PHI: the patient name is read here and rendered behind the care-manager gate. It is
 * NOT persisted, and there is no model call anywhere on this surface — the audit that
 * produced these findings already ran de-identified, and nothing here re-opens that.
 *
 * ⚠️ SQL HONESTY: this sandbox has no live db13. The KX queries below are INFERRED
 * except where marked VALIDATED (kx_discharge_summary_records.ipd_no / patient_name /
 * uhid / age_gender are read in production today by lib/ipd-audit/db13.ts). Every one
 * degrades to "no name" / "no denominator" on any error.
 */
import { NextResponse } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { metabaseQuery } from '@/lib/metabase';
import { ADT_COLUMN_CANDIDATES } from '@/lib/readmission-detect-core';
import { listFindingsForSurface } from '@/lib/readmission/store';
import { fetchExtractedCases } from '@/lib/discharge-extract-store';
import { fetchStayBillTotals } from '@/lib/readmission/db13';
import { asJson, indexDocumentIdOf, readmitDocumentIdOf, returnContextOf, toFinding, toIndexCaseSummary, type Identity } from '@/lib/readmission/surface-row';
import { caseLine, computeTiles, groupByLane, returnBillFor, toFindingClass, type FindingBlob } from '@/lib/readmission-surface-core';
import { stripCaseArtefacts } from '@/lib/readmission-narrative-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function enabled(): boolean {
  return process.env.CCB_ENABLED === '1' && process.env.READMISSIONS_SURFACE_ENABLED === '1';
}
async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

const esc = (s: string) => s.replace(/'/g, "''");
const isEncounterId = (s: string) => /^[A-Za-z0-9/_-]{2,40}$/.test(s);
const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const pick = (row: Record<string, unknown>, candidates: readonly string[]): unknown => {
  for (const c of candidates) if (c in row && row[c] != null && row[c] !== '') return row[c];
  return null;
};

// ── db13: the display name (decision 5) ─────────────────────────────────────────

/** Which column actually holds the encounter id in kx_discharged_completed_patients.
 *  Resolved once per process by trying the candidate list, then remembered — the
 *  detector's zero-lanes defect (5 Aug) was exactly a wrongly-assumed column name, so
 *  this probes rather than assumes. */
let adtIdCol: string | null = null;

/**
 * INFERRED SQL (decision 5 — kx_discharged_completed_patients, by encounter id):
 *   SELECT * FROM kx_discharged_completed_patients WHERE <id_col> IN ('…') LIMIT 600
 * <id_col> ∈ encounter_id | ipd_no | ip_no | encounter_no | admission_no | ip_number.
 */
async function namesFromAdt(ids: string[]): Promise<Map<string, Identity>> {
  const out = new Map<string, Identity>();
  if (!ids.length) return out;
  const list = ids.map((i) => `'${esc(i)}'`).join(',');
  const candidates = adtIdCol ? [adtIdCol] : [...ADT_COLUMN_CANDIDATES.encounterId];
  for (const col of candidates) {
    let rows: Record<string, unknown>[];
    try {
      rows = await metabaseQuery(
        `SELECT * FROM kx_discharged_completed_patients WHERE ${col} IN (${list}) LIMIT 600`);
    } catch {
      continue;   // column does not exist on this table — try the next candidate
    }
    if (!rows.length) continue;   // exists but matched nothing: probably not the id column
    adtIdCol = col;
    for (const r of rows) {
      const id = s(r[col]);
      if (!id || out.has(id)) continue;
      out.set(id, {
        name: s(pick(r, ADT_COLUMN_CANDIDATES.patientName)),
        uhid: s(pick(r, ADT_COLUMN_CANDIDATES.uhid)),
        ageGender: null,   // the ADT table carries dob, not the "34M" the card shows
        // R6 (Readmissions R6 PRD v1.0, R6-1): the hospital rides THIS join — facility_name is on
        // every kx_discharged_completed_patients row (measured: two facilities, zero nulls) and was
        // already fetched by the SELECT * above. No new query; null when the join finds nothing.
        facility: s(r.facility_name),
      });
    }
    return out;
  }
  return out;
}

/**
 * VALIDATED SQL (lib/ipd-audit/db13.ts reads these exact columns in production today).
 * Two jobs: the age/sex the mockup's identity line shows — which the ADT table does not
 * carry in that form — and a name fallback when the decision-5 join comes back empty.
 *   SELECT ipd_no, patient_name, uhid, age_gender, status
 *     FROM kx_discharge_summary_records WHERE ipd_no IN ('…')
 *    ORDER BY (status='Final') DESC
 */
async function identityFromSummaries(ids: string[]): Promise<Map<string, Identity>> {
  const out = new Map<string, Identity>();
  if (!ids.length) return out;
  const list = ids.map((i) => `'${esc(i)}'`).join(',');
  let rows: Record<string, unknown>[];
  try {
    rows = await metabaseQuery(
      `SELECT ipd_no, patient_name, uhid, age_gender, status
         FROM kx_discharge_summary_records WHERE ipd_no IN (${list})
        ORDER BY (status='Final') DESC LIMIT 600`);
  } catch {
    return out;
  }
  for (const r of rows) {
    const id = s(r.ipd_no);
    if (!id || out.has(id)) continue;   // ORDER BY put the Final row first
    out.set(id, { name: s(r.patient_name), uhid: s(r.uhid), ageGender: s(r.age_gender), facility: null });   // the summary record carries no facility
  }
  return out;
}

/**
 * INFERRED SQL — the 30-day-rate DENOMINATOR. `discharge_date` and `encounter_type` are
 * the columns the detector resolved live (Phase 1, 5 Aug). Null on any error, and the
 * tile then shows "—": a rate is a number people quote, so a wrong denominator is worse
 * than no denominator.
 *   SELECT count(*)::int n FROM kx_discharged_completed_patients
 *    WHERE encounter_type = 'ip_admission' AND discharge_date >= NOW() - INTERVAL '90 days'
 */
async function ipDischargeDenominator(): Promise<number | null> {
  try {
    const rows = await metabaseQuery(
      `SELECT count(*)::int AS n FROM kx_discharged_completed_patients
        WHERE encounter_type = 'ip_admission'
          AND discharge_date >= NOW() - INTERVAL '90 days'`);
    const n = Number(rows[0]?.n);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// ── row → SurfaceFinding: lib/readmission/surface-row.ts (shared with the case route) ──

export async function GET() {
  if (!enabled()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  // Phase 2.1 decision 1: the board shows the held-out sample and the unauditable rows
  // too — collapsed and labelled, not queued. The store default stays audited-only for
  // every other caller.
  const read = await listFindingsForSurface({ includeNotAuditable: true, includeExcluded: true });
  const ids = [...new Set(read.rows.map((r) => String(r.index_encounter_id)).filter(isEncounterId))];
  // R3 §3.2: the readmit encounter ids — non-null and id-shaped. OON and null-readmit rows are
  // skipped here (they render n/a regardless); the batch fetch dedups and caps once more.
  const readmitIds = read.rows
    .map((r) => (r.readmit_encounter_id == null ? null : String(r.readmit_encounter_id)))
    .filter((d): d is string => d != null && isEncounterId(d));

  // All three db13 reads run together and each soft-fails on its own; none of them can
  // fail the response. Awaited with Promise.all (not allSettled) because every one of
  // them already resolves rather than rejects.
  // R1 (PRD v1.1 §6, decision 4): the ONE bounded join to discharge_extracted_cases —
  // every non-null index document id, narrowed off the stored provenance, in one query.
  // fetchExtractedCases returns an empty map on any fault, so a store outage costs the
  // diagnosis/procedure/indication segments and turns the Index DS chip unknown — never
  // the page.
  // R7 (R7-6): the READMIT document ids join the same batch — the staged-return match reads the return
  // stay's extracted procedure. One query still; a missing readmit extract costs the marker only.
  const indexDocIds = read.rows
    .flatMap((r) => { const b = asJson<FindingBlob>(r.finding); return [indexDocumentIdOf(b), readmitDocumentIdOf(b)]; })
    .filter((d): d is string => d != null);

  // R3: fetchStayBillTotals resolves { ok:false, empty Map } on a db13 fault — the route
  // then emits every card as `unknown` and billsResolved:false; nothing rejects here.
  const [adt, summaries, denominator, extracts, bills] = await Promise.all([
    namesFromAdt(ids),
    identityFromSummaries(ids),
    ipDischargeDenominator(),
    fetchExtractedCases(indexDocIds),
    fetchStayBillTotals(readmitIds),
  ]);

  const rows = read.rows.map((r) => {
    const key = String(r.index_encounter_id);
    const a = adt.get(key);
    const b = summaries.get(key);
    // Decision 5 names the ADT table as the source; the summary record fills the gaps
    // it cannot answer (age/sex) and stands in when the ADT join found nothing.
    const id: Identity = { name: a?.name ?? b?.name ?? null, uhid: a?.uhid ?? b?.uhid ?? null, ageGender: b?.ageGender ?? null, facility: a?.facility ?? null };
    const blob = asJson<FindingBlob>(r.finding);
    const docId = indexDocumentIdOf(blob);
    const indexExtracted = docId ? extracts.get(docId)?.extracted ?? null : null;
    const indexCase = docId ? toIndexCaseSummary(indexExtracted) : null;
    const readmitDocId = readmitDocumentIdOf(blob);
    const readmitExtracted = readmitDocId ? extracts.get(readmitDocId)?.extracted ?? null : null;
    // R3-6 state rules, in ONE pure mapping (returnBillFor): class → na · ok:false → unknown ·
    // id absent from the totals → not_finalised · present → billed with the computed sum.
    const readmitId = r.readmit_encounter_id == null ? null : String(r.readmit_encounter_id);
    const returnBill = returnBillFor({
      findingClass: toFindingClass(r.finding_class),
      readmitEncounterId: readmitId != null && isEncounterId(readmitId) ? readmitId : null,
      ok: bills.ok,
      total: readmitId ? bills.totals.get(readmitId) : null,
    });
    // R7 (R7-5 / R7-6): the return context — code-derived markers, nothing stored, no verdict touched.
    const f = toFinding(r, id, indexCase, returnBill, returnContextOf(r, blob, indexExtracted, readmitExtracted));
    // R4: the card renders neither the evidence ledger nor the narrative text — strip them from
    // the list payload (the case route emits them in full). The small facts (narrative present /
    // valid, relatedLvc state + denominator) stay so a later card affordance can read them.
    // R4.1 (R41-3): the CASE LINE is derived here, from the full valid narrative, before the strip —
    // pure derivation at read time, nothing stored.
    return { ...f, caseLine: caseLine(f.finding?.caseNarrative), finding: stripCaseArtefacts(f.finding) };
  });

  // Phase 2.1 decision 2: the tiles keep their AUDITED-ONLY basis. The held-out sample
  // is expected by design — counting it would inflate the readmission rate this surface
  // asks people to quote, in the opposite direction from every CMS-style measure, which
  // drops expected returns. Grouping shows everything; the tiles measure the audited set.
  // (isReviewFinding already requires 'audited', so the review counts cannot move here.)
  const audited = rows.filter((r) => r.auditStatus === 'audited');

  return NextResponse.json({
    ok: true,
    lanes: groupByLane(rows),
    tiles: computeTiles(audited, denominator),
    pendingCount: read.pendingCount,
    reviewCount: read.reviewCount,
    total: rows.length,
    /** Honest signal for the page: the name column never resolved, so cards show UHIDs. */
    namesResolved: rows.some((r) => r.patientName != null),
    /** R3 sibling: the batched bill fetch answered (ok). False → every cell reads unknown and
     *  the board shows the quiet bills-unavailable notice. */
    billsResolved: bills.ok,
  });
}
