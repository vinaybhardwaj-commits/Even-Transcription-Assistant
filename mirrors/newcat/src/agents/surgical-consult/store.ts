import type { Sql } from '../../db/sql.js'
import { asJson } from '../../db/sql.js'
import { sha256 } from '../../hash.js'
import type { PersistContext } from '../../platform/agent/types.js'
import { findingTypeOf } from './governance/f7.js'
import type { ConsultAuditInput } from './input.js'

// Persistence for audit.consult (migration 0005_consult.sql). Wired as the agent's `persist` hook (F7.3): every SQL
// statement here names only consult_inputs, consult_extractions and consult_findings (F7.3 C2; a test scans this file).

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
      [encounter_id, transcript_sha, JSON.stringify(record.input)],
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
 * FLAG: the hook gets neither the gated facts nor the gate's drop counts, so consult_extractions.facts and .dropped are
 * stored empty; the findings carry the evidence quotes.
 */
export async function persistConsult(ctx: PersistContext<ConsultAuditInput>): Promise<void> {
  const { input, audit } = ctx
  await saveConsult(ctx.sql, {
    encounter_id: input.encounter_id,
    transcript_sha: sha256(JSON.stringify(input.turns)),
    extractor_version: audit.versions.extractor,
    input,
    facts: [],
    dropped: {},
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
