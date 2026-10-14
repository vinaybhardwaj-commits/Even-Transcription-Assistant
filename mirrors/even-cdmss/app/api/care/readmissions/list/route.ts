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
import { listFindingsForSurface, type SurfaceRow } from '@/lib/readmission/store';
import { computeTiles, groupByLane, type FindingBlob, type SurfaceFinding } from '@/lib/readmission-surface-core';

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

/** jsonb tolerance: the Neon driver normally hands back a parsed object, but a
 *  TEXT-typed round trip returns the string. Anything else → null, never a throw. */
function asJson<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'object') return v as T;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return null; } }
  return null;
}

// ── db13: the display name (decision 5) ─────────────────────────────────────────

interface Identity { name: string | null; uhid: string | null; ageGender: string | null }

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
    out.set(id, { name: s(r.patient_name), uhid: s(r.uhid), ageGender: s(r.age_gender) });
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

// ── row → SurfaceFinding ────────────────────────────────────────────────────────

function toFinding(r: SurfaceRow, id: Identity | undefined): SurfaceFinding {
  const blob = asJson<FindingBlob>(r.finding);
  return {
    dedupKey: String(r.dedup_key),
    findingClass: String(r.finding_class),
    lane: String(r.lane),
    auditStatus: String(r.audit_status),
    // Name from KX at render; the UHID on the finding row is the authoritative
    // secondary identifier and wins over the joined one (it is what the agent keyed on).
    patientName: id?.name ?? null,
    uhid: s(r.uhid) ?? id?.uhid ?? null,
    ageGender: id?.ageGender ?? null,
    gapDays: r.gap_days == null ? null : Number(r.gap_days),
    indexDepartment: s(r.index_department),
    readmitDepartment: s(r.readmit_department),
    indexDoctor: s(r.index_doctor),
    readmitDoctor: s(r.readmit_doctor),
    indexDischargeAt: s(r.index_discharge_at),
    readmitAdmitAt: s(r.readmit_admit_at),
    payerIndex: s(r.payer_index),
    payerReadmit: s(r.payer_readmit),
    cmNote: s(r.cm_note),
    planned: s(r.planned),
    sameCondition: s(r.same_condition),
    avoidable: s(r.avoidable),
    labTier: s(r.lab_tier),
    labTimingProfile: s(r.lab_timing_profile),
    nOmissions: r.n_omissions == null ? null : Number(r.n_omissions),
    needsHumanReview: r.needs_human_review == null ? null : Boolean(r.needs_human_review),
    promotedToFull: r.promoted_to_full == null ? null : Boolean(r.promoted_to_full),
    notAuditableReason: s(r.not_auditable_reason),
    finding: blob,
    omissionEvidence: asJson<FindingBlob['omissions']>(r.omission_evidence) ?? blob?.omissions ?? null,
  };
}

export async function GET() {
  if (!enabled()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  // Phase 2.1 decision 1: the board shows the held-out sample and the unauditable rows
  // too — collapsed and labelled, not queued. The store default stays audited-only for
  // every other caller.
  const read = await listFindingsForSurface({ includeNotAuditable: true, includeExcluded: true });
  const ids = [...new Set(read.rows.map((r) => String(r.index_encounter_id)).filter(isEncounterId))];

  // All three db13 reads run together and each soft-fails on its own; none of them can
  // fail the response. Awaited with Promise.all (not allSettled) because every one of
  // them already resolves rather than rejects.
  const [adt, summaries, denominator] = await Promise.all([
    namesFromAdt(ids),
    identityFromSummaries(ids),
    ipDischargeDenominator(),
  ]);

  const rows = read.rows.map((r) => {
    const key = String(r.index_encounter_id);
    const a = adt.get(key);
    const b = summaries.get(key);
    // Decision 5 names the ADT table as the source; the summary record fills the gaps
    // it cannot answer (age/sex) and stands in when the ADT join found nothing.
    const id: Identity = { name: a?.name ?? b?.name ?? null, uhid: a?.uhid ?? b?.uhid ?? null, ageGender: b?.ageGender ?? null };
    return toFinding(r, id);
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
  });
}
