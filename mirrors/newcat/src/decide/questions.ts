import type { Severity } from '../facts/schema.js'
import { stableStringify, sha256 } from '../hash.js'
import { QUESTION_SET_ID } from '../version.js'

export interface QuestionContext {
  rule_id: string
  claim: string
  quotes: string[]
}

export interface JevQuestion {
  id: string
  type: 'boolean' | 'choice' | 'score'
  prompt: string
  /** Named fields the model can see. The question id is not sent to Jev. */
  context?: QuestionContext
  options?: string[]
  min?: number
  max?: number
}

export interface DecisionSubject {
  id: string
  rule_id: string
  summary: string
  evidence: { quote: string }[]
  severity?: Severity
}

/** Critical findings are routed by the abstention policy once validity clears the safety bar. */
export function asksRouteQuestion(severity: Severity | undefined): boolean {
  return severity !== 'critical'
}

export const VALIDITY_RUBRIC: Record<string, string> = {
  yes: 'Yes. Every part of the factual question is directly supported by the quoted text and relevant typed facts.',
  no: 'No. At least one part is missing, contradicted, or only inferred.',
}

export const ROUTE_RUBRIC: Record<string, string> = {
  route: 'The quotes literally support the claim and a clinician should see it.',
  hold: 'Support is incomplete or contradicted.',
  drop_informational: 'The claim is supported and purely informational.',
}

export const QUESTION_TEMPLATES: JevQuestion[] = [
  {
    id: 'validity',
    type: 'choice',
    prompt: 'Is the concrete factual statement in `claim` supported by `quotes` and the relevant typed facts?',
    options: ['yes', 'no'],
  },
  {
    id: 'route',
    type: 'choice',
    prompt:
      'What should happen to `claim`? Use only `quotes`. Ignore severity. route, hold, or drop_informational, using the criteria on each option.',
    options: ['route', 'hold', 'drop_informational'],
  },
]

export const QUESTION_SET_SHA = sha256(stableStringify({ id: QUESTION_SET_ID, questions: QUESTION_TEMPLATES }))

export function questionsFor(findings: DecisionSubject[]): JevQuestion[] {
  return findings.flatMap((finding) =>
    QUESTION_TEMPLATES.filter((template) => template.id !== 'route' || asksRouteQuestion(finding.severity)).map((template) => ({
      ...template,
      id: `${finding.id}:${template.id}`,
      prompt: template.id === 'validity' ? validityPrompt(finding.rule_id) : template.prompt,
      options: template.options ? [...template.options] : undefined,
      context: {
        rule_id: finding.rule_id,
        claim: finding.summary,
        quotes: finding.evidence.map((item) => item.quote),
      },
    })),
  )
}

export function reverseQuestion(question: JevQuestion): JevQuestion {
  // Noul is a scalar yes/no primitive and has no option order. Only Choice and
  // Score expose ordered criteria that can be reversed without changing meaning.
  if (question.type === 'boolean' || !question.options) return question
  return { ...question, options: [...question.options].reverse() }
}

export function validityPrompt(ruleId: string): string {
  switch (ruleId) {
    case 'ddi.warfarin_nsaid':
      return 'Do `quotes` list both warfarin and the NSAID named in `claim` as current medications?'
    case 'allergy.beta_lactam':
      return 'Do `quotes` show both the recorded penicillin-family allergy and the prescribed antibiotic named in `claim`?'
    case 'fdc.banned.nimesulide_paracetamol':
      return 'Do `quotes` list both nimesulide and paracetamol as current medications?'
    case 'pregnancy.ace_inhibitor':
      return 'Do `quotes` show both a current pregnancy and the ACE inhibitor prescription named in `claim`?'
    case 'redflag.no_urgent_plan':
      return 'Do `quotes` show the emergency symptom named in `claim`, while `state.plan` contains no urgent referral?'
    case 'dose.renal.metformin':
      return 'Do `quotes` show both renal impairment and a current metformin prescription?'
    case 'dx.missing_indication':
      return 'Does `state.medications` contain the medication named in `claim`, while `state.diagnoses` contains no matching indication?'
    case 'doc.medication_missing_dose':
      return 'Does `state.medications` list the medication named in `claim` with a null dose?'
    case 'planted.unsupported':
      return 'Do `quotes` directly show every medication and allergy asserted in `claim`?'
    default:
      return 'Is the concrete factual statement in `claim` directly supported by `quotes` and the relevant typed facts in `state`?'
  }
}
