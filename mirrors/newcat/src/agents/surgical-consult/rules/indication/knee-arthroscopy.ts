import type { Citation, IndicationRule } from '../indication.js'

const RULE_ID = 'indication.knee_arthroscopy_degenerative.v0'

// Passages found by grep in the fetched text on 13 Oct 2026 (AAOS: PDF text extracted; NICE: HTML; BMJ: bmj.com returned 403, so the
// Europe PMC full-text XML mirror of the same article). Whitespace normalised. verbatim_checked stays false until the signer sets it.
// Not cited: Choosing Wisely (the pages fetched were the site homepage, no arthroscopy text).
const citation: Citation = {
  primary: {
    source: 'AAOS Management of Osteoarthritis of the Knee (Non-Arthroplasty) CPG, 2021',
    section: 'Lavage/Debridement',
    url: 'https://www.aaos.org/globalassets/quality-and-practice-resources/osteoarthritis-of-the-knee/oak3cpg.pdf',
    quoted_passage: 'Arthroscopy with lavage and/or debridement in patients with a primary diagnosis of knee osteoarthritis is not recommended.',
    verbatim_checked: false,
  },
  supporting: [
    {
      source: 'NICE HealthTech guidance HTG148 (formerly IPG230)',
      section: '1.2',
      url: 'https://www.nice.org.uk/guidance/htg148/chapter/1-Recommendations',
      quoted_passage:
        'Current evidence suggests that arthroscopic knee washout alone should not be used as a treatment for osteoarthritis because it cannot demonstrate clinically useful benefit in the short or long term.',
      verbatim_checked: false,
    },
    {
      source: 'BMJ Rapid Recommendations 2017, Arthroscopic surgery for degenerative knee arthritis and meniscal tears',
      section: 'What you need to know',
      url: 'https://europepmc.org/articles/PMC5426368',
      quoted_passage:
        'We make a strong recommendation against the use of arthroscopy in nearly all patients with degenerative knee disease, based on linked systematic reviews; further research is unlikely to alter this recommendation',
      verbatim_checked: false,
    },
  ],
}

// Predicate unwritten (I2c): never fires. The acl_ligament group never reaches this rule (its group differs).
export const kneeArthroscopyRule: IndicationRule = {
  rule_id: RULE_ID,
  group: 'B_knee_arthroscopy_degenerative',
  enabled: false,
  predicate_status: 'unwritten',
  citation,
  check: () => ({ not_discussed: RULE_ID }),
}
