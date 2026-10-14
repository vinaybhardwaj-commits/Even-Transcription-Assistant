/**
 * lib/audit-suppression-store.ts — Tier 1 self-healing: the suppression store (Neon, WIRED).
 *
 * `audit_suppression` holds human-approved, narrowly-scoped, reversible FP suppressions consulted by
 * the audit pipeline (applySuppressions). Plus the valid-label-set read the dual-label safety check
 * (previewCollateral) runs before activation. Table created by /api/admin/migrate-audit-suppression.
 */

import { randomUUID } from 'crypto';
import { sql } from './db';
import { OPD_ENGINE_VERSION, stampFindingIdentity, type OpdFinding } from './opd-note-audit-core';
import { parseJson } from './opd-audit-ui';
import { loadValidLabelDoctors } from './opd-triage-store';
import { ruleViolatesSeverityFloor, findingMatchesSuppression, isSafetySignalType, type Suppression, type ValidLabelInstance, type SuppressionAction, type SuppressionMatch, type SuppressionScope } from './audit-suppression-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

export async function ensureSuppressionTable(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS audit_suppression (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    app_source        text NOT NULL DEFAULT 'standalone',
    signal_type       text NOT NULL,
    discriminator     text,
    match_kind        text NOT NULL DEFAULT 'type_only',
    scope             text NOT NULL DEFAULT 'all',
    doctor_uid        text,
    action            text NOT NULL DEFAULT 'downgrade',
    source_triage_ref uuid,
    reason            text,
    created_by        text,
    active            boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
  )`, []);
  await run(`CREATE INDEX IF NOT EXISTS audit_suppression_active_idx ON audit_suppression (active, signal_type)`, []);
  // Quieting (Q5 provenance) — additive + idempotent, also run by the migration route.
  await run(`ALTER TABLE audit_suppression ADD COLUMN IF NOT EXISTS approved_by text`, []);
  await run(`ALTER TABLE audit_suppression ADD COLUMN IF NOT EXISTS approved_at timestamptz`, []);
  await run(`ALTER TABLE audit_suppression ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'proposed'`, []);
  // Pre-quieting rows keyed on `active` alone — mark them retired-status so the quieting UI never
  // shows them as pending proposals. Never touches demote rows (their status IS the workflow).
  await run(`UPDATE audit_suppression SET status='retired' WHERE action <> 'demote' AND status = 'proposed'`, []);
  await run(`CREATE TABLE IF NOT EXISTS quieting_policy_log (
    gen         integer PRIMARY KEY,
    rule_id     uuid,
    rule_action text NOT NULL,
    admin       text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
  )`, []);
  await run(`ALTER TABLE opd_note_audits ADD COLUMN IF NOT EXISTS quieting_gen integer NOT NULL DEFAULT 0`, []);
}

export interface SuppressionRow extends Suppression {
  id: string; reason: string | null; created_by: string | null; source_triage_ref: string | null; created_at: string;
  approved_by: string | null; approved_at: string | null;
}
function rowToSuppression(r: Record<string, unknown>): SuppressionRow {
  return {
    id: String(r.id), signal_type: String(r.signal_type),
    discriminator: r.discriminator == null ? null : String(r.discriminator),
    match_kind: (String(r.match_kind || 'type_only') as SuppressionMatch),
    scope: (String(r.scope || 'all') as SuppressionScope),
    doctor_uid: r.doctor_uid == null ? null : String(r.doctor_uid),
    action: (String(r.action || 'downgrade') as SuppressionAction),
    active: r.active === true || r.active === 't' || r.active === 'true',
    status: (['proposed', 'active', 'retired'].includes(String(r.status)) ? String(r.status) : 'retired') as SuppressionRow['status'],
    reason: r.reason == null ? null : String(r.reason),
    created_by: r.created_by == null ? null : String(r.created_by),
    source_triage_ref: r.source_triage_ref == null ? null : String(r.source_triage_ref),
    created_at: r.created_at == null ? '' : new Date(String(r.created_at)).toISOString(),
    approved_by: r.approved_by == null ? null : String(r.approved_by),
    approved_at: r.approved_at == null ? null : new Date(String(r.approved_at)).toISOString(),
  };
}
const COLS = `id, signal_type, discriminator, match_kind, scope, doctor_uid, action, source_triage_ref, reason, created_by, active, created_at, approved_by, approved_at, status`;

export async function listSuppressions(activeOnly = false): Promise<SuppressionRow[]> {
  const where = activeOnly ? `WHERE active = true` : '';
  const rows = await run(`SELECT ${COLS} FROM audit_suppression ${where} ORDER BY created_at DESC LIMIT 1000`, []).catch(() => []);
  return (rows as Record<string, unknown>[]).map(rowToSuppression);
}

/** Active drop/downgrade suppressions the audit pipeline consults (cached by the caller).
 *  Demote rules are deliberately EXCLUDED — they flow through the quieting seam (applyDemotes),
 *  which stamps quieted_by + rides the policy generation; letting them into applySuppressions
 *  would downgrade without provenance. */
export async function loadActiveSuppressions(): Promise<Suppression[]> {
  return (await listSuppressions(true)).filter((s) => s.action !== 'demote').map((s) => ({
    id: s.id, signal_type: s.signal_type, discriminator: s.discriminator, match_kind: s.match_kind,
    scope: s.scope, doctor_uid: s.doctor_uid, action: s.action, active: s.active,
  }));
}

/** ACTIVE demote rules + the current policy generation, in one read for the engine seam.
 *  Fail-safe at the caller: any throw here must degrade to { rules: [], gen: 0 }. */
export async function loadQuietingConfig(): Promise<{ rules: Suppression[]; gen: number }> {
  const [rows, genRows] = await Promise.all([
    run(`SELECT ${COLS} FROM audit_suppression WHERE action='demote' AND status='active' AND active=true ORDER BY created_at ASC LIMIT 500`, []),
    run(`SELECT coalesce(max(gen), 0)::int AS gen FROM quieting_policy_log`, []),
  ]);
  return {
    rules: (rows as Record<string, unknown>[]).map(rowToSuppression),
    gen: Number((genRows[0] as Record<string, unknown> | undefined)?.gen ?? 0) || 0,
  };
}

/** Total quieted findings on stored audits in the last 30 days (the SignalHealthPanel volume guard —
 *  if quieting ever silences a majority of low-value findings, that must be VISIBLE). Read-only. */
export async function quietedVolume30d(): Promise<{ quieted: number; low_value: number }> {
  const rows = await run(
    `SELECT count(*) FILTER (WHERE f->>'quieted_by' IS NOT NULL)::int AS quieted,
            count(*) FILTER (WHERE f->>'verdict' = 'low-value')::int AS low_value
     FROM opd_note_audits, jsonb_array_elements(findings) f
     WHERE app_source=$1 AND (note_date AT TIME ZONE 'Asia/Kolkata')::date > (now() AT TIME ZONE 'Asia/Kolkata')::date - 30 AND excluded_reason IS DISTINCT FROM 'llm_leg_failed'`,
    [APP]).catch(() => []);
  const r = rows[0] as Record<string, unknown> | undefined;
  return { quieted: Number(r?.quieted ?? 0) || 0, low_value: Number(r?.low_value ?? 0) || 0 };
}

/** Current quieting-policy generation (0 = no policy has ever activated). */
export async function currentQuietingGen(): Promise<number> {
  const rows = await run(`SELECT coalesce(max(gen), 0)::int AS gen FROM quieting_policy_log`, []).catch(() => []);
  return Number((rows[0] as Record<string, unknown> | undefined)?.gen ?? 0) || 0;
}

/**
 * Activate a proposed demote rule (admin surface only — the ROUTE enforces admin; Q5 records the
 * ROLE, never a person). Increments the policy generation and logs it. Returns null if the rule
 * is missing or not a demote proposal.
 */
export async function approveDemoteRule(id: string): Promise<{ rule: SuppressionRow; gen: number } | null> {
  const rows = await run(`SELECT ${COLS} FROM audit_suppression WHERE id=$1 AND action='demote'`, [id]);
  if (!rows[0]) return null;
  if (String((rows[0] as Record<string, unknown>).status) === 'active') return { rule: rowToSuppression(rows[0]), gen: await currentQuietingGen() };
  await run(`UPDATE audit_suppression SET status='active', active=true, approved_by='admin', approved_at=now(), updated_at=now() WHERE id=$1`, [id]);
  const gen = (await currentQuietingGen()) + 1;
  await run(`INSERT INTO quieting_policy_log (gen, rule_id, rule_action, admin) VALUES ($1, $2, 'activated', 'admin') ON CONFLICT (gen) DO NOTHING`, [gen, id]);
  const after = await run(`SELECT ${COLS} FROM audit_suppression WHERE id=$1`, [id]);
  return { rule: rowToSuppression(after[0]), gen };
}

/** Retire an active demote rule — mirrors approve (admin role, gen increment, log). */
export async function retireDemoteRule(id: string): Promise<{ rule: SuppressionRow; gen: number } | null> {
  const rows = await run(`SELECT ${COLS} FROM audit_suppression WHERE id=$1 AND action='demote'`, [id]);
  if (!rows[0]) return null;
  if (String((rows[0] as Record<string, unknown>).status) === 'retired') return { rule: rowToSuppression(rows[0]), gen: await currentQuietingGen() };
  await run(`UPDATE audit_suppression SET status='retired', active=false, updated_at=now() WHERE id=$1`, [id]);
  const gen = (await currentQuietingGen()) + 1;
  await run(`INSERT INTO quieting_policy_log (gen, rule_id, rule_action, admin) VALUES ($1, $2, 'retired', 'admin') ON CONFLICT (gen) DO NOTHING`, [gen, id]);
  const after = await run(`SELECT ${COLS} FROM audit_suppression WHERE id=$1`, [id]);
  return { rule: rowToSuppression(after[0]), gen };
}

export interface CreateSuppressionInput {
  signal_type: string; discriminator?: string | null; match_kind?: string; scope?: string;
  doctor_uid?: string | null; action?: string; source_triage_ref?: string | null; reason?: string | null;
  created_by?: string | null; active?: boolean;
}
const dstr = (v: unknown, cap = 500): string | null => (v == null || v === '' ? null : String(v).slice(0, cap));

export async function createSuppression(input: CreateSuppressionInput): Promise<SuppressionRow> {
  const signal_type = dstr(input.signal_type, 80);
  if (!signal_type) throw new Error('signal_type required');
  const match_kind = input.match_kind === 'subject_contains' ? 'subject_contains'
    : input.match_kind === 'lvc_category' ? 'lvc_category' : 'type_only';
  const scope = input.scope === 'doctor' ? 'doctor' : 'all';
  const action = input.action === 'drop' ? 'drop' : input.action === 'demote' ? 'demote' : 'downgrade';
  if ((match_kind === 'subject_contains' || match_kind === 'lvc_category') && !dstr(input.discriminator)) {
    throw new Error(`${match_kind} requires a discriminator`);
  }
  if (scope === 'doctor' && !dstr(input.doctor_uid, 64)) throw new Error('doctor scope requires doctor_uid');
  // SEVERITY FLOOR, store-side half (PRD §2.3, generalised by V ruling 26 Jul 2026): refuse to write
  // ANY rule — drop, downgrade or demote — scoped to a deterministic safety signal type. Hoisted out
  // of the `if (isDemote)` block below, which is what previously let a drop/downgrade through even
  // though the predicate was consulted. The engine seams independently skip such findings.
  if (ruleViolatesSeverityFloor({ action, signal_type })) {
    throw new Error(`severity floor: '${signal_type}' is a deterministic safety signal type and cannot be suppressed or quieted`);
  }
  const isDemote = action === 'demote';
  if (isDemote) {
    if (!dstr(input.reason)) throw new Error('demote proposal requires a reason');
    if (!dstr(input.created_by, 64)) throw new Error('demote proposal requires a named proposer (created_by)');
  }
  const id = randomUUID();
  // A demote rule is born a PROPOSAL: status='proposed', active=false — it scores nothing until an
  // administrator activates it (Q5). Legacy drop/downgrade keeps the pre-quieting behaviour.
  await run(
    `INSERT INTO audit_suppression (id, app_source, signal_type, discriminator, match_kind, scope, doctor_uid, action, source_triage_ref, reason, created_by, active, status)
     VALUES ($1,'standalone',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, signal_type, dstr(input.discriminator), match_kind, scope, dstr(input.doctor_uid, 64), action,
      dstr(input.source_triage_ref, 64), dstr(input.reason, 1000), dstr(input.created_by, 64),
      isDemote ? false : input.active !== false, isDemote ? 'proposed' : 'retired']);
  const rows = await run(`SELECT ${COLS} FROM audit_suppression WHERE id=$1`, [id]);
  return rowToSuppression(rows[0]);
}

export async function setSuppressionActive(id: string, active: boolean): Promise<SuppressionRow | null> {
  await run(`UPDATE audit_suppression SET active=$2, updated_at=now() WHERE id=$1`, [id, active]);
  const rows = await run(`SELECT ${COLS} FROM audit_suppression WHERE id=$1`, [id]).catch(() => []);
  return rows[0] ? rowToSuppression(rows[0]) : null;
}

/**
 * Quieting dry-run (read-only): over stored audits in the window, how many findings WOULD this
 * demote rule have quieted? Backs the preview banner + the activation screen. Respects the severity
 * floor and the informational skip exactly as applyDemotes will. NO WRITES.
 */
export async function demoteDryRunCount(rule: Suppression, windowDays = 30): Promise<{ would_quiet: number; notes_scanned: number; sample_subjects: string[] }> {
  const probe: Suppression = { ...rule, active: true, status: 'active' };  // evaluate the match as if live
  const rows = await run(
    `SELECT doctor_uid, findings FROM opd_note_audits
     WHERE app_source=$1
       AND (note_date AT TIME ZONE 'Asia/Kolkata')::date > (now() AT TIME ZONE 'Asia/Kolkata')::date - $2::int
          AND excluded_reason IS DISTINCT FROM 'llm_leg_failed'
     ORDER BY note_date DESC LIMIT 8000`,
    [APP, Math.max(1, windowDays)]).catch(() => []);
  let would = 0;
  const samples: string[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const doctorUid = r.doctor_uid == null ? null : String(r.doctor_uid);
    const findings = parseJson<(OpdFinding & { lvc_category?: string })[]>(r.findings, []);
    for (const f of stampFindingIdentity(findings as OpdFinding[]) as (OpdFinding & { lvc_category?: string })[]) {
      if (f.informational || isSafetySignalType(f.signal_type)) continue;
      // stored rows carry lvc_category from stamp time; stampFindingIdentity recomputes signal_type
      if (!findingMatchesSuppression({ signal_type: f.signal_type, subject: f.subject, lvc_category: (f as { lvc_category?: string }).lvc_category }, doctorUid, probe)) continue;
      would++;
      if (samples.length < 5) samples.push(f.subject.slice(0, 90));
    }
  }
  return { would_quiet: would, notes_scanned: (rows as unknown[]).length, sample_subjects: samples };
}

/**
 * The valid-label set for `signalType`: every finding of that type, on notes by a doctor whose latest
 * triage decision for the type is `valid_signal`. This is what the dual-label check runs against — a
 * proposed suppression must remove NONE of these. Scanned over a recent window (default 60d).
 */
export async function loadValidLabelInstances(signalType: string, windowDays = 60): Promise<ValidLabelInstance[]> {
  const protectedDoctors = await loadValidLabelDoctors(signalType);
  if (protectedDoctors.length === 0) return [];
  const rows = await run(
    `SELECT doctor_uid, findings FROM opd_note_audits
     WHERE app_source=$1 AND engine_version=$2 AND doctor_uid = ANY($3) AND excluded_reason IS DISTINCT FROM 'llm_leg_failed'
       AND (note_date AT TIME ZONE 'Asia/Kolkata')::date > (now() AT TIME ZONE 'Asia/Kolkata')::date - $4::int
     LIMIT 6000`,
    [APP, OPD_ENGINE_VERSION, protectedDoctors, Math.max(1, windowDays)]).catch(() => []);
  const out: ValidLabelInstance[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const doctor_uid = String(r.doctor_uid || '');
    if (!doctor_uid) continue;
    const stamped = stampFindingIdentity(parseJson<OpdFinding[]>(r.findings, []));
    for (const f of stamped) {
      if (f.informational) continue;
      if (f.signal_type !== signalType) continue;
      out.push({ doctor_uid, signal_type: signalType, subject: f.subject });
    }
  }
  return out;
}
