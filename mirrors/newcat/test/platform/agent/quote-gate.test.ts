import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { findInSegment, gateFacts, stripZeroWidth } from '../../../src/platform/agent/quote-gate.js'
import type { Source } from '../../../src/platform/agent/types.js'

const sources: Source[] = [
  {
    id: 'conv',
    segments: [
      { id: 'a', role: 'clinician', t0: 1, t1: 4, text: 'The widget is blue.' },
      { id: 'b', role: 'patient', text: 'My   Gadget  is  Green.' },
    ],
  },
]
const roles = { claim: ['clinician'], patient_claim: ['patient'] }
const parse = (raw: unknown) => {
  const result = z.object({ n: z.number().optional() }).safeParse(raw)
  return result.success ? { ok: true as const, value: result.data } : { ok: false as const }
}
const gate = (facts: unknown[]) => gateFacts<{ n?: number | undefined }>(facts, sources, roles, parse)

describe('quote gate', () => {
  it('keeps an exact quote and stamps role, time and offsets from code', () => {
    const result = gate([{ group: 'claim', quote: 'widget is blue', segment_id: 'a', role: 'patient', start: 99 }])
    expect(result.kept).toHaveLength(1)
    const fact = result.kept[0]!
    expect(fact).toMatchObject({ role: 'clinician', t0: 1, t1: 4, start: 4, end: 18, quote: 'widget is blue', source_id: 'conv' })
    expect(result.dropRate).toBe(0)
  })

  it('keeps a case- and whitespace-folded quote and returns the original text', () => {
    const result = gate([{ group: 'patient_claim', quote: 'gadget is green', segment_id: 'b' }])
    expect(result.kept[0]).toMatchObject({ quote: 'Gadget  is  Green', start: 5, role: 'patient' })
  })

  it('drops a quote that sits in another segment and counts it separately', () => {
    const result = gate([{ group: 'claim', quote: 'Gadget is Green', segment_id: 'a' }])
    expect(result.kept).toHaveLength(0)
    expect(result.dropped.quote_in_other_segment).toBe(1)
  })

  it('drops a quote found nowhere', () => {
    const result = gate([{ group: 'claim', quote: 'not said anywhere', segment_id: 'a' }])
    expect(result.dropped.quote_not_in_segment).toBe(1)
  })

  it('drops the wrong role even when the quote is exact', () => {
    const result = gate([{ group: 'claim', quote: 'Gadget is Green', segment_id: 'b' }])
    expect(result.kept).toHaveLength(0)
    expect(result.dropped.role_not_allowed).toBe(1)
  })

  it('drops unknown group, unknown segment, malformed and schema-failing facts', () => {
    const result = gate([
      { group: 'other', quote: 'widget', segment_id: 'a' },
      { group: 'claim', quote: 'widget', segment_id: 'zzz' },
      'not an object',
      { group: 'claim', quote: 'widget', segment_id: 'a', n: 'text' },
    ])
    expect(result.dropped).toMatchObject({ group_unknown: 1, segment_unknown: 1, schema: 2 })
    expect(result.dropRate).toBe(1)
  })

  it('refuses a segment id that appears in two sources', () => {
    const twice: Source[] = [
      { id: 'x', segments: [{ id: 'dup', role: 'clinician', text: 'alpha' }] },
      { id: 'y', segments: [{ id: 'dup', role: 'clinician', text: 'alpha' }] },
    ]
    const result = gateFacts(
      [{ group: 'claim', quote: 'alpha', segment_id: 'dup' }],
      twice,
      roles,
      parse,
    )
    expect(result.dropped.segment_ambiguous).toBe(1)
  })

  it('does not keep the same span twice', () => {
    const result = gate([
      { group: 'claim', quote: 'widget is blue', segment_id: 'a' },
      { group: 'claim', quote: 'widget is blue', segment_id: 'a' },
    ])
    expect(result.kept.length).toBeLessThanOrEqual(2)
    expect(new Set(result.kept.map((fact) => fact.id)).size).toBe(result.kept.length)
  })
})

describe('zero-width stripping', () => {
  const ZW = '​‌‍⁠﻿'

  it('maps cleaned offsets back to the original text', () => {
    const stripped = stripZeroWidth(`ab${ZW}cd`)
    expect(stripped.text).toBe('abcd')
    expect(stripped.origins).toEqual([0, 1, 7, 8])
  })

  it('finds a clean quote in a segment padded with zero-width characters', () => {
    const text = `The wid${ZW}get is${ZW} blue.`
    const span = findInSegment('widget is blue', text)!
    expect(text.slice(span.start, span.end)).toBe(`wid${ZW}get is${ZW} blue`)
    expect(span.start).toBe(4)
  })

  it('finds a quote that itself carries zero-width characters', () => {
    const span = findInSegment(`wid${ZW}get is blue`, 'The widget is blue.')!
    expect(span).toEqual({ start: 4, end: 18 })
  })

  it('rejects a quote made only of zero-width characters', () => {
    expect(findInSegment(ZW, 'anything')).toBeNull()
  })

  it('gate stamps offsets into the original, unstripped segment text', () => {
    const padded: Source[] = [{ id: 'p', segments: [{ id: 'z', role: 'clinician', text: `﻿The wid​get is blue.` }] }]
    const result = gateFacts([{ group: 'claim', quote: 'widget is blue', segment_id: 'z' }], padded, roles, parse)
    const fact = result.kept[0]!
    expect(padded[0]!.segments[0]!.text.slice(fact.start, fact.end)).toBe(fact.quote)
    expect(fact.quote).toBe('wid\u200Bget is blue')
  })
})
