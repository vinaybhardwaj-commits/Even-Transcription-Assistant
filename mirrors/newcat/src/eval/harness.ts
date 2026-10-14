import { readFileSync } from 'node:fs'
import { FakeJevTransport } from '../decide/transport.js'
import { migrate } from '../db/migrate.js'
import { openDatabase } from '../db/open.js'
import type { Sql } from '../db/sql.js'
import { FakeModelClient } from '../llm/fake.js'
import { runAudit } from '../pipeline/audit.js'
import { newId } from '../ids.js'
import { assertGoldFrozen, goldContentHash, type GoldFile } from './gold.js'
import { evaluateGate, type GateResult } from './gate.js'
import { bootstrapMeanCi, expectedCalibrationError, jaccard, latencyPercentiles, meanPairwiseJaccard } from './metrics.js'

export interface EvalReport {
  result: 'PASS' | 'FAIL'
  reasons: string[]
  gate: GateResult | null
  gold_sha256: string | null
  runs: number
  safety_recall: { point: number; low: number; high: number } | null
  safety_precision: { point: number; low: number; high: number } | null
  recall_difference: { point: number; low: number; high: number } | null
  finding_set_jaccard: number | null
  safety_finding_jaccard: number | null
  abstain_rate: number | null
  ece: { validity: number | null; route: number | null; vacuous: boolean }
  latency_ms: { p50: number | null; p95: number | null }
  cost_per_note_usd: number | null
}

export async function evaluateGold(doc: GoldFile, runs = 3, seed = 1): Promise<EvalReport> {
  const frozen = assertGoldFrozen(doc)
  if (!frozen.ok) {
    return emptyReport('FAIL', [frozen.reason], goldContentHash(doc), runs)
  }
  const sql = await openDatabase(undefined)
  await migrate(sql)
  const perCaseSafety: string[][][] = doc.cases.map(() => [])
  const perCaseAll: string[][][] = doc.cases.map(() => [])
  const latencies: number[] = []
  let cost = 0
  let decisions = 0
  let abstentions = 0
  const validityRows: { p: number; y: 0 | 1 }[] = []
  const routeRows: { p: number; y: 0 | 1 }[] = []
  try {
    for (let run = 0; run < runs; run++) {
      await clearDomain(sql)
      for (const [index, goldCase] of doc.cases.entries()) {
        const traceId = newId()
        const started = Date.now()
        const audit = await runAudit(
          { sql, models: new FakeModelClient(sql), jev: new FakeJevTransport(sql) },
          {
            traceId,
            purpose: 'eval',
            source: goldCase.source,
            sourceUid: goldCase.source_uid,
            sourceTimestamp: goldCase.source_timestamp,
            body: goldCase.body,
            backlogDays: 0,
          },
        )
        latencies.push(Date.now() - started)
        const raisedSafety = audit.findings.filter((finding) => finding.safety_class && finding.action !== 'suppressed_invalid' && finding.action !== 'drop_informational').map((finding) => finding.rule_id)
        perCaseSafety[index]?.push(raisedSafety)
        perCaseAll[index]?.push(audit.findings.map((finding) => finding.id))
        for (const decision of audit.decisions) {
          decisions += 1
          if (decision.outcome === 'abstain' || decision.action === 'abstain') abstentions += 1
          const finding = audit.findings.find((item) => item.id === decision.finding_id)
          if (!finding) continue
          if (decision.question_id === 'validity') {
            validityRows.push({ p: decision.probabilities.yes ?? decision.top_probability, y: 1 })
          }
          if (decision.question_id === 'route') {
            const shouldRoute = finding.safety_class ? 1 : 0
            routeRows.push({ p: decision.probabilities.route ?? 0, y: shouldRoute })
          }
        }
        const costRows = await sql.query<{ cost: string | number | null }>('select coalesce(sum(cost_usd), 0) as cost from model_calls where trace_id = $1', [traceId])
        cost += Number(costRows.rows[0]?.cost ?? 0)
      }
    }
  } finally {
    await sql.close()
  }

  const safetyHits: number[] = []
  let criticalMisses = 0
  let safetyPositives = 0
  for (const [index, goldCase] of doc.cases.entries()) {
    const runsForCase = perCaseSafety[index] ?? []
    for (const ruleId of goldCase.expected_safety_rule_ids) {
      safetyPositives += 1
      const hit = runsForCase.every((raised) => raised.includes(ruleId))
      safetyHits.push(hit ? 1 : 0)
    }
    for (const ruleId of goldCase.expected_critical_rule_ids) {
      const hit = runsForCase.every((raised) => raised.includes(ruleId))
      if (!hit) criticalMisses += 1
    }
  }
  const precisionValues: number[] = []
  for (const runsForCase of perCaseSafety) {
    for (const raised of runsForCase) {
      const goldCase = doc.cases[perCaseSafety.indexOf(runsForCase)]
      if (!goldCase) continue
      for (const ruleId of raised) precisionValues.push(goldCase.expected_safety_rule_ids.includes(ruleId) ? 1 : 0)
    }
  }
  const safetyJaccard = averageCaseJaccard(perCaseSafety)
  const findingJaccard = averageCaseJaccard(perCaseAll)
  const recallCi = bootstrapMeanCi(safetyHits, 1000, seed)
  const precisionCi = bootstrapMeanCi(precisionValues, 1000, seed + 1)
  const difference = recallCi
    ? {
        point: recallCi.point - doc.baseline.safety_recall,
        low: recallCi.low - doc.baseline.safety_recall,
        high: recallCi.high - doc.baseline.safety_recall,
      }
    : null
  const gate = evaluateGate(
    {
      runCount: runs,
      safetyHits,
      criticalMisses,
      safetyPositives,
      precisionValues,
      baselineRecall: doc.baseline.safety_recall,
      baselinePrecision: doc.baseline.safety_precision,
      safetyJaccard,
    },
    difference,
  )
  const latency = latencyPercentiles(latencies)
  const notes = doc.cases.length * runs
  return {
    result: gate.result,
    reasons: gate.reasons,
    gate,
    gold_sha256: doc.frozen_sha256,
    runs,
    safety_recall: recallCi,
    safety_precision: precisionCi,
    recall_difference: difference,
    finding_set_jaccard: findingJaccard,
    safety_finding_jaccard: safetyJaccard,
    abstain_rate: decisions === 0 ? null : abstentions / decisions,
    ece: {
      validity: expectedCalibrationError(validityRows),
      route: expectedCalibrationError(routeRows),
      vacuous: validityRows.length === 0 && routeRows.length === 0,
    },
    latency_ms: latency,
    cost_per_note_usd: notes === 0 ? null : cost / notes,
  }
}

function averageCaseJaccard(groups: string[][][]): number | null {
  const scores = groups.map((runs) => meanPairwiseJaccard(runs)).filter((score): score is number => score !== null && !Number.isNaN(score))
  if (scores.length === 0) return null
  return scores.reduce((sum, score) => sum + score, 0) / scores.length
}

function emptyReport(result: 'PASS' | 'FAIL', reasons: string[], hash: string, runs: number): EvalReport {
  return {
    result,
    reasons,
    gate: null,
    gold_sha256: hash,
    runs,
    safety_recall: null,
    safety_precision: null,
    recall_difference: null,
    finding_set_jaccard: null,
    safety_finding_jaccard: null,
    abstain_rate: null,
    ece: { validity: null, route: null, vacuous: true },
    latency_ms: { p50: null, p95: null },
    cost_per_note_usd: null,
  }
}

async function clearDomain(sql: Sql): Promise<void> {
  await sql.exec(`
    delete from events;
    delete from jobs;
    delete from idempotency_records;
    delete from human_queue;
    delete from decisions;
    delete from candidate_findings;
    delete from extractions;
    delete from audit_runs;
    delete from work_items;
    delete from model_calls;
    delete from note_versions;
    update call_budgets set calls_used = 0;
  `)
}

export function loadGold(path: string): GoldFile {
  return JSON.parse(readFileSync(path, 'utf8')) as GoldFile
}

export { jaccard }
