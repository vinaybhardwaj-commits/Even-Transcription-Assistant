import { describe, expect, it } from 'vitest'
import { prepass } from '../../../../src/agents/surgical-consult/prepass.js'

const win = { start: '2026-10-01T10:00:00+05:30', end: '2026-10-01T10:08:00+05:30', complete: true }
const t = (id: string, text: string) => ({ id, role: 'doctor' as const, t0: 0, t1: 1, text_en: text, text_native: null, lang: 'en' })

describe('prepass U+0085 (I1 refute R1)', () => {
  it('collapses NEL like other whitespace and drops NEL-only turns', () => {
    const r = prepass({ window: win, turns: [t('1', 'a\u0085b\u0085\u0085c'), t('2', '\u0085 \u0085')] })
    expect(r.turns).toHaveLength(1)
    expect(r.turns[0]!.text_en).toBe('a b c')
    expect(r.body).toBe('[T1 DOCTOR 00:00] a b c')
  })
})
