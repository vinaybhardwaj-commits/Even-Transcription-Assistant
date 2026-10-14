import { describe, expect, it } from 'vitest'
import { OtAuditRow, PreopFindingRow } from '../../../src/platform/cdmss/read-models.js'

// Node re-reads process.env.TZ on assignment in the process that owns the Date machinery. The
// precondition below fails loudly if this worker ignored it, so the local-time path is really exercised.
process.env.TZ = 'Asia/Kolkata'

const otBase = {
  source: 'cdmss', id: 'ot-synth-0001', audited_at: '2026-10-02T01:00:00Z', note_class: 'ot', uid: 'ot-synth-0001',
  hospital_uid: null, facility_id: null, encounter_id: null, surgery_name: null, note_created_at: null, note_modified_at: null,
  doctor_uid: null, map_status: 'mapped', n_findings: 0, findings: null, engine_version: 'v', model: null, trace_id: null,
}

describe('DATE columns keep their calendar day on a non-UTC host (Fable C1)', () => {
  it('precondition: this process is really on IST', () => {
    expect(new Date(2026, 9, 2).toISOString()).toBe('2026-10-01T18:30:00.000Z')
  })

  it('a driver-parsed Date (local midnight) yields the same calendar day, not the day before', () => {
    expect(OtAuditRow.parse({ ...otBase, note_day: new Date(2026, 9, 2) }).note_day).toBe('2026-10-02')
  })

  it('a text DATE passes through, a local-midnight Date reads back in local time', () => {
    expect(OtAuditRow.parse({ ...otBase, note_day: '2026-10-02' }).note_day).toBe('2026-10-02')
    expect(OtAuditRow.parse({ ...otBase, note_day: new Date(2026, 11, 31) }).note_day).toBe('2026-12-31')
  })

  it('preop surgery_date uses the same transform', () => {
    const shape = PreopFindingRow.shape.surgery_date
    expect(shape.parse(new Date(2026, 9, 20))).toBe('2026-10-20')
    expect(shape.parse(null)).toBeNull()
  })
})
