import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Fable ruling R2: an absence claim says what was not heard in the recording, never that something was not done
// (counselling can happen off-mic or on paper). Absence rules are consent.* and concern.unaddressed (isAbsenceRule).
const dir = new URL('../../../src/agents/surgical-consult/rules/', import.meta.url)
const claimsIn = (file: string): string[] => [...readFileSync(new URL(file, dir), 'utf8').matchAll(/(?:^\s+\w+|claim):\s*'([^'\n]*recording[^'\n]*|[^'\n]*(?:did not|without)[^'\n]*)'/gm)].map((m) => m[1]!)

describe('absence-polarity claim wording', () => {
  it.each(['consent.ts', 'patient-concern.ts'])('%s: every claim says "not heard in the consult recording"', (file) => {
    const claims = claimsIn(file)
    expect(claims.length).toBeGreaterThan(0)
    for (const c of claims) {
      expect(c).toContain('not heard in the consult recording')
      expect(c).not.toMatch(/did not|without/)
      expect(c).not.toMatch(/\d/)
    }
  })
  it('consent.ts has one claim per element', () => {
    expect(claimsIn('consent.ts')).toHaveLength(6)
  })
})
