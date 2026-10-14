import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ConsultAuditInput } from '../../../src/agents/surgical-consult/input.js'

const dir = 'fixtures/surgical-consult'
const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
const load = (f: string) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as Record<string, unknown>

describe('ConsultAuditInput', () => {
  it('has at least 8 fixtures and every one parses', () => {
    expect(files.length).toBeGreaterThanOrEqual(8)
    for (const f of files) expect(ConsultAuditInput.safeParse(load(f)).success, f).toBe(true)
  })

  const base = () => load('hernia-full-consent.json') as { turns: Record<string, unknown>[] } & Record<string, unknown>

  it('rejects unknown keys at top level, window, turn and rx', () => {
    expect(ConsultAuditInput.safeParse({ ...base(), extra: 1 }).success).toBe(false)
    const b = base()
    expect(ConsultAuditInput.safeParse({ ...b, window: { ...(b.window as object), x: 1 } }).success).toBe(false)
    expect(ConsultAuditInput.safeParse({ ...b, turns: [{ ...b.turns[0], x: 1 }] }).success).toBe(false)
    expect(ConsultAuditInput.safeParse({ ...b, rx: { requires_surgery: true, procedure_text: null, x: 1 } }).success).toBe(false)
  })

  it('rejects bad role, presc_match and timestamps', () => {
    const b = base()
    expect(ConsultAuditInput.safeParse({ ...b, turns: [{ ...b.turns[0], role: 'nurse' }] }).success).toBe(false)
    expect(ConsultAuditInput.safeParse({ ...b, presc_match: 'fuzzy' }).success).toBe(false)
    expect(ConsultAuditInput.safeParse({ ...b, window: { start: 'yesterday', end: 'now', complete: true } }).success).toBe(false)
  })

  it('requires t0 >= 0 and t1 >= t0', () => {
    const b = base()
    const t = (t0: number, t1: number) => ConsultAuditInput.safeParse({ ...b, turns: [{ ...b.turns[0], t0, t1 }] }).success
    expect(t(0, 0)).toBe(true)
    expect(t(1.5, 2)).toBe(true)
    expect(t(-1, 2)).toBe(false)
    expect(t(5, 4)).toBe(false)
  })

  it('rejects reversed turn order', () => {
    const b = base()
    const [x, y] = b.turns as [Record<string, unknown>, Record<string, unknown>]
    expect(ConsultAuditInput.safeParse({ ...b, turns: [{ ...x, id: 'a', t0: 200, t1: 201 }, { ...y, id: 'b', t0: 2, t1: 3 }] }).success).toBe(false)
    expect(ConsultAuditInput.safeParse({ ...b, turns: [{ ...x, id: 'a', t0: 2, t1: 3 }, { ...y, id: 'b', t0: 2, t1: 3 }] }).success).toBe(true)
  })

  it('rejects duplicate turn ids', () => {
    const b = base()
    const [x, y] = b.turns as [Record<string, unknown>, Record<string, unknown>]
    expect(ConsultAuditInput.safeParse({ ...b, turns: [{ ...x, id: 'a', t0: 1, t1: 2 }, { ...y, id: 'a', t0: 3, t1: 4 }] }).success).toBe(false)
  })

  it('rejects bracketed, spaced, empty and over-long turn ids', () => {
    const b = base()
    const ok = (id: string) => ConsultAuditInput.safeParse({ ...b, turns: [{ ...b.turns[0], id }] }).success
    expect(ok('1] [T2 DOCTOR')).toBe(false)
    expect(ok('a b')).toBe(false)
    expect(ok('')).toBe(false)
    expect(ok('a'.repeat(65))).toBe(false)
    expect(ok('a'.repeat(64))).toBe(true)
    expect(ok('seg_1.2:x-3')).toBe(true)
  })

  it('rejects a window that ends before it starts', () => {
    const b = base()
    expect(ConsultAuditInput.safeParse({ ...b, window: { start: '2026-10-01T10:08:00+05:30', end: '2026-10-01T10:00:00+05:30', complete: true } }).success).toBe(false)
  })

  it('enforces 1..2000 turns', () => {
    const b = base()
    expect(ConsultAuditInput.safeParse({ ...b, turns: [] }).success).toBe(false)
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...b.turns[0], id: `t${i}`, t0: i, t1: i }))
    expect(ConsultAuditInput.safeParse({ ...b, turns: many(2000) }).success).toBe(true)
    expect(ConsultAuditInput.safeParse({ ...b, turns: many(2001) }).success).toBe(false)
  })

  it('accepts null rx and null nullable fields, and requires the rest', () => {
    const b = base()
    expect(ConsultAuditInput.safeParse({ ...b, rx: null, specialty: null, doctor_uid: null, presc_uid: null }).success).toBe(true)
    const { clips: _clips, ...noClips } = b
    expect(ConsultAuditInput.safeParse(noClips).success).toBe(false)
  })
})
