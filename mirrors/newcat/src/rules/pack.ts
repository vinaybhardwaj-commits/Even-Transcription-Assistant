import type { ClinicalState, Severity } from '../facts/schema.js'
import { sha256 } from '../hash.js'
import { RULE_PACK_VERSION } from '../version.js'

export interface EvidenceQuote {
  quote: string
  start: number
  end: number
}

export interface FindingDraft {
  id: string
  rule_id: string
  rule_version: string
  severity: Severity
  safety_class: boolean
  summary: string
  evidence_fact_refs: string[]
  evidence_keys: string[]
  evidence: EvidenceQuote[]
}

export interface Rule {
  id: string
  version: string
  severity: Severity
  evaluate(state: ClinicalState): FindingDraft[]
}

export interface RulePack {
  version: string
  rules: Rule[]
}

const ALIASES: Record<string, string> = {
  coumadin: 'warfarin',
  glucophage: 'metformin',
  crocin: 'paracetamol',
  acetaminophen: 'paracetamol',
  brufen: 'ibuprofen',
}

export function normalizeDrug(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ')
  return ALIASES[normalized] ?? normalized
}

export function findingKey(ruleId: string, ruleVersion: string, slots: string[]): string {
  return sha256(`${ruleId}|${ruleVersion}|${[...slots].sort().join(',')}`).slice(0, 24)
}

function draft(
  rule: { id: string; version: string; severity: Severity },
  slots: string[],
  summary: string,
  facts: { id: string; span: { quote: string; start: number; end: number } }[],
): FindingDraft {
  const evidence = facts.map((fact) => ({ quote: fact.span.quote, start: fact.span.start, end: fact.span.end }))
  return {
    id: findingKey(rule.id, rule.version, slots),
    rule_id: rule.id,
    rule_version: rule.version,
    severity: rule.severity,
    safety_class: rule.severity === 'critical' || rule.severity === 'safety',
    summary,
    evidence_fact_refs: facts.map((fact) => fact.id).sort(),
    evidence_keys: [...slots].sort(),
    evidence,
  }
}

const DDI: { id: string; version: string; severity: Severity; left: string[]; right: string[] }[] = [
  {
    id: 'ddi.warfarin_nsaid',
    version: '1',
    severity: 'critical',
    left: ['warfarin'],
    right: ['ibuprofen', 'diclofenac', 'naproxen', 'nimesulide', 'ketorolac'],
  },
]

const drugDrug: Rule = {
  id: 'ddi.warfarin_nsaid',
  version: '1',
  severity: 'critical',
  evaluate(state) {
    const findings: FindingDraft[] = []
    const meds = state.medications.map((med) => ({ med, name: normalizeDrug(med.value.drug) }))
    for (const pair of DDI) {
      for (let i = 0; i < meds.length; i++) {
        for (let j = i + 1; j < meds.length; j++) {
          const left = meds[i]
          const right = meds[j]
          if (!left || !right) continue
          const forward = pair.left.includes(left.name) && pair.right.includes(right.name)
          const backward = pair.left.includes(right.name) && pair.right.includes(left.name)
          if (!forward && !backward) continue
          const nsaid = pair.right.includes(left.name) ? left : right
          findings.push(
            draft(
              pair,
              [`med:${left.name}`, `med:${right.name}`],
              `Warfarin and ${nsaid.med.value.drug} are prescribed together. This combination increases bleeding risk.`,
              [left.med, right.med],
            ),
          )
        }
      }
    }
    return findings
  },
}

const allergyRule: Rule = {
  id: 'allergy.beta_lactam',
  version: '1',
  severity: 'critical',
  evaluate(state) {
    const allergens = ['penicillin', 'amoxicillin', 'ampicillin']
    const drugs = new Set(['amoxicillin', 'ampicillin', 'piperacillin', 'amoxicillin-clavulanate'])
    const hits = state.patient.allergies.filter((allergy) => {
      const substance = allergy.value.trim().toLowerCase()
      return allergens.some((item) => substance === item || substance.includes(item))
    })
    if (hits.length === 0) return []
    const findings: FindingDraft[] = []
    for (const med of state.medications) {
      const name = normalizeDrug(med.value.drug)
      if (!drugs.has(name)) continue
      findings.push(
        draft(
          allergyRule,
          [`allergy:${hits[0]?.value.toLowerCase() ?? 'penicillin'}`, `med:${name}`],
          `${med.value.drug} is prescribed and a penicillin allergy is recorded.`,
          [hits[0]!, med],
        ),
      )
    }
    return findings
  },
}

const fdcRule: Rule = {
  id: 'fdc.banned.nimesulide_paracetamol',
  version: '1',
  severity: 'critical',
  evaluate(state) {
    const nimesulide = state.medications.find((med) => normalizeDrug(med.value.drug) === 'nimesulide')
    const paracetamol = state.medications.find((med) => normalizeDrug(med.value.drug) === 'paracetamol')
    if (!nimesulide || !paracetamol) return []
    return [
      draft(
        fdcRule,
        ['med:nimesulide', 'med:paracetamol'],
        'Nimesulide and paracetamol are prescribed together. This combination is banned.',
        [nimesulide, paracetamol],
      ),
    ]
  },
}

const ACEI = new Set(['enalapril', 'lisinopril', 'ramipril', 'captopril', 'perindopril'])

const pregnancyRule: Rule = {
  id: 'pregnancy.ace_inhibitor',
  version: '1',
  severity: 'critical',
  evaluate(state) {
    const pregnancy = state.patient.pregnancy
    if (pregnancy.value !== 'yes' || pregnancy.span === null) return []
    const findings: FindingDraft[] = []
    for (const med of state.medications) {
      const name = normalizeDrug(med.value.drug)
      if (!ACEI.has(name)) continue
      findings.push(
        draft(
          pregnancyRule,
          ['pregnancy:yes', `med:${name}`],
          `${med.value.drug} is prescribed and pregnancy is recorded.`,
          [{ id: pregnancy.id, span: pregnancy.span }, med],
        ),
      )
    }
    return findings
  },
}

/**
 * True emergencies only. Fever, cough, pneumonia, and a dated clinic review are not in this list.
 * "sudden chest pain" matches. A 1-week review does not count as an urgent plan.
 */
const TRUE_RED_FLAG =
  /\b(?:chest pain|chest tightness|crushing chest|stroke|hemiparesis|hemiplegia|facial droop|slurred speech|anaphylaxis|anaphylactic|stridor|unconscious|unresponsive|convulsion|seizures?|status epilepticus|haematemesis|hematemesis|melena|melaena|haemoptysis|hemoptysis|suicidal|meningism|neck stiffness|petechiae|petechial|testicular torsion|loss of vision|priapism|ectopic pregnancy)\b|\b(?:sudden|acute)\s+(?:severe\s+)?(?:headache|weakness|paralysis|dyspnoea|dyspnea|breathlessness|shortness of breath|vision loss)\b/i

const URGENT_PLAN = /\b(?:refer|referral|emergency|urgent|casualty)\b|\ber\b/i

export function isTrueRedFlag(text: string): boolean {
  return TRUE_RED_FLAG.test(text)
}

const redFlagRule: Rule = {
  id: 'redflag.no_urgent_plan',
  version: '1',
  severity: 'critical',
  evaluate(state) {
    if (state.plan.some((item) => URGENT_PLAN.test(item.value))) return []
    const flags = state.red_flags.filter((flag) => isTrueRedFlag(flag.value))
    if (flags.length === 0) return []
    const text = flags.map((flag) => flag.value).join('; ')
    return [
      draft(
        redFlagRule,
        flags.map((flag) => `redflag:${flag.value.toLowerCase()}`),
        `A red-flag symptom is recorded (${text}) and the plan does not document urgent referral.`,
        flags,
      ),
    ]
  },
}

const renalRule: Rule = {
  id: 'dose.renal.metformin',
  version: '1',
  severity: 'safety',
  evaluate(state) {
    const renal = state.patient.renal_impairment
    if (renal.value !== 'yes' || renal.span === null) return []
    const med = state.medications.find((item) => normalizeDrug(item.value.drug) === 'metformin')
    if (!med) return []
    return [
      draft(
        renalRule,
        ['renal:yes', 'med:metformin'],
        'Metformin is prescribed and renal impairment is recorded.',
        [{ id: renal.id, span: renal.span }, med],
      ),
    ]
  },
}

const INDICATIONS: { drugs: string[]; tokens: string[]; label: string }[] = [
  { drugs: ['insulin'], tokens: ['diabetes', 'diabetic', 't2dm', 't1dm'], label: 'diabetes' },
  { drugs: ['levothyroxine'], tokens: ['hypothyroid', 'hypothyroidism'], label: 'hypothyroidism' },
]

const indicationRule: Rule = {
  id: 'dx.missing_indication',
  version: '1',
  severity: 'quality',
  evaluate(state) {
    const diagnoses = state.diagnoses.map((item) => item.value.toLowerCase())
    const findings: FindingDraft[] = []
    for (const med of state.medications) {
      const name = normalizeDrug(med.value.drug)
      const needed = INDICATIONS.find((item) => item.drugs.includes(name))
      if (!needed) continue
      const supported = needed.tokens.some((token) => diagnoses.some((diagnosis) => diagnosis.includes(token)))
      if (supported) continue
      findings.push(
        draft(
          indicationRule,
          [`med:${name}`, `needs:${needed.label}`],
          `${med.value.drug} is prescribed without a documented ${needed.label} diagnosis.`,
          [med],
        ),
      )
    }
    return findings
  },
}

const doseRule: Rule = {
  id: 'doc.medication_missing_dose',
  version: '1',
  severity: 'documentation',
  evaluate(state) {
    const findings: FindingDraft[] = []
    for (const med of state.medications) {
      if (med.value.dose !== null) continue
      const name = normalizeDrug(med.value.drug)
      findings.push(
        draft(doseRule, [`med:${name}`, 'missing:dose'], `${med.value.drug} is listed without a dose.`, [med]),
      )
    }
    return findings
  },
}

export const RULES: Rule[] = [drugDrug, allergyRule, fdcRule, pregnancyRule, redFlagRule, renalRule, indicationRule, doseRule]

export const DEFAULT_PACK: RulePack = { version: RULE_PACK_VERSION, rules: RULES }

export function scoreFindings(state: ClinicalState, pack: RulePack = DEFAULT_PACK): FindingDraft[] {
  const seen = new Set<string>()
  const findings: FindingDraft[] = []
  for (const rule of pack.rules) {
    for (const finding of rule.evaluate(state)) {
      if (seen.has(finding.id)) continue
      seen.add(finding.id)
      findings.push(finding)
    }
  }
  findings.sort((a, b) => a.id.localeCompare(b.id))
  return findings
}
