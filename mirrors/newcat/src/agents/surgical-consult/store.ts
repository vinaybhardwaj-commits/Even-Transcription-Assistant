import type { Sql } from '../../db/sql.js'
import { asJson } from '../../db/sql.js'
import { sha256 } from '../../hash.js'
import type { PersistContext } from '../../platform/agent/types.js'
import { findingTypeOf } from './governance/f7.js'
import type { ConsultAuditInput } from './input.js'

// Persistence for audit.consult (migration 0005_consult.sql). Wired as the agent's `persist` hook (F7.3): every SQL
// statement here names only consult_inputs, consult_extractions and consult_findings (F7.3 C2; a test scans this file).

/**
 * What consult_inputs.input keeps (S2b, retention ruling 13 Oct 2026): per turn only turn_id, role, t0, t1 and text_en; the window
 * bounds; the opaque encounter_id and doctor_uid. text_native, lang, clips (URLs), room, presc_uid, specialty, rx and the
 * match flag are not stored. Evidence re-verification needs only the kept fields.
 */
export interface TrimmedInput {
  encounter_id: string
  doctor_uid: string | null
  window: { start: string; end: string }
  turns: Array<{ turn_id: string; role: string; t0: number; t1: number; text_en: string }>
}

export function trimInput(input: ConsultAuditInput): TrimmedInput {
  return {
    encounter_id: input.encounter_id,
    doctor_uid: input.doctor_uid,
    window: { start: input.window.start, end: input.window.end },
    turns: input.turns.map((t) => ({ turn_id: t.id, role: t.role, t0: t.t0, t1: t.t1, text_en: t.text_en })),
  }
}

export interface StoredFinding {
  finding_id: string
  rule_id: string
  rule_version: string
  finding_type: string
  procedure_group: string
  action: string
  judge: { primary_p: number | null; second_p: number | null; agree: boolean | null; served_model_ids: string[] }
  evidence: Array<{ segment_id: string; role: string; t0: number; t1: number; quote: string }>
}

export interface ConsultRecord {
  encounter_id: string
  transcript_sha: string
  extractor_version: string
  input: ConsultAuditInput
  facts: unknown[]
  dropped: Record<string, number>
  served_model_ids: string[]
  findings: StoredFinding[]
}

/**
 * Writes input, extraction and findings in one transaction. Idempotent on (encounter_id, transcript_sha, extractor_version):
 * a repeat writes nothing and returns false, and the first extraction's findings stand.
 */
export async function saveConsult(sql: Sql, record: ConsultRecord): Promise<boolean> {
  const { encounter_id, transcript_sha, extractor_version } = record
  return sql.withTx(async (tx) => {
    await tx.query(
      `insert into consult_inputs (encounter_id, transcript_sha, input) values ($1,$2,$3::jsonb)
       on conflict (encounter_id, transcript_sha) do nothing`,
      [encounter_id, transcript_sha, JSON.stringify(trimInput(record.input))],
    )
    const inserted = await tx.query(
      `insert into consult_extractions (encounter_id, transcript_sha, extractor_version, facts, dropped, served_model_ids)
       values ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)
       on conflict (encounter_id, transcript_sha, extractor_version) do nothing
       returning encounter_id`,
      [encounter_id, transcript_sha, extractor_version, JSON.stringify(record.facts), JSON.stringify(record.dropped), JSON.stringify(record.served_model_ids)],
    )
    if (inserted.rows.length === 0) return false
    for (const f of record.findings) {
      await tx.query(
        `insert into consult_findings (encounter_id, transcript_sha, extractor_version, finding_id, rule_id, rule_version, finding_type, procedure_group, action, judge, evidence)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)
         on conflict (encounter_id, transcript_sha, extractor_version, finding_id) do nothing`,
        [
          encounter_id,
          transcript_sha,
          extractor_version,
          f.finding_id,
          f.rule_id,
          f.rule_version,
          f.finding_type,
          f.procedure_group,
          f.action,
          JSON.stringify(f.judge),
          JSON.stringify(f.evidence),
        ],
      )
    }
    return true
  })
}

export const RETENTION_DAYS = 90

/**
 * The 90-day sweep (option d): consult_inputs rows older than now - days have their input set to '{}' and the row stays, so the
 * foreign keys from consult_extractions and consult_findings hold and the transcript text is gone. Touches only consult_inputs.
 * Returns the number of rows emptied (a row emptied by an earlier sweep is not counted again). The agent definition's `retention` hook
 * calls it, and the platform worker runs that hook once per UTC day.
 */
export async function sweepConsultInputs(sql: Sql, now: Date, days: number = RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString()
  const rows = await sql.query(
    `update consult_inputs set input = '{}'::jsonb
     where created_at < $1::timestamptz and input <> '{}'::jsonb
     returning encounter_id`,
    [cutoff],
  )
  return rows.rows.length
}

export async function loadFindings(sql: Sql, key: Pick<ConsultRecord, 'encounter_id' | 'transcript_sha' | 'extractor_version'>): Promise<StoredFinding[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select finding_id, rule_id, rule_version, finding_type, procedure_group, action, judge, evidence
     from consult_findings where encounter_id = $1 and transcript_sha = $2 and extractor_version = $3 order by finding_id`,
    [key.encounter_id, key.transcript_sha, key.extractor_version],
  )
  return rows.rows.map((r) => ({
    finding_id: String(r.finding_id),
    rule_id: String(r.rule_id),
    rule_version: String(r.rule_version),
    finding_type: String(r.finding_type),
    procedure_group: String(r.procedure_group),
    action: String(r.action),
    judge: asJson<StoredFinding['judge']>(r.judge),
    evidence: asJson<StoredFinding['evidence']>(r.evidence),
  }))
}

/**
 * The persist hook. The platform hands it copies of the parsed input and the audit, after its own run rows, for status
 * ok, empty or abstained. Idempotent (saveConsult repeats write nothing), so a retried job is safe.
 * Only ok and empty runs are written. An abstained run stores nothing (agent_runs already records it): a stored abstained
 * row would block a later successful run on the same transcript, because the first extraction stands.
 * The platform's gated facts (with quotes) and the gate's drop counts go to consult_extractions.facts and .dropped. Never logged.
 */
export async function persistConsult(ctx: PersistContext<ConsultAuditInput>): Promise<void> {
  const { input, audit } = ctx
  if (audit.status !== 'ok' && audit.status !== 'empty') return
  await saveConsult(ctx.sql, {
    encounter_id: input.encounter_id,
    transcript_sha: sha256(JSON.stringify(input.turns)),
    extractor_version: audit.versions.extractor,
    input,
    facts: ctx.facts,
    dropped: ctx.drops,
    served_model_ids: audit.versions.models,
    findings: audit.findings.map((f) => ({
      finding_id: f.id,
      rule_id: f.rule_id,
      rule_version: f.rule_version,
      finding_type: findingTypeOf(f.rule_id),
      procedure_group: String(f.meta?.procedure_group ?? 'other'),
      action: f.action,
      judge: {
        primary_p: f.judge?.primary_p ?? null,
        second_p: f.judge?.second_p ?? null,
        agree: f.judge?.agree ?? null,
        served_model_ids: f.judge?.served_model_ids ?? [],
      },
      evidence: f.evidence.map((e) => ({ segment_id: e.segment_id ?? '', role: e.role ?? '', t0: e.t0 ?? 0, t1: e.t1 ?? 0, quote: e.quote })),
    })),
  })
}
