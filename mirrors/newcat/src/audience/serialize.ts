import { z } from 'zod'
import type { EvidenceRef } from '../evidence/hits.js'
import type { Audience, Severity } from '../facts/schema.js'
import { SEVERITIES } from '../facts/schema.js'
import type { InternalAudit } from '../pipeline/types.js'

const ACTIONS = ['valid', 'route', 'hold', 'drop_informational', 'suppressed_invalid', 'abstain'] as const

const ErrorInfo = z.object({ type: z.string(), message: z.string() }).strict()

const DoctorCitation = z
  .object({
    source_name: z.string(),
    section: z.string(),
    quote: z.string(),
    url: z.string().nullable(),
  })
  .strict()

const DoctorFinding = z
  .object({
    id: z.string(),
    summary: z.string(),
    severity: z.enum(SEVERITIES),
    evidence: z.array(z.object({ quote: z.string() }).strict()),
    citations: z.array(DoctorCitation).optional(),
  })
  .strict()

const DoctorDecision = z.object({ finding_id: z.string(), recommendation: z.string() }).strict()

const base = {
  trace_id: z.string(),
  capability: z.string(),
  capability_version: z.string(),
}

export const DoctorBody = z.discriminatedUnion('status', [
  z.object({ ...base, status: z.literal('ok'), findings: z.array(DoctorFinding).min(1), decisions: z.array(DoctorDecision) }).strict(),
  z
    .object({
      ...base,
      status: z.literal('empty'),
      reason: z.string().min(1),
      findings: z.array(DoctorFinding).length(0),
      decisions: z.array(DoctorDecision).length(0),
    })
    .strict(),
  z.object({ ...base, status: z.literal('failed'), error: ErrorInfo }).strict(),
  z.object({ ...base, status: z.literal('unavailable'), error: ErrorInfo }).strict(),
])

const OperatorEvidence = z.object({ quote: z.string(), start: z.number(), end: z.number() }).strict()
const CorpusRef = z
  .object({
    chunk_id: z.string(),
    source_id: z.string(),
    source_name: z.string(),
    section_path: z.string(),
    licence_class: z.enum(['open', 'licensed_internal', 'india_regulatory', 'commercial_db']),
    url: z.string().nullable(),
    quote: z.string().optional(),
  })
  .strict()
const OperatorFinding = z
  .object({
    id: z.string(),
    rule_id: z.string(),
    rule_version: z.string(),
    severity: z.enum(SEVERITIES),
    summary: z.string(),
    action: z.enum(ACTIONS),
    evidence: z.array(OperatorEvidence),
    evidence_refs: z.array(CorpusRef).optional(),
  })
  .strict()
const OperatorDecision = z
  .object({
    finding_id: z.string(),
    question_id: z.string(),
    action: z.enum(ACTIONS),
    outcome: z.enum(['resolve', 'abstain']),
  })
  .strict()
const QueueItem = z.object({ finding_id: z.string(), rule_id: z.string(), reason: z.string() }).strict()
const OperatorVersions = z.object({ engine: z.string(), rules: z.string() }).strict()

const evidenceMetaSchema = {
  evidence_status: z.enum(['ok', 'empty', 'unavailable']).optional(),
  evidence_rerank: z.enum(['off', 'ok', 'unavailable']).optional(),
}

const operatorTerminal = {
  findings: z.array(OperatorFinding),
  decisions: z.array(OperatorDecision),
  queue: z.array(QueueItem),
  versions: OperatorVersions,
  ...evidenceMetaSchema,
}

export const OperatorBody = z.discriminatedUnion('status', [
  z.object({ ...base, status: z.literal('ok'), ...operatorTerminal }).strict(),
  z.object({ ...base, status: z.literal('empty'), reason: z.string().min(1), ...operatorTerminal }).strict(),
  z.object({ ...base, status: z.literal('abstained'), reason: z.string().min(1), ...operatorTerminal }).strict(),
  z.object({ ...base, status: z.literal('failed'), error: ErrorInfo }).strict(),
  z.object({ ...base, status: z.literal('unavailable'), error: ErrorInfo }).strict(),
])

const InternalVersions = z
  .object({
    engine: z.string(),
    rules: z.string(),
    extractor: z.string(),
    models: z.array(z.string()),
    question_set_sha: z.string(),
    question_sets: z.record(z.string()).optional(),
  })
  .strict()

const InternalFinding = OperatorFinding.extend({
  safety_class: z.boolean(),
  evidence_fact_refs: z.array(z.string()),
}).strict()

const InternalDecision = OperatorDecision.extend({
  id: z.string(),
  probabilities: z.record(z.string(), z.number()),
  top_label: z.string(),
  top_probability: z.number(),
  policy_id: z.string(),
  rationale: z.string(),
  safety_class: z.boolean(),
}).strict()

const internalTerminal = {
  findings: z.array(InternalFinding),
  decisions: z.array(InternalDecision),
  queue: z.array(QueueItem),
  versions: InternalVersions,
  evidence_hits: z.array(CorpusRef).optional(),
  ...evidenceMetaSchema,
}

export const InternalBody = z.discriminatedUnion('status', [
  z.object({ ...base, status: z.literal('ok'), ...internalTerminal }).strict(),
  z.object({ ...base, status: z.literal('empty'), reason: z.string().min(1), ...internalTerminal }).strict(),
  z.object({ ...base, status: z.literal('abstained'), reason: z.string().min(1), ...internalTerminal }).strict(),
  z.object({ ...base, status: z.literal('failed'), error: ErrorInfo, versions: InternalVersions }).strict(),
  z.object({ ...base, status: z.literal('unavailable'), error: ErrorInfo, versions: InternalVersions }).strict(),
])

export const PendingBody = z
  .object({
    ...base,
    status: z.literal('ok'),
    pending: z.literal(true),
    job_id: z.string(),
    job_status: z.enum(['queued', 'running']),
  })
  .strict()

const BANNED_DOCTOR_KEYS = new Set([
  'rationale',
  'policy_id',
  'probabilities',
  'question_set_sha',
  'served_model_id',
  'intended_model_id',
  'models',
  'extractor',
  'extractor_version',
  'top_probability',
  'rule_id',
  'rule_version',
  'queue',
  'versions',
  'chunk_id',
  'source_id',
  'licence_class',
  'evidence_refs',
  'evidence_hits',
  'evidence_status',
  'evidence_rerank',
  'section_path',
])

export class EmitRefusal extends Error {
  constructor() {
    super('refusing to emit internal fields')
    this.name = 'EmitRefusal'
  }
}

export type GovernanceSerializer = (audit: InternalAudit) => unknown

export interface SerializerHooks {
  /** Agent-owned governance body. The platform has no generic one. */
  governance?: GovernanceSerializer | undefined
}

export function serialize(audit: InternalAudit, audience: Audience, hooks: SerializerHooks = {}): unknown {
  switch (audience) {
    case 'doctor': {
      const parsed = DoctorBody.safeParse(toDoctor(audit))
      if (!parsed.success) throw new EmitRefusal()
      assertDoctorSafe(parsed.data)
      return parsed.data
    }
    case 'operator': {
      const parsed = OperatorBody.safeParse(toOperator(audit))
      if (!parsed.success) throw new EmitRefusal()
      return parsed.data
    }
    case 'internal': {
      const parsed = InternalBody.safeParse(toInternal(audit))
      if (!parsed.success) throw new EmitRefusal()
      return parsed.data
    }
    case 'governance':
      return toGovernance(audit, hooks.governance)
    default:
      return assertNever(audience)
  }
}

function assertNever(_audience: never): never {
  throw new EmitRefusal()
}

/** Keys that must never appear anywhere in a governance body. */
const BANNED_GOVERNANCE_KEYS = new Set([
  'prompt',
  'system_prompt',
  'user_prompt',
  'rationale',
  'raw_text',
  'raw_model_text',
  'model_text',
  'completion',
  'tool_input',
])

/** Platform allowlists for a governance body. An agent serializer may emit only these keys. */
const GOVERNANCE_TOP_KEYS: ReadonlySet<string> = new Set([
  'trace_id',
  'capability',
  'capability_version',
  'doctor_uid',
  'encounter_id',
  'status',
  'reason',
  'findings',
  'abstentions',
  'agent_counts',
  'versions',
  'summary',
])
const GOVERNANCE_FINDING_KEYS: ReadonlySet<string> = new Set([
  'id',
  'finding_type',
  'rule_id',
  'rule_version',
  'severity',
  'procedure_group',
  'summary',
  'evidence',
  'judge',
  'meta',
  'doctor_visible',
  'action',
])
const GOVERNANCE_EVIDENCE_KEYS: ReadonlySet<string> = new Set(['segment_id', 'role', 't0', 't1', 'quote'])
const GOVERNANCE_JUDGE_KEYS: ReadonlySet<string> = new Set(['primary_p', 'second_p', 'agree', 'served_model_ids'])
const META_KEY = /^[a-z][a-z0-9_]{0,63}$/
const GOVERNANCE_STATUSES: ReadonlySet<unknown> = new Set(['ok', 'empty', 'abstained', 'unavailable', 'failed'])

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const nonEmptyString = (value: unknown): boolean => typeof value === 'string' && value.trim() !== ''
const offset = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0
const ABSTENTION_KEY = /^[a-z][a-z0-9_]{0,63}$/
const GOVERNANCE_TOP_STRINGS = ['trace_id', 'capability', 'capability_version'] as const
const GOVERNANCE_FINDING_STRINGS = ['id', 'finding_type', 'rule_id', 'rule_version', 'severity', 'procedure_group'] as const
/** Opaque ids a governance body may carry at top level: non-empty, at most 128 characters, no spaces or free text. */
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,128}$/
const GOVERNANCE_OPAQUE_IDS = ['doctor_uid', 'encounter_id'] as const
/** Tokens that mark a key as identifier-like. A key is split into tokens (see keyTokens) and refused when any token is here. */
const IDENTIFIER_TOKENS: ReadonlySet<string> = new Set([
  'name', 'uid', 'uhid', 'mrn', 'phone', 'mobile', 'email', 'aadhaar', 'aadhar', 'dob', 'address', 'patient', 'individual', 'ip', 'ipno',
  'pan', 'passport', 'contact',
])
/** Splits on `_`, `-`, `.` and camelCase boundaries, lowercased. */
export function keyTokens(key: string): string[] {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[_.-]+/)
    .filter((token) => token !== '')
    .map((token) => token.toLowerCase())
}
/** Concatenated spellings the token split cannot see (`phoneno`, `PatientName`); matched as substrings of the lowercased key. */
const IDENTIFIER_SUBSTRINGS: readonly string[] = ['phoneno', 'mobileno', 'patientname', 'fullname', 'uhidno', 'emailid', 'abha', 'ssn', 'aadhaarno',
  'phone', 'mobile', 'uhid', 'aadhaar', 'aadhar', 'patient', 'passport', 'email', 'surname', 'firstname', 'lastname', 'dateofbirth', 'birthdate',
  'telephone', 'doctorname', 'mrnno', 'contactno', 'panno', 'ipno', 'ipnumber', 'pincode', 'cellno',
  'adhaar', 'adhar', 'mailid', 'whatsapp', 'nextofkin', 'emergencycontact', 'zipcode', 'postcode', 'birthday', 'drivinglicen']
/** Whole tokens that pass the substring wall although they contain a listed substring (phone, patient, ...). */
const SUBSTRING_EXCEPTION_TOKENS: ReadonlySet<string> = new Set(['microphone', 'headphone', 'smartphone', 'phonetic', 'outpatient', 'inpatient', 'impatient', 'immobile'])
/** Stems that, followed by no, num, number, id or reg, name an identifier (`regno`, `mrnnumber`, `epic_no`). The substring exception tokens are stems too: they bypass the substring wall only when they stand alone. */
const IDENTIFIER_STEMS: readonly string[] = ['ph', 'mob', 'phone', 'mobile', 'contact', 'cell', 'mrn', 'uhid', 'pan', 'aadhaar', 'aadhar', 'adhaar', 'adhar',
  'abha', 'health', 'voter', 'passport', 'policy', 'insurance', 'beneficiary', 'reg', 'registration', 'op', 'ip', 'bed', 'ward', 'epic', 'dl', 'visit', 'medicalrecord',
  'microphone', 'headphone', 'smartphone', 'phonetic', 'outpatient', 'inpatient', 'impatient', 'immobile']
const STEM_NUMBER = new RegExp(`^(?:${[...IDENTIFIER_STEMS].sort((a, b) => b.length - a.length).join('|')})(?:no|num|number|id|reg)\\d*$`)
const NUMBER_SUFFIX = /^(?:no|num|number|id|reg)\d*$/
/** A token that is a stem plus a number suffix, or a stem token followed by a suffix token. */
function hasStemNumber(tokens: readonly string[]): boolean {
  return tokens.some((token, i) => STEM_NUMBER.test(token) || (IDENTIFIER_STEMS.includes(token) && i + 1 < tokens.length && NUMBER_SUFFIX.test(tokens[i + 1]!)))
}
/** True when the text holds a run of 8 or more digits once separators (- _ . : space /) are stripped (phone and MRN shapes). */
export function hasLongDigitRun(text: string): boolean {
  return /\d{8,}/.test(text.replace(/[-_.:\s/]/g, ''))
}
/** True when the key looks like it names an identifier (patient, uhid, phone, doctor name, ...). */
export function isIdentifierKey(key: string): boolean {
  const lower = key.toLowerCase()
  const tokens = keyTokens(key)
  const scanned = tokens.some((token) => SUBSTRING_EXCEPTION_TOKENS.has(token)) ? tokens.filter((token) => !SUBSTRING_EXCEPTION_TOKENS.has(token)).join('_') : lower
  return lower === 'encounter_id' || lower.endsWith('name') || tokens.some((token) => token.endsWith('name')) || hasStemNumber(tokens)
    || IDENTIFIER_SUBSTRINGS.some((part) => scanned.includes(part)) || tokens.some((token) => IDENTIFIER_TOKENS.has(token))
}
/** Id shapes exempt from the digit-run test (values only, never keys): canonical UUID, 32 lowercase hex, 26-char Crockford ULID. Each needs a letter and a ULID starts with [0-7]. */
const STRUCTURED_ID = /^(?:(?=[^a-fA-F]*[a-fA-F])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|(?=[^a-f]*[a-f])[0-9a-f]{32}|(?=\d*[A-Z])[0-7][0-9A-HJKMNP-TV-Z]{25})$/
/** Opaque id: `^[A-Za-z0-9._:-]{1,128}$` with no run of 8 or more digits, separators stripped before counting. */
export function isOpaqueId(value: unknown): boolean {
  return typeof value === 'string' && OPAQUE_ID.test(value) && (STRUCTURED_ID.test(value) || !hasLongDigitRun(value))
}
/** A key that may appear in a governance body at any depth: not identifier-like and no long digit run. */
const keyOk = (key: string): boolean => !isIdentifierKey(key) && !hasLongDigitRun(key)
/** Inner keys of `versions.question_sets` are rule ids. */
const RULE_ID_KEY = /^[a-z][a-z0-9_.]{0,63}$/
/** Cap on a governance meta string value. */
const META_VALUE_MAX = 128
/** Walks every key at every depth; `topExempt` names top-level keys that skip the check. */
function keysClean(value: unknown, topExempt: ReadonlySet<string> = new Set()): boolean {
  if (Array.isArray(value)) return value.every((item) => keysClean(item))
  if (!isRecord(value)) return true
  return Object.entries(value).every(([key, inner]) => (topExempt.has(key) || keyOk(key)) && keysClean(inner))
}
/** Case-folded text with whitespace collapsed, for the quote-copy check. */
const foldText = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim()
/** Shortest meta value checked for being a piece of a quote, or containing one. */
const QUOTE_PIECE_MIN = 16
/** True when a meta value equals a quote, or (16+ chars) is a substring of one or contains a quote of 16+ chars, after case-folding and whitespace collapse. */
function copiesQuote(value: string, quotes: ReadonlySet<string>): boolean {
  const folded = foldText(value)
  if (quotes.has(folded)) return true
  if (folded.length < QUOTE_PIECE_MIN) return false
  for (const quote of quotes) if (quote !== '' && (quote.includes(folded) || (quote.length >= QUOTE_PIECE_MIN && folded.includes(quote)))) return true
  return false
}
/** Keys the platform stamps into `versions`; any other key must be slug-shaped and not identifier-like. */
const GOVERNANCE_VERSION_KEYS: ReadonlySet<string> = new Set(['engine', 'rules', 'extractor', 'models', 'question_set_sha', 'question_sets'])
const isRecordOfStrings = (value: unknown): boolean => isRecord(value) && Object.values(value).every((v) => typeof v === 'string')
const versionsOk = (versions: unknown): boolean => {
  if (!isRecord(versions)) return false
  for (const [key, value] of Object.entries(versions)) {
    if (!GOVERNANCE_VERSION_KEYS.has(key) && (!META_KEY.test(key) || !keyOk(key))) return false
    if (key === 'question_sets' ? !isRecordOfStrings(value) || !Object.keys(value as object).every((k) => RULE_ID_KEY.test(k) && keyOk(k)) : typeof value !== 'string') return false
  }
  return true
}
const probability = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/** Runs the agent's serializer, then checks the platform invariants. Anything off is a refusal. */
function toGovernance(audit: InternalAudit, hook: GovernanceSerializer | undefined): unknown {
  if (!hook) throw new EmitRefusal()
  let body: unknown
  try {
    // Snapshot what the wire will carry: toJSON, getters and Maps resolve here, so the checks see the JSON form.
    body = JSON.parse(JSON.stringify(hook(audit)))
  } catch {
    throw new EmitRefusal()
  }
  assertGovernanceSafe(body)
  return body
}

/**
 * Optional `doctor_uid` and `encounter_id`: opaque ids, strings matching `^[A-Za-z0-9._:-]{1,128}$` with no run of 8 or more digits, top level only.
 * Optional `agent_counts`: a record of non-negative integers with the same key shape as `abstentions`.
 * Required: `findings` (array) and `abstentions` (record of counts). Top-level, finding and evidence keys must be on the allowlists above.
 * Every finding carries non-empty evidence (each item with segment_id and quote) and judge probabilities
 * (`judge.primary_p`, and `judge.second_p` when present and not null). No `abstain` findings: abstentions
 * are counts only (`abstentions` is a record of non-negative integers). doctor_visible is false or absent.
 * No banned-internal key at any depth. A finding may carry `meta`: a flat record, keys matching `^[a-z][a-z0-9_]{0,63}$`, values string, finite number or boolean.
 * Value shapes: `status` is one of the five envelope statuses; `summary` and `reason` are strings (top level and per finding);
 * `versions` keys are engine|rules|extractor|models|question_set_sha|question_sets or slug-shaped non-identifier keys, values strings (`question_sets`: record of strings);
 * identifier-like keys (name, uid, uhid, mrn, phone, ... as a token, or a concatenated spelling such as phoneno) and keys with a run of 8+ digits (separators stripped) are refused at every depth, top-level `doctor_uid`/`encounter_id` excepted;
 * `versions.question_sets` inner keys match `^[a-z][a-z0-9_.]{0,63}$`; a meta string value is at most 128 characters and never equals an evidence quote in the same body; `judge` carries only `primary_p`, `second_p`, `agree` (boolean) and `served_model_ids` (string[]);
 * evidence `t0`/`t1` are numbers >= 0 and `role` is a string; `trace_id`, `capability`, `capability_version` and the finding's
 * `id`, `finding_type`, `rule_id`, `rule_version`, `severity`, `procedure_group` are strings; abstention keys match `^[a-z][a-z0-9_]{0,63}$`.
 */
export function assertGovernanceSafe(body: unknown): void {
  if (!isRecord(body)) throw new EmitRefusal()
  if (bannedKeys(body, [], BANNED_GOVERNANCE_KEYS, true).length > 0) throw new EmitRefusal()
  if (Object.keys(body).some((key) => !GOVERNANCE_TOP_KEYS.has(key))) throw new EmitRefusal()
  if (body.status !== undefined && !GOVERNANCE_STATUSES.has(body.status)) throw new EmitRefusal()
  if (body.summary !== undefined && typeof body.summary !== 'string') throw new EmitRefusal()
  if (body.reason !== undefined && typeof body.reason !== 'string') throw new EmitRefusal()
  if (body.versions !== undefined && !versionsOk(body.versions)) throw new EmitRefusal()
  if (!keysClean(body, new Set<string>(GOVERNANCE_OPAQUE_IDS))) throw new EmitRefusal()
  const quotes = new Set<string>()
  if (Array.isArray(body.findings)) {
    for (const finding of body.findings) {
      const items = isRecord(finding) && Array.isArray(finding.evidence) ? finding.evidence : []
      for (const item of items) if (isRecord(item) && typeof item.quote === 'string') quotes.add(foldText(item.quote))
    }
  }
  for (const key of GOVERNANCE_TOP_STRINGS) {
    if (body[key] !== undefined && typeof body[key] !== 'string') throw new EmitRefusal()
  }
  for (const key of GOVERNANCE_OPAQUE_IDS) {
    if (body[key] !== undefined && !isOpaqueId(body[key])) throw new EmitRefusal()
  }
  const counts = body.abstentions
  if (!isRecord(counts) || !Object.values(counts).every((n) => Number.isInteger(n) && (n as number) >= 0)) throw new EmitRefusal()
  if (Object.keys(counts).some((key) => !ABSTENTION_KEY.test(key))) throw new EmitRefusal()
  if (body.agent_counts !== undefined) {
    const sums = body.agent_counts
    if (!isRecord(sums) || !Object.values(sums).every((n) => Number.isInteger(n) && (n as number) >= 0)) throw new EmitRefusal()
    if (Object.keys(sums).some((key) => !ABSTENTION_KEY.test(key))) throw new EmitRefusal()
  }
  if (!Array.isArray(body.findings)) throw new EmitRefusal()
  for (const finding of body.findings) {
    if (!isRecord(finding)) throw new EmitRefusal()
    if (Object.keys(finding).some((key) => !GOVERNANCE_FINDING_KEYS.has(key) || !keyOk(key))) throw new EmitRefusal()
    if (finding.action === 'abstain') throw new EmitRefusal()
    for (const key of GOVERNANCE_FINDING_STRINGS) {
      if (finding[key] !== undefined && typeof finding[key] !== 'string') throw new EmitRefusal()
    }
    if (finding.summary !== undefined && typeof finding.summary !== 'string') throw new EmitRefusal()
    if (finding.doctor_visible !== undefined && finding.doctor_visible !== false) throw new EmitRefusal()
    const evidence = finding.evidence
    if (!Array.isArray(evidence) || evidence.length === 0) throw new EmitRefusal()
    for (const item of evidence) {
      if (!isRecord(item) || !nonEmptyString(item.segment_id) || !nonEmptyString(item.quote)) throw new EmitRefusal()
      if (Object.keys(item).some((key) => !GOVERNANCE_EVIDENCE_KEYS.has(key))) throw new EmitRefusal()
      if (item.t0 !== undefined && !offset(item.t0)) throw new EmitRefusal()
      if (item.t1 !== undefined && !offset(item.t1)) throw new EmitRefusal()
      if (item.role !== undefined && typeof item.role !== 'string') throw new EmitRefusal()
    }
    const findingMeta = finding.meta
    if (findingMeta !== undefined) {
      if (!isRecord(findingMeta)) throw new EmitRefusal()
      for (const [key, value] of Object.entries(findingMeta)) {
        if (!META_KEY.test(key) || !keyOk(key)) throw new EmitRefusal()
        if (typeof value === 'string' && (value.length > META_VALUE_MAX || copiesQuote(value, quotes))) throw new EmitRefusal()
        const scalar = typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
        if (!scalar) throw new EmitRefusal()
      }
    }
    const judge = finding.judge
    if (!isRecord(judge) || !probability(judge.primary_p)) throw new EmitRefusal()
    if (Object.keys(judge).some((key) => !GOVERNANCE_JUDGE_KEYS.has(key))) throw new EmitRefusal()
    if (judge.second_p !== undefined && judge.second_p !== null && !probability(judge.second_p)) throw new EmitRefusal()
    if (judge.agree !== undefined && typeof judge.agree !== 'boolean') throw new EmitRefusal()
    const served = judge.served_model_ids
    if (served !== undefined && (!Array.isArray(served) || !served.every((id) => typeof id === 'string'))) throw new EmitRefusal()
  }
}

export function assertDoctorSafe(value: unknown): void {
  const leaks = bannedKeys(value)
  if (leaks.length > 0) throw new EmitRefusal()
}

function bannedKeys(value: unknown, found: string[] = [], banned: ReadonlySet<string> = BANNED_DOCTOR_KEYS, lower = false): string[] {
  if (!value || typeof value !== 'object') return found
  if (Array.isArray(value)) {
    for (const item of value) bannedKeys(item, found, banned, lower)
    return found
  }
  for (const [key, child] of Object.entries(value)) {
    if (banned.has(lower ? key.toLowerCase() : key)) found.push(key)
    bannedKeys(child, found, banned, lower)
  }
  return found
}

function shell(audit: InternalAudit) {
  return {
    trace_id: audit.trace_id,
    capability: audit.capability,
    capability_version: audit.capability_version,
  }
}

function errorOf(audit: InternalAudit): { type: string; message: string } {
  return audit.error ?? { type: audit.status, message: audit.status }
}

function toDoctor(audit: InternalAudit): unknown {
  if (audit.status === 'failed' || audit.status === 'unavailable') {
    return { ...shell(audit), status: audit.status, error: errorOf(audit) }
  }
  const findings = audit.findings
    .filter((finding) => finding.doctor_visible)
    .map((finding) => {
      const citations = doctorCitations(finding.evidence_refs)
      return {
        id: finding.id,
        summary: finding.summary,
        severity: finding.severity as Severity,
        evidence: finding.evidence.map((item) => ({ quote: item.quote })),
        ...(citations.length > 0 ? { citations } : {}),
      }
    })
  if (findings.length === 0) {
    const reason = audit.status === 'empty' ? (audit.reason ?? 'no_candidate_findings') : 'nothing_routed'
    return { ...shell(audit), status: 'empty', reason, findings: [], decisions: [] }
  }
  return {
    ...shell(audit),
    status: 'ok',
    findings,
    decisions: findings.map((finding) => ({ finding_id: finding.id, recommendation: finding.summary })),
  }
}

function toOperator(audit: InternalAudit): unknown {
  if (audit.status === 'failed' || audit.status === 'unavailable') {
    return { ...shell(audit), status: audit.status, error: errorOf(audit) }
  }
  return {
    ...shell(audit),
    status: audit.status,
    ...(audit.reason ? { reason: audit.reason } : {}),
    findings: audit.findings.map((finding) => operatorFinding(finding, 'operator')),
    ...meta(audit),
    decisions: audit.decisions.map((decision) => ({
      finding_id: decision.finding_id,
      question_id: decision.question_id,
      action: decision.action,
      outcome: decision.outcome,
    })),
    queue: audit.queue,
    versions: { engine: audit.versions.engine, rules: audit.versions.rules },
  }
}

function toInternal(audit: InternalAudit): unknown {
  if (audit.status === 'failed' || audit.status === 'unavailable') {
    return { ...shell(audit), status: audit.status, error: errorOf(audit), versions: audit.versions }
  }
  return {
    ...shell(audit),
    status: audit.status,
    ...(audit.reason ? { reason: audit.reason } : {}),
    findings: audit.findings.map((finding) => ({
      ...operatorFinding(finding, 'internal'),
      safety_class: finding.safety_class,
      evidence_fact_refs: finding.evidence_fact_refs,
    })),
    decisions: audit.decisions,
    queue: audit.queue,
    versions: audit.versions,
    ...meta(audit),
    ...(audit.evidence_hits ? { evidence_hits: audit.evidence_hits.map((hit) => projectRef(hit, 'internal')) } : {}),
  }
}

function operatorFinding(finding: InternalAudit['findings'][number], audience: 'operator' | 'internal') {
  const refs = finding.evidence_refs && finding.evidence_refs.length > 0 ? finding.evidence_refs.map((ref) => projectRef(ref, audience)) : undefined
  return {
    id: finding.id,
    rule_id: finding.rule_id,
    rule_version: finding.rule_version,
    severity: finding.severity,
    summary: finding.summary,
    action: finding.action,
    evidence: finding.evidence.map((item) => ({ quote: item.quote, start: item.start, end: item.end })),
    ...(refs ? { evidence_refs: refs } : {}),
  }
}

function meta(audit: InternalAudit): Record<string, unknown> {
  return {
    ...(audit.evidence_status ? { evidence_status: audit.evidence_status } : {}),
    ...(audit.evidence_rerank ? { evidence_rerank: audit.evidence_rerank } : {}),
  }
}

function doctorCitations(refs: EvidenceRef[] | undefined): { source_name: string; section: string; quote: string; url: string | null }[] {
  if (!refs) return []
  return refs
    .filter((ref) => ref.doctor_visible && ref.licence_class !== 'licensed_internal' && ref.licence_class !== 'commercial_db' && ref.quote !== '')
    .map((ref) => ({
      source_name: ref.source_name,
      section: ref.section_path,
      quote: ref.quote,
      url: ref.url,
    }))
}

function projectRef(ref: EvidenceRef, audience: 'operator' | 'internal') {
  const base = {
    chunk_id: ref.chunk_id,
    source_id: ref.source_id,
    source_name: ref.source_name,
    section_path: ref.section_path,
    licence_class: ref.licence_class,
    url: ref.url,
  }
  const showQuote = audience === 'internal' || (ref.doctor_visible && ref.licence_class !== 'licensed_internal' && ref.licence_class !== 'commercial_db')
  return showQuote && ref.quote !== '' ? { ...base, quote: ref.quote } : base
}

export function pendingBody(audit: { trace_id: string; capability: string; capability_version: string }, jobId: string, jobStatus: 'queued' | 'running') {
  return {
    trace_id: audit.trace_id,
    capability: audit.capability,
    capability_version: audit.capability_version,
    status: 'ok' as const,
    pending: true as const,
    job_id: jobId,
    job_status: jobStatus,
  }
}
