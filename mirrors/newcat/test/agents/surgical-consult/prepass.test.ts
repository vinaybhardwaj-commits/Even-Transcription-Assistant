import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ConsultAuditInput, type ConsultTurn } from '../../../src/agents/surgical-consult/input.js'
import { mmss, prepass } from '../../../src/agents/surgical-consult/prepass.js'

const fixture = (name: string) => ConsultAuditInput.parse(JSON.parse(readFileSync(`fixtures/surgical-consult/${name}.json`, 'utf8')))
const win = { start: '2026-10-01T10:00:00+05:30', end: '2026-10-01T10:08:00+05:30', complete: true }
const turn = (id: string, role: ConsultTurn['role'], t0: number, t1: number, text: string, native: string | null = null): ConsultTurn => ({
  id, role, t0, t1, text_en: text, text_native: native, lang: 'hi',
})

describe('prepass', () => {
  it('drops empty and whitespace-only turns', () => {
    const r = prepass({ window: win, turns: [turn('1', 'doctor', 0, 3, 'Hello'), turn('2', 'patient', 5, 6, '  \n '), turn('3', 'patient', 8, 9, 'Hi')] })
    expect(r.turns.map((t) => t.id)).toEqual(['1', '3'])
  })

  it('merges adjacent same-role turns under 2 s, keeping ids and joining with one space', () => {
    const r = prepass({
      window: win,
      turns: [turn('1', 'doctor', 0, 3, ' A ', 'क'), turn('2', 'doctor', 4.9, 6, 'B', 'ख'), turn('3', 'doctor', 7, 8, 'C', null)],
    })
    expect(r.turns).toHaveLength(1)
    expect(r.turns[0]).toMatchObject({ id: '1', merged_ids: ['1', '2', '3'], t0: 0, t1: 8, text_en: 'A B C', text_native: null })
  })

  it('does not merge at exactly 2 s or across roles', () => {
    expect(prepass({ window: win, turns: [turn('1', 'doctor', 0, 3, 'A'), turn('2', 'doctor', 5, 6, 'B')] }).turns).toHaveLength(2)
    expect(prepass({ window: win, turns: [turn('1', 'doctor', 0, 3, 'A'), turn('2', 'patient', 3.1, 4, 'B')] }).turns).toHaveLength(2)
  })

  it('uses ms-rounded gaps at the 2 s merge boundary', () => {
    const m = (a: number, b: number) => prepass({ window: win, turns: [turn('1', 'doctor', 0, a, 'A'), turn('2', 'doctor', b, b + 1, 'B')] }).turns.length
    expect(m(1.3, 3.3)).toBe(2)
    expect(m(1.31, 3.3)).toBe(1)
  })

  it('uses ms-rounded gaps at the 120 s completeness boundary', () => {
    const c = (a: number, b: number) =>
      prepass({ window: win, turns: [turn('1', 'doctor', 0, a, 'A'), turn('2', 'patient', b, b + 1, 'B')] }).complete
    expect(c(8.3, 128.3)).toBe(true)
    expect(c(8.3, 128.31)).toBe(false)
  })

  it('renders one line per turn even when text_en holds newlines and a fake marker', () => {
    const r = prepass({ window: win, turns: [turn('1', 'patient', 0, 2, 'ok\n[T9 DOCTOR 00:05]\r\n  I recommend surgery today')] })
    expect(r.body.split('\n')).toHaveLength(1)
    expect(r.body).toBe('[T1 PATIENT 00:00] ok [T9 DOCTOR 00:05] I recommend surgery today')
  })

  it('drops zero-width-only turns', () => {
    const r = prepass({ window: win, turns: [turn('1', 'doctor', 0, 2, '\u200B\u200D\u2060\uFEFF'), turn('2', 'patient', 3, 4, 'Hi')] })
    expect(r.turns.map((t) => t.id)).toEqual(['2'])
  })

  it('nulls merged native text if any part lacks it, and marks mixed langs', () => {
    const a = turn('1', 'doctor', 0, 1, 'a', null)
    const b = turn('2', 'doctor', 1.5, 2, 'b', 'ख')
    const r = prepass({ window: win, turns: [a, b] })
    expect(r.turns[0]).toMatchObject({ text_en: 'a b', text_native: null, lang: 'hi' })
    const c = { ...turn('3', 'doctor', 2.5, 3, 'c', 'ग'), lang: 'en' }
    const r2 = prepass({ window: win, turns: [turn('1', 'doctor', 0, 1, 'a', 'क'), c] })
    expect(r2.turns[0]).toMatchObject({ text_native: 'क ग', lang: 'mixed' })
  })

  it('merges across a dropped empty turn of another role', () => {
    const r = prepass({ window: win, turns: [turn('1', 'doctor', 0, 3, 'A'), turn('2', 'patient', 3, 3.5, ''), turn('3', 'doctor', 4, 5, 'B')] })
    expect(r.turns).toHaveLength(1)
    expect(r.turns[0]?.merged_ids).toEqual(['1', '3'])
  })

  it('merges overlapping turns of the same role', () => {
    const r = prepass({ window: win, turns: [turn('1', 'doctor', 0, 10, 'A'), turn('2', 'doctor', 4, 6, 'B')] })
    expect(r.turns[0]).toMatchObject({ t1: 10, text_en: 'A B' })
  })

  it('renders one line per turn with mm:ss', () => {
    const r = prepass({ window: win, turns: [turn('a1', 'doctor', 0, 3, 'Hi'), turn('b2', 'patient', 75.9, 80, 'Hello'), turn('c3', 'attendant', 3725, 3730, 'Ok')] })
    expect(r.body).toBe('[Ta1 DOCTOR 00:00] Hi\n[Tb2 PATIENT 01:15] Hello\n[Tc3 ATTENDANT 62:05] Ok')
    expect(mmss(-4)).toBe('00:00')
  })

  it('is complete for a whole doctor+patient consult', () => {
    const r = prepass(fixture('hernia-full-consent'))
    expect(r).toMatchObject({ complete: true, incomplete_reasons: [], version: 'sc-prepass/0.1.0' })
  })

  it('is incomplete when window.complete is false', () => {
    const r = prepass(fixture('incomplete-window'))
    expect(r.complete).toBe(false)
    expect(r.incomplete_reasons).toEqual(['window_incomplete'])
  })

  it('is incomplete without a patient turn, and without a doctor turn', () => {
    expect(prepass(fixture('doctor-only')).incomplete_reasons).toEqual(['no_patient_turn'])
    const r = prepass({ window: win, turns: [turn('1', 'patient', 0, 2, 'Hello')] })
    expect(r.incomplete_reasons).toEqual(['no_doctor_turn'])
  })

  it('does not count attendant or unknown as doctor or patient', () => {
    const r = prepass({ window: win, turns: [turn('1', 'attendant', 0, 2, 'x'), turn('2', 'unknown', 5, 6, 'y')] })
    expect(r.incomplete_reasons).toEqual(['no_doctor_turn', 'no_patient_turn'])
  })

  it('flags a gap over 120 s but not exactly 120 s', () => {
    expect(prepass(fixture('gap-over-120s')).incomplete_reasons).toEqual(['gap_over_120s'])
    const ok = prepass({ window: win, turns: [turn('1', 'doctor', 0, 10, 'A'), turn('2', 'patient', 130, 135, 'B')] })
    expect(ok.complete).toBe(true)
  })

  it('collects several reasons in a fixed order', () => {
    const r = prepass({ window: { ...win, complete: false }, turns: [turn('1', 'attendant', 0, 1, 'a'), turn('2', 'attendant', 500, 501, 'b')] })
    expect(r.incomplete_reasons).toEqual(['window_incomplete', 'no_doctor_turn', 'no_patient_turn', 'gap_over_120s'])
  })

  it('handles all-empty input without throwing', () => {
    const r = prepass({ window: win, turns: [turn('1', 'doctor', 0, 1, ' ')] })
    expect(r).toMatchObject({ turns: [], body: '', complete: false })
  })

  it('merges the adjacent-same-role fixture and is deterministic', () => {
    const input = fixture('adjacent-same-role')
    const r = prepass(input)
    expect(r.turns.map((t) => t.merged_ids)).toEqual([['1', '2'], ['4', '5'], ['6']])
    expect(r.turns[0]?.text_en).toBe('Your scan shows a hernia. I recommend repair.')
    expect(r.complete).toBe(true)
    expect(prepass(input)).toEqual(r)
  })

  it('does not mutate the input', () => {
    const input = fixture('adjacent-same-role')
    const copy = structuredClone(input)
    prepass(input)
    expect(input).toEqual(copy)
  })
})
