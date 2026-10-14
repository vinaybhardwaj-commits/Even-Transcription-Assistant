/**
 * lib/readmission/store.ts — persist + read readmission findings (Neon
 * `readmission_findings`, created by /api/admin/migrate-readmissions).
 * Mirrors lib/ipd-audit/store.ts: pure DB layer, no LLM calls, no db13 reads,
 * everything parameterised, idempotent UPSERT on (dedup_key, engine_version).
 *
 * Two write phases share the row:
 *   · saveDetection — Stage-1 upsert. Refreshes detection facts (tags/lane/CM
 *     note) but NEVER clobbers audit output: the ON CONFLICT update lists only
 *     detection columns.
 *   · saveAuditResult — Stage-2 update by key. audit_status moves detected →
 *     audited / not_auditable; a transient failure leaves 'detected' so the sweep
 *     IS the retry (the IPD posture).
 *
 * PHI: the row carries uhid/encounter ids as LINK-BACK keys for the Phase-2
 * surface (kickoff requirement) — never a patient name, never a raw document;
 * `finding` is the de-identified reconciliation output only.
 *
 * Fail-safe: every reader returns []/0 and every writer returns 'skipped' on DB
 * error (e.g. the migration has not run yet) — the worker reports, never 500s.
 */

import { sql } from '../db';
import type { ReadmitPair, OonDetection } from '../readmission-detect-core';
import { pairDedupKey, oonDedupKey } from '../readmission-detect-core';
import type { ReadmissionFinding, LabTier } from '../readmission-reconcile-core';

/** Flags (ship OFF): the Vertex surface is GEMINI_READMIT_AUDIT; the engine version
 *  starts at readmission/0.1 and bumps ONLY on behaviour change (house rule). */
export const READMIT_ENGINE_VERSION = 'readmission/0.1';

export type AuditStatus = 'detected' | 'audited' | 'not_auditable' | 'excluded';

export interface DetectionRow {
  dedupKey: string;
  findingClass: 'even_even' | 'out_of_network';
  indexEncounterId: string;
  readmitEncounterId: string | null;
  formUid: string | null;
  uhid: string | null;
  memberUid: string | null;
  lane: string;
  tags: Record<string, boolean> | null;
  gapDays: number | null;
  indexDepartment: string | null;
  readmitDepartment: string | null;
  indexDoctor: string | null;
  readmitDoctor: string | null;
  indexDischargeAt: string | null;
  readmitAdmitAt: string | null;
  payerIndex: string | null;
  payerReadmit: string | null;
  cmNote: string | null;
  /** POST_IPD form flags (out-of-network classification inputs, §5a). Null = unknown
   *  — recon catch 2: is_planned appears only when true. */
  formIsPlanned: boolean | null;
  formSameCondition: boolean | null;
}

export function pairToDetectionRow(p: ReadmitPair): DetectionRow {
  return {
    dedupKey: pairDedupKey(p.index.encounterId, p.readmit.encounterId),
    findingClass: 'even_even',
    indexEncounterId: p.index.encounterId,
    readmitEncounterId: p.readmit.encounterId,
    formUid: p.formUid ?? null,
    uhid: p.index.uhid,
    memberUid: null,
    lane: p.lane,
    tags: { ...p.tags },
    gapDays: p.gapDays,
    indexDepartment: p.index.department,
    readmitDepartment: p.readmit.department,
    indexDoctor: p.index.doctor,
    readmitDoctor: p.readmit.doctor,
    indexDischargeAt: p.index.dischargeAt,
    readmitAdmitAt: p.readmit.admitAt,
    payerIndex: p.index.payer,
    payerReadmit: p.readmit.payer,
    cmNote: p.cmNote ?? null,
    formIsPlanned: null,
    formSameCondition: null,
  };
}

export function oonToDetectionRow(o: OonDetection): DetectionRow {
  return {
    dedupKey: oonDedupKey(o.index.encounterId, o.formUid),
    findingClass: 'out_of_network',
    indexEncounterId: o.index.encounterId,
    readmitEncounterId: null,
    formUid: o.formUid,
    uhid: o.index.uhid,
    memberUid: o.memberUid,
    lane: 'out_of_network',
    tags: null,
    gapDays: null,
    indexDepartment: o.index.department,
    readmitDepartment: null,
    indexDoctor: o.index.doctor,
    readmitDoctor: null,
    indexDischargeAt: o.index.dischargeAt,
    readmitAdmitAt: o.reportedReadmitDate,
    payerIndex: o.index.payer,
    payerReadmit: null,
    cmNote: o.cmNote,
    formIsPlanned: o.isPlanned,
    formSameCondition: o.sameCondition,
  };
}

/** Stage-1 upsert. Detection columns only in the conflict update — audit output survives. */
export async function saveDetection(row: DetectionRow, engineVersion: string = READMIT_ENGINE_VERSION): Promise<'inserted' | 'updated' | 'skipped'> {
  if (!row.dedupKey || !row.indexEncounterId) return 'skipped';
  try {
    const rows = (await sql(
      `INSERT INTO readmission_findings
        (dedup_key, engine_version, finding_class, index_encounter_id, readmit_encounter_id, form_uid,
         uhid, member_uid, lane, tags, gap_days,
         index_department, readmit_department, index_doctor, readmit_doctor,
         index_discharge_at, readmit_admit_at, payer_index, payer_readmit, cm_note,
         form_is_planned, form_same_condition, audit_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
         CASE WHEN $9 = 'excluded' THEN 'excluded' ELSE 'detected' END)
       ON CONFLICT (dedup_key, engine_version) DO UPDATE SET
         finding_class = EXCLUDED.finding_class, lane = EXCLUDED.lane, tags = EXCLUDED.tags,
         gap_days = EXCLUDED.gap_days,
         index_department = EXCLUDED.index_department, readmit_department = EXCLUDED.readmit_department,
         index_doctor = EXCLUDED.index_doctor, readmit_doctor = EXCLUDED.readmit_doctor,
         index_discharge_at = EXCLUDED.index_discharge_at, readmit_admit_at = EXCLUDED.readmit_admit_at,
         payer_index = EXCLUDED.payer_index, payer_readmit = EXCLUDED.payer_readmit,
         cm_note = COALESCE(EXCLUDED.cm_note, readmission_findings.cm_note),
         form_uid = COALESCE(EXCLUDED.form_uid, readmission_findings.form_uid),
         form_is_planned = COALESCE(EXCLUDED.form_is_planned, readmission_findings.form_is_planned),
         form_same_condition = COALESCE(EXCLUDED.form_same_condition, readmission_findings.form_same_condition)
       RETURNING (xmax = 0) AS inserted`,
      [
        row.dedupKey, engineVersion, row.findingClass, row.indexEncounterId, row.readmitEncounterId,
        row.formUid, row.uhid, row.memberUid, row.lane, JSON.stringify(row.tags ?? null), row.gapDays,
        row.indexDepartment, row.readmitDepartment, row.indexDoctor, row.readmitDoctor,
        row.indexDischargeAt, row.readmitAdmitAt, row.payerIndex, row.payerReadmit, row.cmNote,
        row.formIsPlanned, row.formSameCondition,
      ],
    )) as Array<{ inserted: boolean }>;
    return rows.length ? (rows[0].inserted ? 'inserted' : 'updated') : 'skipped';
  } catch {
    return 'skipped';   // migration not run / DB fault — the worker reports it, never 500s
  }
}

export interface AuditResultWrite {
  dedupKey: string;
  status: Extract<AuditStatus, 'audited' | 'not_auditable'>;
  finding?: ReadmissionFinding | null;
  notAuditableReason?: string | null;
  model?: string | null;
  provider?: string | null;
  traceId?: string | null;
  promoted?: boolean;
  /** Phase 1.5: the tier for a NOT-AUDITABLE write, where there is no finding to read
   *  it off. An audited row takes it from the finding. */
  labTier?: LabTier | null;
}

/** Stage-2 write. On transient failure call recordAuditError instead — status stays
 *  'detected' and the next sweep retries (the sweep IS the retry). */
export async function saveAuditResult(w: AuditResultWrite, engineVersion: string = READMIT_ENGINE_VERSION): Promise<boolean> {
  if (!w.dedupKey) return false;
  const f = w.finding ?? null;
  try {
    const rows = (await sql(
      `UPDATE readmission_findings SET
         audit_status = $3, audited_at = NOW(),
         finding = $4::jsonb, not_auditable_reason = $5,
         planned = $6, same_condition = $7, avoidable = $8,
         lab_timing_profile = $9, n_omissions = $10, needs_human_review = $11,
         promoted_to_full = $12, model = $13, provider = $14, trace_id = $15,
         lab_tier = $16, lab_source_provenance = $17::jsonb, omission_evidence = $18::jsonb,
         last_error = NULL
       WHERE dedup_key = $1 AND engine_version = $2
       RETURNING id`,
      [
        w.dedupKey, engineVersion, w.status,
        f != null ? JSON.stringify(f) : null, w.notAuditableReason ?? null,
        f?.planned?.verdict ?? null, f?.sameCondition?.verdict ?? null, f?.avoidable?.verdict ?? null,
        f?.labProfile ?? null, f?.omissions?.length ?? 0, f?.provenance?.needsHumanReview ?? null,
        w.promoted === true, w.model ?? null, w.provider ?? null, w.traceId ?? null,
        // Phase 1.5: the coverage tier, what it was built from, and the omission
        // evidence rows — surfaced as their own columns so a reviewer can filter on
        // "tier 1 only" without opening every `finding` blob.
        f?.labTier ?? w.labTier ?? null,
        f?.labSourceProvenance != null ? JSON.stringify(f.labSourceProvenance) : null,
        f?.omissions?.length ? JSON.stringify(f.omissions) : null,
      ],
    )) as Array<{ id: string }>;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Best-effort transient-failure note. Never throws; row stays 'detected' for the sweep. */
export async function recordAuditError(dedupKey: string, error: string, engineVersion: string = READMIT_ENGINE_VERSION): Promise<void> {
  try {
    await sql(
      `UPDATE readmission_findings SET last_error = $3, attempts = COALESCE(attempts, 0) + 1
       WHERE dedup_key = $1 AND engine_version = $2`,
      [dedupKey, engineVersion, String(error).slice(0, 2000)],
    );
  } catch { /* observability must never break the audit path */ }
}

export interface PendingRow extends Record<string, unknown> {
  dedup_key: string;
  finding_class: string;
  index_encounter_id: string;
  readmit_encounter_id: string | null;
  form_uid: string | null;
  uhid: string | null;
  lane: string;
  gap_days: number | null;
  index_department: string | null;
  readmit_department: string | null;
  index_doctor: string | null;
  readmit_doctor: string | null;
  index_discharge_at: string | null;
  readmit_admit_at: string | null;
  cm_note: string | null;
  form_is_planned: boolean | null;
  form_same_condition: boolean | null;
}

/** Auditable lanes by default: A (er_routed, tight_bounce), B (structural_30d),
 *  D (other — condition pass, decision 9) and out-of-network (decision 13).
 *  Lane C ('excluded') is sample-only and reachable via an explicit ?lane=excluded. */
export const AUDITABLE_LANES = ['er_routed', 'tight_bounce', 'structural_30d', 'other', 'out_of_network'] as const;

export async function pendingFindings(opts: {
  limit: number;
  lane?: string | null;
  readmitDay?: string | null;   // IST day of the readmit admission (?day=)
  engineVersion?: string;
}): Promise<PendingRow[]> {
  const engine = opts.engineVersion ?? READMIT_ENGINE_VERSION;
  const limit = Math.max(1, Math.min(50, Math.floor(opts.limit)));
  const params: unknown[] = [engine];
  let where = `engine_version = $1 AND audit_status = 'detected'`;
  if (opts.lane) {
    params.push(opts.lane);
    where += ` AND lane = $${params.length}`;
  } else {
    where += ` AND lane IN (${AUDITABLE_LANES.map((l) => `'${l}'`).join(', ')})`;
  }
  if (opts.readmitDay && /^\d{4}-\d{2}-\d{2}$/.test(opts.readmitDay)) {
    params.push(opts.readmitDay);
    where += ` AND (readmit_admit_at AT TIME ZONE 'Asia/Kolkata')::date = $${params.length}::date`;
  }
  try {
    return (await sql(
      `SELECT dedup_key, finding_class, index_encounter_id, readmit_encounter_id, form_uid, uhid, lane,
              gap_days, index_department, readmit_department, index_doctor, readmit_doctor,
              to_char(index_discharge_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS index_discharge_at,
              to_char(readmit_admit_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS readmit_admit_at,
              cm_note, form_is_planned, form_same_condition
         FROM readmission_findings
        WHERE ${where}
        ORDER BY readmit_admit_at ASC NULLS LAST
        LIMIT ${limit}`,
      params,
    )) as PendingRow[];
  } catch {
    return [];
  }
}

// ── Phase 2 (/care/readmissions) — the READ side ────────────────────────────────
// Additive: nothing below writes. The surface renders findings the agent already
// stored, so this is the only new thing the read path needed.

/** One audited finding as the surface reads it (PRD Phase-2 §2). `finding` and
 *  `omission_evidence` come back as jsonb — the Neon driver usually parses them,
 *  but a TEXT-typed round trip is tolerated by the route's asJson(). */
export interface SurfaceRow extends Record<string, unknown> {
  dedup_key: string;
  finding_class: string;
  lane: string;
  audit_status: string;
  index_encounter_id: string;
  readmit_encounter_id: string | null;
  uhid: string | null;
  tags: unknown;
  gap_days: number | null;
  index_department: string | null;
  readmit_department: string | null;
  index_doctor: string | null;
  readmit_doctor: string | null;
  index_discharge_at: string | null;
  readmit_admit_at: string | null;
  payer_index: string | null;
  payer_readmit: string | null;
  cm_note: string | null;
  planned: string | null;
  same_condition: string | null;
  avoidable: string | null;
  lab_tier: string | null;
  lab_timing_profile: string | null;
  n_omissions: number | null;
  needs_human_review: boolean | null;
  promoted_to_full: boolean | null;
  not_auditable_reason: string | null;
  finding: unknown;
  omission_evidence: unknown;
}

export interface SurfaceRead {
  rows: SurfaceRow[];
  /** Still 'detected' — the "N pending audit" note. Not renderable as a finding. */
  pendingCount: number;
  /** The chooser badge: audited AND avoidable IN ('avoidable','needs_adjudication'). */
  reviewCount: number;
}

/** Hard cap on what one page load reads. The detector's window is 90 days; 500 is
 *  well above the measured pair count and keeps a runaway table off the page. */
const SURFACE_LIMIT = 500;

/**
 * Read the audited findings the /care/readmissions surface renders, plus the two
 * counts the page and the chooser badge need. READ-ONLY.
 *
 * `not_auditable` and `excluded` rows are included ONLY when explicitly asked for, so
 * that any OTHER caller still gets the audited findings and nothing else. The care
 * surface asks for both (Phase 2.1, decision 1): the held-out sample is expected by
 * design and reads as context, not as a queue — the board collapses it.
 *
 * Fail-safe (house posture): any DB error — including the migration not having run —
 * degrades to an empty board with zero counts, never a 500. An empty surface says
 * "nothing to review", which is the truthful reading of "we cannot see anything".
 */
export async function listFindingsForSurface(opts?: {
  engineVersion?: string;
  lane?: string | null;
  includeNotAuditable?: boolean;
  /** Add the held-out sample (audit_status 'excluded' — oncology / dialysis /
   *  obstetric returns). Off by default; the care surface turns it on. */
  includeExcluded?: boolean;
  limit?: number;
}): Promise<SurfaceRead> {
  const engine = opts?.engineVersion ?? READMIT_ENGINE_VERSION;
  const limit = Math.max(1, Math.min(SURFACE_LIMIT, Math.floor(opts?.limit ?? SURFACE_LIMIT)));
  // The status allowlist is assembled from literals in THIS function — no caller value
  // reaches the SQL text. 'detected' is never a member: a row the sweep has not reached
  // has nothing to render, and the pending count reports it instead.
  const statuses: AuditStatus[] = ['audited'];
  if (opts?.includeNotAuditable) statuses.push('not_auditable');
  if (opts?.includeExcluded) statuses.push('excluded');
  const params: unknown[] = [engine];
  let where = `engine_version = $1 AND audit_status IN (${statuses.map((st) => `'${st}'`).join(',')})`;
  if (opts?.lane) {
    params.push(opts.lane);
    where += ` AND lane = $${params.length}`;
  }
  try {
    const [rows, counts] = await Promise.all([
      sql(
        `SELECT dedup_key, finding_class, lane, audit_status, index_encounter_id, readmit_encounter_id,
                uhid, tags, gap_days, index_department, readmit_department, index_doctor, readmit_doctor,
                to_char(index_discharge_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS index_discharge_at,
                to_char(readmit_admit_at,   'YYYY-MM-DD"T"HH24:MI:SSOF') AS readmit_admit_at,
                payer_index, payer_readmit, cm_note,
                planned, same_condition, avoidable, lab_tier, lab_timing_profile,
                n_omissions, needs_human_review, promoted_to_full, not_auditable_reason,
                finding, omission_evidence
           FROM readmission_findings
          WHERE ${where}
          ORDER BY readmit_admit_at DESC NULLS LAST
          LIMIT ${limit}`,
        params,
      ),
      sql(
        `SELECT
           count(*) FILTER (WHERE audit_status = 'detected')::int AS pending,
           count(*) FILTER (WHERE audit_status = 'audited'
                              AND avoidable IN ('avoidable','needs_adjudication'))::int AS review
         FROM readmission_findings WHERE engine_version = $1`,
        [engine],
      ),
    ]);
    const c = (counts as Array<{ pending: number; review: number }>)[0];
    return {
      rows: rows as SurfaceRow[],
      pendingCount: Number(c?.pending ?? 0),
      reviewCount: Number(c?.review ?? 0),
    };
  } catch {
    return { rows: [], pendingCount: 0, reviewCount: 0 };
  }
}

/**
 * The chooser badge alone (app/care/page.tsx). Same predicate as listFindingsForSurface's
 * `review` count — deliberately one SQL expression duplicated in one other place and
 * nowhere else, because the badge must not be able to disagree with the page. Soft-fails
 * to 0 like every other count on that page.
 */
export async function reviewCountForChooser(engineVersion: string = READMIT_ENGINE_VERSION): Promise<number> {
  try {
    const rows = (await sql(
      `SELECT count(*)::int AS n FROM readmission_findings
        WHERE engine_version = $1 AND audit_status = 'audited'
          AND avoidable IN ('avoidable','needs_adjudication')`,
      [engineVersion],
    )) as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

/** Status/lane rollup for the worker's response (V's lane-count validation, §12.5). */
export async function findingCounts(engineVersion: string = READMIT_ENGINE_VERSION): Promise<{
  byLane: Record<string, number>; byStatus: Record<string, number>; total: number;
}> {
  try {
    const rows = (await sql(
      `SELECT lane, audit_status, count(*)::int AS n
         FROM readmission_findings WHERE engine_version = $1 GROUP BY lane, audit_status`,
      [engineVersion],
    )) as Array<{ lane: string; audit_status: string; n: number }>;
    const byLane: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byLane[r.lane] = (byLane[r.lane] ?? 0) + Number(r.n);
      byStatus[r.audit_status] = (byStatus[r.audit_status] ?? 0) + Number(r.n);
      total += Number(r.n);
    }
    return { byLane, byStatus, total };
  } catch {
    return { byLane: {}, byStatus: {}, total: 0 };
  }
}
