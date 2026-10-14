import { asJson, asNumber, type Sql } from '../db/sql.js'
import { ClinicalStateSchema, type ClinicalState } from '../facts/schema.js'
import { newId } from '../ids.js'
import type { ValidationIssue } from '../outcome.js'
import type { FindingDraft } from '../rules/pack.js'
import { EXTRACTOR_VERSION, RULE_PACK_VERSION } from '../version.js'
import type { AppliedDecision } from '../decide/apply.js'

export async function saveExtraction(
  sql: Sql,
  noteId: string,
  status: 'ok' | 'extraction_failed',
  facts: ClinicalState | null,
  errors: ValidationIssue[] | null,
  callIds: string[],
  modelInput: unknown = null,
): Promise<void> {
  await sql.query(
    `insert into extractions (id, note_version_id, extractor_version, status, facts, errors, model_call_ids, model_input)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)
     on conflict (note_version_id, extractor_version) do update
     set status = excluded.status, facts = excluded.facts, errors = excluded.errors,
         model_call_ids = excluded.model_call_ids, model_input = excluded.model_input`,
    [
      newId(),
      noteId,
      EXTRACTOR_VERSION,
      status,
      facts ? JSON.stringify(facts) : null,
      errors ? JSON.stringify(errors) : null,
      JSON.stringify(callIds),
      modelInput === null ? null : JSON.stringify(modelInput),
    ],
  )
}

export async function loadExtraction(
  sql: Sql,
  noteId: string,
): Promise<{ status: 'ok' | 'extraction_failed'; facts: ClinicalState | null; errors: ValidationIssue[] } | null> {
  const rows = await sql.query<{ status: 'ok' | 'extraction_failed'; facts: unknown; errors: unknown }>(
    `select status, facts, errors from extractions where note_version_id = $1 and extractor_version = $2`,
    [noteId, EXTRACTOR_VERSION],
  )
  const row = rows.rows[0]
  if (!row) return null
  if (row.status === 'ok') {
    const facts = ClinicalStateSchema.parse(asJson(row.facts))
    return { status: 'ok', facts, errors: [] }
  }
  return { status: 'extraction_failed', facts: null, errors: row.errors ? asJson<ValidationIssue[]>(row.errors) : [] }
}

export async function saveFindings(sql: Sql, noteId: string, packVersion: string, findings: FindingDraft[]): Promise<void> {
  await sql.withTx(async (tx) => {
    await tx.query('delete from candidate_findings where note_version_id = $1 and rule_pack_version = $2', [noteId, packVersion])
    for (const finding of findings) {
      await tx.query(
        `insert into candidate_findings (
           note_version_id, rule_pack_version, id, rule_id, rule_version, severity, safety_class,
           summary, evidence_fact_refs, evidence_keys, evidence_quotes
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb)`,
        [
          noteId,
          packVersion,
          finding.id,
          finding.rule_id,
          finding.rule_version,
          finding.severity,
          finding.safety_class,
          finding.summary,
          JSON.stringify(finding.evidence_fact_refs),
          JSON.stringify(finding.evidence_keys),
          JSON.stringify(finding.evidence),
        ],
      )
    }
  })
}

export async function loadFindings(sql: Sql, noteId: string, packVersion: string): Promise<FindingDraft[]> {
  const rows = await sql.query<{
    id: string
    rule_id: string
    rule_version: string
    severity: FindingDraft['severity']
    safety_class: boolean
    summary: string
    evidence_fact_refs: unknown
    evidence_keys: unknown
    evidence_quotes: unknown
  }>(
    `select id, rule_id, rule_version, severity, safety_class, summary, evidence_fact_refs, evidence_keys, evidence_quotes
     from candidate_findings where note_version_id = $1 and rule_pack_version = $2 order by id`,
    [noteId, packVersion],
  )
  return rows.rows.map((row) => ({
    id: row.id,
    rule_id: row.rule_id,
    rule_version: row.rule_version,
    severity: row.severity,
    safety_class: row.safety_class,
    summary: row.summary,
    evidence_fact_refs: asJson<string[]>(row.evidence_fact_refs),
    evidence_keys: asJson<string[]>(row.evidence_keys),
    evidence: asJson<FindingDraft['evidence']>(row.evidence_quotes),
  }))
}

interface DecisionRow {
  id: string
  finding_id: string
  question_id: 'validity' | 'route'
  probabilities: unknown
  top_label: string
  top_probability: number | string
  outcome: 'resolve' | 'abstain'
  action: AppliedDecision['action']
  rationale: string | null
  safety_class: boolean
}

export async function loadDecisions(sql: Sql, noteId: string, questionSha: string, policyId: string): Promise<AppliedDecision[]> {
  const rows = await sql.query<DecisionRow>(
    `select id, finding_id, question_id, probabilities, top_label, top_probability, outcome, action, rationale, safety_class
     from decisions where note_version_id = $1 and question_set_sha = $2 and policy_id = $3`,
    [noteId, questionSha, policyId],
  )
  return rows.rows.map((row) => ({
    finding_id: row.finding_id,
    question_id: row.question_id,
    probabilities: asJson<Record<string, number>>(row.probabilities),
    top_label: row.top_label,
    top_probability: asNumber(row.top_probability),
    outcome: row.outcome,
    action: row.action,
    rationale: row.rationale ?? '',
    safety_class: row.safety_class,
  }))
}

export async function saveDecisions(
  sql: Sql,
  noteId: string,
  questionSha: string,
  policyId: string,
  decisions: AppliedDecision[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  await sql.withTx(async (tx) => {
    await tx.query('delete from decisions where note_version_id = $1 and question_set_sha = $2', [noteId, questionSha])
    for (const decision of decisions) {
      const id = newId()
      ids.set(`${decision.finding_id}:${decision.question_id}`, id)
      await tx.query(
        `insert into decisions (
           id, note_version_id, finding_id, question_id, question_set_sha, probabilities,
           top_label, top_probability, outcome, action, policy_id, rationale, safety_class
         ) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id,
          noteId,
          decision.finding_id,
          decision.question_id,
          questionSha,
          JSON.stringify(decision.probabilities),
          decision.top_label,
          decision.top_probability,
          decision.outcome,
          decision.action,
          policyId,
          decision.rationale,
          decision.safety_class,
        ],
      )
    }
  })
  return ids
}

export async function replaceQueue(
  sql: Sql,
  noteId: string,
  items: { decisionId: string; findingId: string; ruleId: string; reason: string }[],
): Promise<void> {
  await sql.withTx(async (tx) => {
    await tx.query('delete from human_queue where note_version_id = $1', [noteId])
    for (const item of items) {
      await tx.query(
        `insert into human_queue (id, decision_id, note_version_id, finding_id, rule_id, reason, audience)
         values ($1, $2, $3, $4, $5, $6, 'operator')`,
        [newId(), item.decisionId, noteId, item.findingId, item.ruleId, item.reason],
      )
    }
  })
}

export async function insertAuditRun(
  sql: Sql,
  row: {
    traceId: string
    noteId: string
    status: string
    identityStatus: string
    patientRef: string | null
    encounterRef: string | null
    purpose: string
    questionSha: string
  },
): Promise<void> {
  await sql.query(
    `insert into audit_runs (
       id, trace_id, note_version_id, status, identity_status, patient_ref, encounter_ref, purpose,
       extractor_version, rule_pack_version, question_set_sha
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      newId(),
      row.traceId,
      row.noteId,
      row.status,
      row.identityStatus,
      row.patientRef,
      row.encounterRef,
      row.purpose,
      EXTRACTOR_VERSION,
      RULE_PACK_VERSION,
      row.questionSha,
    ],
  )
}

export async function servedModels(sql: Sql, noteId: string, traceId: string): Promise<string[]> {
  const rows = await sql.query<{ served_model_id: string }>(
    `select distinct served_model_id from model_calls
     where served_model_id is not null and (
       trace_id = $1 or trace_id in (select trace_id from audit_runs where note_version_id = $2)
     )`,
    [traceId, noteId],
  )
  return rows.rows.map((row) => row.served_model_id).sort()
}
