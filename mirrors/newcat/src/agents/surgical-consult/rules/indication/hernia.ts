import type { IndicationRule } from '../indication.js'

const RULE_ID = 'indication.hernia_repair.v0'

// citation is null: the guideline page could not be fetched on 13 Oct 2026. Never write a citation from memory.
// Predicate unwritten (I2c): never fires.
export const herniaRule: IndicationRule = {
  rule_id: RULE_ID,
  group: 'hernia_repair',
  enabled: false,
  predicate_status: 'unwritten',
  citation: null,
  check: () => ({ not_discussed: RULE_ID }),
}
