import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConsults, parseConsultLine, parseConsultLines, toEpochSeconds } from '../../../../src/agents/surgical-consult/offline/input.js'
import { fixtureJsonl, FIXTURE_NAMES, loadFixture, toLine } from './helpers.js'

const line = (over: Record<string, unknown> = {}, name = 'hernia-full-consent'): string => JSON.stringify(toLine(loadFixture(name), over))
const reason = (raw: string): string => {
  const r = parseConsultLine(raw)
  return r.ok ? 'ok' : r.reason
}

describe('input mapping', () => {
  it('maps a line to the agent input and the run metadata', () => {
    const r = parseConsultLine(line())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const fixture = loadFixture('hernia-full-consent')
    expect(r.consult.input).toEqual({
      ...fixture,
      specialty: null,
      window: { start: new Date(fixture.window.start).toISOString(), end: new Date(fixture.window.end).toISOString(), complete: true },
      clips: [],
    })
    expect(r.consult).toMatchObject({ source: 'cutter', match_confidence: 'exact', window_complete: true })
  })

  it('all 9 fixtures written as JSONL load with no reject', () => {
    const load = parseConsultLines(fixtureJsonl())
    expect(load.lines).toBe(9)
    expect(FIXTURE_NAMES).toHaveLength(9)
    expect(load.consults).toHaveLength(9)
    expect(Object.values(load.rejects).reduce((a, b) => a + b, 0)).toBe(0)
    expect(load.consults.map((c) => c.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('a null rx is presc_match none; window confidence is carried', () => {
    const none = parseConsultLine(line({ rx: null }))
    expect(none.ok && none.consult.input).toMatchObject({ rx: null, presc_uid: null, presc_match: 'none' })
    expect(none.ok && none.consult.match_confidence).toBe('none')
    const win = parseConsultLine(line({ rx: { presc_uid: 'rx-1', requires_surgery: true, procedure_text: 'hernia repair', match_confidence: 'window' } }))
    expect(win.ok && win.consult.input).toMatchObject({ presc_match: 'window', presc_uid: 'rx-1' })
  })

  it('epoch seconds and milliseconds in the window and the turns become relative seconds', () => {
    const start = 1_790_000_000
    for (const unit of [1, 1000]) {
      const r = parseConsultLine(
        line({
          window: { t0: start * unit, t1: (start + 480) * unit, complete: true },
          turns: [
            { turn_id: '1', role: 'doctor', t0: (start + 5) * unit, t1: (start + 9) * unit, text_en: 'a', text_native: null, lang: 'hi' },
            { turn_id: '2', role: 'patient', t0: 12, t1: 14, text_en: 'b', lang: 'hi' },
          ],
        }),
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.consult.input.turns.map((t) => [t.t0, t.t1])).toEqual([[5, 9], [12, 14]])
      expect(r.consult.input.window.end).toBe(new Date((start + 480) * 1000).toISOString())
      expect(r.consult.input.turns[1]).toMatchObject({ text_native: null })
    }
  })

  it('copies only named fields: extra keys (a patient name) never reach the input', () => {
    const obj = toLine(loadFixture('hernia-full-consent'), { patient_name: 'ZZNAME', extra: { a: 1 } })
    ;(obj.turns as Array<Record<string, unknown>>)[0]!.speaker_name = 'ZZNAME'
    const r = parseConsultLine(JSON.stringify(obj))
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r)).not.toContain('ZZNAME')
  })

  it('F1: turn times must fit the window (8 min = 480 s, plus 5 s slack)', () => {
    const turn = (t0: number, t1: number) => [{ turn_id: '1', role: 'doctor', t0, t1, text_en: 'x', lang: 'hi' }]
    // millisecond offsets from the window start parse as seconds and land far past the end
    expect(reason(line({ turns: turn(6000, 42000) }))).toBe('bad_time')
    // a turn past the window end
    expect(reason(line({ turns: turn(10, 99999) }))).toBe('bad_time')
    expect(reason(line({ turns: turn(0, 486) }))).toBe('bad_time')
    expect(reason(line({ turns: turn(0, 485) }))).toBe('ok')
    expect(reason(line({ turns: turn(0, 480) }))).toBe('ok')
    // wall-clock turns past the end are caught the same way
    const start = 1_790_000_000
    const wall = (t1: number) => line({ window: { t0: start, t1: start + 480, complete: true }, turns: [{ turn_id: '1', role: 'doctor', t0: start + 5, t1, text_en: 'x', lang: 'hi' }] })
    expect(reason(wall(start + 480))).toBe('ok')
    expect(reason(wall(start + 600))).toBe('bad_time')
    // the 9 fixtures all fit their windows
    expect(parseConsultLines(fixtureJsonl()).rejects.bad_time).toBe(0)
  })

  it('toEpochSeconds', () => {
    expect(toEpochSeconds('2026-10-01T10:00:00+05:30')).toBe(Date.parse('2026-10-01T10:00:00+05:30') / 1000)
    expect(toEpochSeconds(1_790_000_000_000)).toBe(1_790_000_000)
    expect(toEpochSeconds(100)).toBeNull()
    expect(toEpochSeconds('not a date')).toBeNull()
  })
})

describe('rejects are counted by reason and carry no text', () => {
  it('each reason', () => {
    expect(reason('')).toBe('empty_line')
    expect(reason('   ')).toBe('empty_line')
    expect(reason('{not json')).toBe('bad_json')
    expect(reason(line({ turns: undefined }))).toBe('bad_shape')
    expect(reason(line({ source: 'other' }))).toBe('bad_shape')
    expect(reason(line({ turns: [] }))).toBe('bad_shape')
    expect(reason(line({ turns: [{ turn_id: '1', role: 'nurse', t0: 0, t1: 1, text_en: 'x' }] }))).toBe('bad_shape')
    expect(reason(line({ rx: { requires_surgery: true, procedure_text: 'x', match_confidence: 'maybe' } }))).toBe('bad_shape')
    expect(reason(line({ encounter_id: 'has space' }))).toBe('bad_id')
    expect(reason(line({ encounter_id: '' }))).toBe('bad_id')
    expect(reason(line({ encounter_id: 'consult-123456789' }))).toBe('bad_id')
    expect(reason(line({ doctor_uid: 'Dr Name' }))).toBe('bad_id')
    expect(reason(line({ doctor_uid: 'doc-12345678' }))).toBe('bad_id')
    expect(reason(line({ window: { t0: 'garbage', t1: 'garbage', complete: true } }))).toBe('bad_time')
    expect(reason(line({ window: { t0: 100, t1: 200, complete: true } }))).toBe('bad_time')
    expect(reason(line({ window: { t0: '2026-10-01T11:00:00Z', t1: '2026-10-01T10:00:00Z', complete: true } }))).toBe('bad_time')
    expect(reason(line({ turns: [{ turn_id: '1', role: 'doctor', t0: 9, t1: 3, text_en: 'x', lang: 'hi' }] }))).toBe('bad_time')
    expect(reason(line({ turns: [{ turn_id: '1', role: 'doctor', t0: -4, t1: 3, text_en: 'x', lang: 'hi' }] }))).toBe('bad_time')
    expect(reason(line({ turns: [{ turn_id: '1', role: 'doctor', t0: 1, t1: 3, text_en: 'x' }, { turn_id: '1', role: 'doctor', t0: 4, t1: 5, text_en: 'y' }] }))).toBe('bad_shape')
  })

  it('a bad id line is skipped and counted; duplicates and blanks too; the counts hold no text', () => {
    const marker = 'ZZMARKER_TEXT'
    const bad = JSON.stringify(toLine({ ...loadFixture('hernia-full-consent'), encounter_id: 'x' }, { encounter_id: `bad id ${marker}`, turns: [{ turn_id: '1', role: 'doctor', t0: 0, t1: 1, text_en: marker }] }))
    const good = line()
    const load = parseConsultLines([good, bad, '', good, `{"x":"${marker}"`, line({}, 'doctor-only')].join('\n') + '\n')
    expect(load.lines).toBe(6)
    expect(load.consults.map((c) => c.line)).toEqual([1, 6])
    expect(load.rejects).toEqual({ empty_line: 1, bad_json: 1, bad_shape: 0, bad_id: 1, bad_time: 0, duplicate_encounter_id: 1 })
    expect(JSON.stringify(load.rejects)).not.toContain(marker)
  })

  it('loadConsults reads a file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 's6-in-'))
    const file = path.join(dir, 'in.jsonl')
    writeFileSync(file, fixtureJsonl().replace(/\n/g, '\r\n'))
    expect(loadConsults(file).consults).toHaveLength(9)
  })
})
