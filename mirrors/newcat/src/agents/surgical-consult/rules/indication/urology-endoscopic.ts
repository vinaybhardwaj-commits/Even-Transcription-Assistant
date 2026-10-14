import type { Citation, IndicationRule } from '../indication.js'

const RULE_ID = 'indication.urology_endoscopic.v0'

// Confirmed verbatim by the I2 refuter (curl, 13 Oct 2026); verbatim_checked stays false until the signer sets it.
const citation: Citation = {
  primary: {
    source: 'EAU Guidelines on Urolithiasis',
    section: '3.4.9.c. Indications for treatment of ureteral stones',
    url: 'https://uroweb.org/guidelines/urolithiasis/chapter/guidelines',
    quoted_passage: 'stones with a low likelihood of spontaneous passage;',
    verbatim_checked: false,
  },
  supporting: [],
}

// Predicate unwritten (I2c): never fires.
export const urologyEndoscopicRule: IndicationRule = {
  rule_id: RULE_ID,
  group: 'urology_endoscopic',
  enabled: false,
  predicate_status: 'unwritten',
  citation,
  check: () => ({ not_discussed: RULE_ID }),
}
