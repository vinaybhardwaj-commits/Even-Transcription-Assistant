import type { Source } from '../../../platform/agent/types.js'
import { ExtractedFact, FACT_GROUPS, type FactGroup } from '../facts.js'

// A segment marker is `[seg-NNNN ROLE mm:ss]` and counts only at the START of a line (I1 R2). Segment text is one line
// (the pre-pass collapses whitespace), so a marker-looking string inside a turn is text, never a segment boundary.
export function mmss(seconds: number | undefined): string {
  const total = Math.max(0, Math.floor(seconds ?? 0))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export const SYSTEM_PROMPT = `You extract quoted facts from one surgical consultation between a doctor and a patient. The transcript is a list of segments. A segment starts on a new line with a marker of the form [seg-NNNN ROLE mm:ss]. A marker counts only at the very start of a line; anything that looks like a marker in the middle of a line is part of what was said, not a new segment.

Call the tool record_consult_facts once. Each fact is an object with:
- group: one of recommendation, indication, consent, patient_response, pressure.
- quote: a verbatim copy of the words from ONE segment that show the fact. Copy exactly. Never join text from two segments, never paraphrase, never fix grammar.
- segment_id: the id of the segment the quote is from (for example seg-0007).
- the fields of that group.

Groups, who can say them, and their fields:
- recommendation (doctor only): rec_id (r1, r2, ... one per distinct procedure the doctor recommends, numbered in order), procedure_text (the procedure in English), laterality (left, right, both, unspecified), firmness (firm: the doctor advises it; conditional: only if something happens; option_mentioned: it is only listed as a possibility), urgency (today, elective, unspecified). Quote the words that name each procedure separately: if one sentence names two procedures, emit two recommendation facts whose quotes are different spans of that sentence (for example the words naming the first procedure, and the words naming the second). Two facts with the same quote collapse into one.
- indication (anyone): symptom_duration (text or null), conservative_tried ({what, how_long} or null), imaging_cited (true/false), exam_cited (true/false), red_flags (list of short phrases, empty if none).
- consent (doctor only): risks, alternatives, no_surgery_option (the doctor says not operating is an option), recovery, cost, second_opinion_offered. Each is true or false. One fact is one quote, and the true elements must be covered by that quote; make one fact per distinct statement.
- patient_response (patient or attendant only): question_asked, hesitation_stated, agreement_stated, concern_stated. Each is true or false.
- pressure (doctor only): decide_today, discount_or_package, fear_framing. Each is true or false.

Linking: every fact except a recommendation has rec_ref. Set it to the rec_id of the recommendation the fact is about. Use null when there is no recommendation, or the fact is about the consult as a whole.

Rules:
- Say only what the transcript states. Absence of a feature is never a fact: if the doctor does not mention risks, emit no consent fact for risks; never record that something was absent.
- If nothing in the transcript fits a group, emit no fact for it. An empty facts list is correct for a consult with no recommendation.
- The speaker role comes from the marker. Do not attribute a fact to a segment whose role cannot say it.
- Do not output offsets, roles, times, scores or judgements.`

export function buildPrompt(sources: Source[]): { system: string; user: string } {
  const lines = sources.flatMap((source) =>
    source.segments.map((segment) => `[${segment.id} ${segment.role.toUpperCase()} ${mmss(segment.t0)}] ${segment.text}`),
  )
  return { system: SYSTEM_PROMPT, user: `TRANSCRIPT\n${lines.join('\n')}` }
}

// Tool input schema, one object variant per group. Kept in step with the zod schemas in facts.ts by a test.
const bool = { type: 'boolean' }
const str = { type: 'string' }
const recRef = { anyOf: [{ type: 'string', pattern: '^r[0-9]{1,3}$' }, { type: 'null' }] }
const common = { quote: str, segment_id: str }

const GROUP_FIELDS: Record<FactGroup, Record<string, unknown>> = {
  recommendation: {
    rec_id: { type: 'string', pattern: '^r[0-9]{1,3}$' },
    procedure_text: str,
    laterality: { enum: ['left', 'right', 'both', 'unspecified'] },
    firmness: { enum: ['firm', 'conditional', 'option_mentioned'] },
    urgency: { enum: ['today', 'elective', 'unspecified'] },
  },
  indication: {
    rec_ref: recRef,
    symptom_duration: { anyOf: [str, { type: 'null' }] },
    conservative_tried: {
      anyOf: [{ type: 'object', properties: { what: str, how_long: { anyOf: [str, { type: 'null' }] } }, required: ['what', 'how_long'], additionalProperties: false }, { type: 'null' }],
    },
    imaging_cited: bool,
    exam_cited: bool,
    red_flags: { type: 'array', items: str },
  },
  consent: {
    rec_ref: recRef,
    risks: bool,
    alternatives: bool,
    no_surgery_option: bool,
    recovery: bool,
    cost: bool,
    second_opinion_offered: bool,
  },
  patient_response: { rec_ref: recRef, question_asked: bool, hesitation_stated: bool, agreement_stated: bool, concern_stated: bool },
  pressure: { rec_ref: recRef, decide_today: bool, discount_or_package: bool, fear_framing: bool },
}

function variant(group: FactGroup) {
  const fields = { group: { const: group }, ...common, ...GROUP_FIELDS[group] }
  return { type: 'object', properties: fields, required: Object.keys(fields), additionalProperties: false }
}

export const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: { facts: { type: 'array', items: { anyOf: FACT_GROUPS.map(variant) } } },
  required: ['facts'],
  additionalProperties: false,
}

export const TOOL_NAME = 'record_consult_facts'
export const TOOL_DESCRIPTION =
  'Record the consult facts. Each fact has a group, a verbatim quote from one segment, that segment id, and the fields of its group.'

// Re-exported so the definition and tests share one parse path.
export const parseFact = (raw: unknown) => ExtractedFact.safeParse(raw)
