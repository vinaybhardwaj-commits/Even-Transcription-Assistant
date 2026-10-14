import type { Citation, IndicationRule } from '../indication.js'

const RULE_ID = 'indication.circumcision.v0'
const URL = 'https://uroweb.org/guidelines/paediatric-urology/chapter/phimosis-and-other-abnormalities-of-the-penile-skin'

// Both passages confirmed verbatim by the I2 refuter (curl, 13 Oct 2026); verbatim_checked stays false until the signer sets it.
const citation: Citation = {
  primary: {
    source: 'EAU Guidelines on Paediatric Urology',
    section: '3.6 Summary of evidence and recommendations for the management of phimosis',
    url: URL,
    quoted_passage: 'Offer circumcision in case of Balanitis xerotica obliterans (BXO) or phimosis refractory to treatment.',
    verbatim_checked: false,
  },
  supporting: [
    {
      source: 'EAU Guidelines on Paediatric Urology',
      section: '3.3',
      url: URL,
      quoted_passage: 'Simple ballooning of the foreskin during micturition is not an indication for surgery per se.',
      verbatim_checked: false,
    },
  ],
}

// Predicate unwritten (I2c): never fires.
export const circumcisionRule: IndicationRule = {
  rule_id: RULE_ID,
  group: 'circumcision',
  enabled: false,
  predicate_status: 'unwritten',
  citation,
  check: () => ({ not_discussed: RULE_ID }),
}
