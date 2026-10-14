/**
 * lib/readmission/opd-lvc.ts — hop 1 of the three-hop identity join (CDMSS-READMISSIONS-R4-PRD
 * v1.0 §3, R4-5 / R4-6 / R4-7): the app DB's `opd_note_audits` read for the prescription
 * documents hop 2 found, LATEST AUDIT PER NOTE, plus the latest scope='finding' review verdict
 * per finding (the review status stamped on every surfaced item).
 *
 * READ-ONLY. No new per-patient store (the Twin is parked): this reads existing findings.
 * PHI: the SELECT lists name ids, dates, engine version, doctor_uid (staff data) and the
 * `findings` jsonb — from which only subject / verdict / lvc_category / signal_type /
 * finding_ref / rationale are lifted; the rationale is MODEL INPUT ONLY and passes deidText in
 * the caller before any prompt sees it. Never note text on the page (v1).
 *
 * ONE AUDIT PER NOTE = THE CANONICAL ROW (pre-study finding 2 + the repo's ratified rule): the
 * dedup is canonicalDistinctOnSql from lib/audit-canonical.ts — grader tier, numeric engine
 * version, reference tier, audited_at — the SQL twin of canonicalByUid, which the pure reducer
 * (latestAuditPerNote) applies again in memory. A hand-written note-identity dedup is forbidden
 * here by the tree-walk test in audit-canonical-sql-twin.test.ts. The pre-study counted 20,809
 * distinct audited notes; the canonical row per note is one of them. The engine-family regex is
 * what makes the rule's int[] cast safe (drops `-mini` / `-lab` tagged versions before ranking);
 * failed rows (excluded_reason = 'llm_leg_failed') are not an audit of the note and are skipped.
 *
 *   canonicalDistinctOnSql — one canonical row per note identity:
 *     cols  id, audited_at, engine_version, model, note_date, doctor_uid, findings
 *     FROM  opd_note_audits
 *     WHERE uid = ANY($1)
 *       AND engine_version ~ '^opd-note-audit/[0-9]+(\.[0-9]+)*$'
 *       AND (excluded_reason IS NULL OR excluded_reason <> 'llm_leg_failed')
 *     ORDER BY uid, <CANONICAL_RANK_SQL>
 *
 *   SELECT DISTINCT ON (audit_id, finding_ref) audit_id, finding_ref, verdict
 *     FROM opd_audit_feedback
 *    WHERE scope = 'finding' AND audit_id = ANY($1::uuid[])
 *      AND study IS NOT DISTINCT FROM $2            -- $2 = NULL: production reviews only (§4.2)
 *    ORDER BY audit_id, finding_ref, created_at DESC
 *
 * Fail-safe: any fault → { ok:false } so the caller writes `join_failed` at hop 'audits',
 * never an empty list that reads as clean care.
 */
import { sql } from '../db';
import { canonicalDistinctOnSql } from '../audit-canonical';
import {
  latestAuditPerNote, toReviewStatus, type AuditFinding, type AuditRow, type ReviewStatus,
} from '../readmission-narrative-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/** Lift ONLY the fields R4 needs from a stored findings jsonb (any vintage). */
export function liftAuditFindings(raw: unknown): AuditFinding[] {
  let arr: unknown = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  const out: AuditFinding[] = [];
  for (const f of arr) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const subject = s(o.subject);
    const verdict = s(o.verdict);
    if (!subject || !verdict) continue;
    out.push({
      subject: subject.slice(0, 200),
      verdict,
      lvcCategory: s(o.lvc_category),
      signalType: s(o.signal_type),
      findingRef: s(o.finding_ref),
      rationale: s(o.rationale)?.slice(0, 600) ?? null,
    });
  }
  return out;
}

export interface LatestAuditsResult { ok: boolean; rows: AuditRow[] }

/** Hop 1: the latest audit per note for these uids. Empty input → { ok:true, [] } with NO query. */
export async function fetchLatestAuditsForNotes(uids: readonly string[]): Promise<LatestAuditsResult> {
  const ids = Array.from(new Set(uids.filter((u) => typeof u === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(u))));
  if (!ids.length) return { ok: true, rows: [] };
  try {
    const rows = await run(
      canonicalDistinctOnSql({
        table: 'opd_note_audits', identity: 'uid',
        cols: 'id, audited_at, engine_version, model, note_date, doctor_uid, findings',
        where: `uid = ANY($1) AND engine_version ~ '^opd-note-audit/[0-9]+(\\.[0-9]+)*$' AND (excluded_reason IS NULL OR excluded_reason <> 'llm_leg_failed')`,
      }),
      [ids],
    );
    const mapped: AuditRow[] = rows.map((r) => ({
      auditId: String(r.id),
      uid: String(r.uid),
      auditedAt: r.audited_at == null ? null : new Date(String(r.audited_at)).toISOString(),
      engineVersion: s(r.engine_version),
      model: s(r.model),
      noteDate: r.note_date == null ? null : new Date(String(r.note_date)).toISOString(),
      doctorUid: s(r.doctor_uid),
      findings: liftAuditFindings(r.findings),
    }));
    // The SQL already picked the canonical row per uid; the pure twin restates the same rule so
    // the dedup is a tested fact, not a query detail.
    return { ok: true, rows: latestAuditPerNote(mapped) };
  } catch {
    return { ok: false, rows: [] };
  }
}

/** The latest scope='finding' verdict per (audit_id, finding_ref) → review status. A fault here
 *  degrades to "unreviewed" everywhere (a status, not a join hop) — never blocks the section. */
export async function fetchReviewStatuses(auditIds: readonly string[]): Promise<Map<string, ReviewStatus>> {
  const out = new Map<string, ReviewStatus>();
  const ids = Array.from(new Set(auditIds.filter((u) => /^[0-9a-f-]{36}$/i.test(u))));
  if (!ids.length) return out;
  try {
    // Study-filter (§4.2, D8): PRODUCTION reviews only — a labelling-study row (study IS NOT NULL) is
    // a rater's exercise, not the reviewer's call on this finding, and must not stamp the page.
    const rows = await run(
      `SELECT DISTINCT ON (audit_id, finding_ref) audit_id, finding_ref, verdict
         FROM opd_audit_feedback
        WHERE scope = 'finding' AND audit_id = ANY($1::uuid[])
          AND study IS NOT DISTINCT FROM $2
        ORDER BY audit_id, finding_ref, created_at DESC`,
      [ids, null],
    );
    for (const r of rows) {
      const ref = s(r.finding_ref);
      if (!ref) continue;
      out.set(`${String(r.audit_id)}#${ref}`, toReviewStatus(s(r.verdict)));
    }
  } catch { /* unreviewed everywhere */ }
  return out;
}
