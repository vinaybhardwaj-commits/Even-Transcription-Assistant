import { describe, expect, it } from 'vitest'
import { TOOL_INPUT_SCHEMA, buildPrompt, mmss } from '../../../src/agents/surgical-consult/extract/prompt.js'
import { FactSchemas, FACT_GROUPS } from '../../../src/agents/surgical-consult/facts.js'
import { consultSources } from '../../../src/agents/surgical-consult/definition.js'
import { load } from './helpers.js'

describe('extractor prompt and tool schema', () => {
  it('the tool schema has one variant per group whose keys match the zod fact schema plus group', () => {
    const variants = (TOOL_INPUT_SCHEMA.properties.facts.items as { anyOf: Array<{ properties: Record<string, { const?: string }>; required: string[] }> }).anyOf
    expect(variants).toHaveLength(FACT_GROUPS.length)
    for (const group of FACT_GROUPS) {
      const variant = variants.find((v) => v.properties.group?.const === group)!
      expect(Object.keys(variant.properties).sort()).toEqual([...Object.keys(FactSchemas[group].shape), 'group'].sort())
      expect([...variant.required].sort()).toEqual(Object.keys(variant.properties).sort())
    }
  })

  it('renders one marker per segment at the start of a line, with role and mm:ss', () => {
    const { user, system } = buildPrompt(consultSources(load('hernia-full-consent')))
    expect(user.split('\n')[1]).toBe('[seg-0001 DOCTOR 00:00] Your scan shows a hernia on the right side. I recommend repairing it soon.')
    expect(user.split('\n').filter((l) => l.startsWith('[seg-'))).toHaveLength(6)
    expect(system).toContain('only at the very start of a line')
    expect(system).toContain('rec_ref')
    expect(mmss(75.9)).toBe('01:15')
  })
})
