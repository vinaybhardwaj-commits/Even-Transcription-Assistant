import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildOpenApi } from '../src/api/openapi.js'
import { evaluateGate } from '../src/eval/gate.js'
import { assertGoldFrozen, goldContentHash, type GoldFile } from '../src/eval/gold.js'
import { evaluateGold, loadGold } from '../src/eval/harness.js'
import { expectedCalibrationError } from '../src/eval/metrics.js'

describe('eval gate and OpenAPI', () => {
  it('passes the synthetic safety gold and fails a vacuous or mismatched set', async () => {
    const doc = loadGold('fixtures/gold/safety-v1.json')
    expect(doc.synthetic).toBe(true)
    expect(assertGoldFrozen(doc)).toEqual({ ok: true })
    expect(goldContentHash(doc)).toBe(doc.frozen_sha256)
    expect(readFileSync('fixtures/gold/safety-v1.json', 'utf8')).not.toMatch(/@/)

    const report = await evaluateGold(doc, 3, 1)
    expect(report.result).toBe('PASS')
    expect(report.ece.validity).not.toBe(0)

    const mismatched: GoldFile = { ...doc, frozen_sha256: '0'.repeat(64) }
    const refused = await evaluateGold(mismatched, 3, 1)
    expect(refused.result).toBe('FAIL')
    expect(refused.reasons).toContain('gold_hash_mismatch')
    expect(refused.safety_recall).toBeNull()

    const vacuous = evaluateGate(
      {
        runCount: 3,
        safetyHits: [],
        criticalMisses: 0,
        safetyPositives: 0,
        precisionValues: [],
        baselineRecall: 0.96,
        baselinePrecision: 0.9,
        safetyJaccard: 1,
      },
      null,
    )
    expect(vacuous.result).toBe('FAIL')
    expect(vacuous.reasons.some((reason) => reason.includes('VACUOUS'))).toBe(true)

    const miss = evaluateGate(
      {
        runCount: 3,
        safetyHits: [0],
        criticalMisses: 1,
        safetyPositives: 1,
        precisionValues: [1],
        baselineRecall: 0.96,
        baselinePrecision: 0.9,
        safetyJaccard: 1,
      },
      { low: 0 },
    )
    expect(miss.result).toBe('FAIL')
    expect(miss.checks.find((check) => check.name === 'critical_zero_miss')?.pass).toBe(false)
    expect(expectedCalibrationError([])).toBeNull()
  })

  it('writes an OpenAPI document from the capability schemas', () => {
    const spec = buildOpenApi()
    const disk = JSON.parse(readFileSync('openapi/v1.json', 'utf8')) as Record<string, unknown>
    expect(disk).toEqual(spec)
    const paths = spec.paths as Record<string, unknown>
    expect(paths['/health']).toBeTruthy()
    expect(paths['/v1/invoke']).toBeTruthy()
    const schemas = (spec.components as { schemas: Record<string, unknown> }).schemas
    expect(schemas.audit_note_input).toBeTruthy()
    expect(schemas.ask_input).toBeTruthy()
    expect(schemas.triage_decide_output).toBeTruthy()
  })
})
