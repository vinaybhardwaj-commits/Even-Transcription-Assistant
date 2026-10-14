/**
 * lib/lab-v2/paired-audit-core.ts — pure decisions for a paired signed/override OPD audit.
 *
 * No database, no Metabase, no model. The runner and the tests both import this so the
 * join, the prescription swap, the flag diff and the log allow-list cannot drift apart.
 *
 * The override arm replaces only what a prescription authors (medications, diagnoses,
 * investigations, procedures, advice, plan, exam, follow-up, referrals). Comorbidities,
 * history, allergies, vitals, and the chief complaint stay on the signed row unless the
 * override itself supplies a complaint or a reason. Structured JSON is the input the
 * ETA-to-Freescript caller already has. `override_text` is accepted only when the
 * caller sets the debug flag, and a text parse that drops a line is not audited.
 */
import { createHash } from 'node:crypto';
import { rowToOpdCase } from '../opd-ingest-core';
import { OPD_ENGINE_VERSION } from '../opd-note-audit-core';

/** Same shape `lib/metabase.ts` uses for a db13 uid. Not exported there; duplicated on purpose. */
export const PAIRED_UID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export const PAIRED_MAX_PAIRS = 40;
export const PAIRED_MAX_LLM_CALLS = 400;
export const PAIRED_MAX_SIGNED_REPEATS = 3;
export const PAIRED_MAX_OVERRIDE_REPEATS = 3;
/** A claimed item may be requeued once. The second stale claim is a failure, not another bill. */
export const PAIRED_MAX_ATTEMPTS = 2;
/** Production scorer when Vertex is configured (`lib/llm.ts` GEMINI_MODEL). */
export const PAIRED_DEFAULT_MODEL = 'vertex:gemini-2.5-pro';

/**
 * How many paired items one tick may have in flight. Overlapping crons share this
 * ceiling: the claim counts rows already `running` and will not start another past it.
 * `PAIRED_AUDIT_CONCURRENCY` overrides the default. Values outside 1–6 clamp into range;
 * a blank or non-numeric value keeps the default.
 */
export const PAIRED_AUDIT_CONCURRENCY_DEFAULT = 4;
export const PAIRED_AUDIT_CONCURRENCY_MAX = 6;

export function pairedAuditConcurrency(
  raw: string | undefined = process.env.PAIRED_AUDIT_CONCURRENCY,
): number {
  if (raw == null || raw.trim() === '') return PAIRED_AUDIT_CONCURRENCY_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return PAIRED_AUDIT_CONCURRENCY_DEFAULT;
  return Math.min(PAIRED_AUDIT_CONCURRENCY_MAX, Math.max(1, Math.floor(n)));
}

export type InputPath = 'signed' | 'structured' | 'text';

/** Medication fields the caller sends. `name` is the usual one; medsFrom's own names are accepted too. */
export interface OverrideMedication {
  name?: string;
  generic_name?: string;
  brand?: string;
  brand_name?: string;
  dose?: string;
  dosage?: string;
  strength?: string;
  route?: string;
  route_of_administration?: string;
  frequency?: string;
  duration?: string;
  instruction?: string;
  instruction_to_patient?: string;
}

export interface StructuredOverride {
  medications?: OverrideMedication[];
  diagnoses?: Array<{ name?: string; diagnosis?: string; icd_code?: string }>;
  investigations?: Array<string | { name?: string }>;
  procedures?: Array<string | { name?: string }>;
  advice?: string[];
  plan?: string[];
  exam?: string[];
  follow_up?: { type?: string; date?: string } | string;
  reason?: string;
  presenting_complaints?: string[] | string;
  /** Required when the encounter prescribed nothing. Empty meds without this are unparsed. */
  no_medications?: boolean;
}

/**
 * Columns a prescription authors. Cleared on the override arm, then filled from the
 * structured override. Patient-context columns are absent from this list on purpose:
 * comorbidities, history, allergies, reason, presenting complaints, vitals, consult
 * metadata. The nested GP object is cleared because it also carries the signed
 * diagnosis and plan; complaints are lifted out of it first.
 */
const RX_CLEAR_KEYS = [
  'general_practitioner_prescription__presenting_complaints',
  'general_practitioner_prescription__plan_of_management',
  'general_practitioner_prescription__examination',
  'dpipe_dx', 'dpipe_pom', 'dpipe_inv',
  'general_advice', 'refer_to', 'num_referrals',
  'followup__followup_type', 'follow_up_type',
  'next_follow_up_date', 'followup__followup_date', 'expected_resolution_date',
  'diagnosis_icd_codes', 'impression_icd_codes',
  'medications', 'further_investigation',
  'diagnosis', 'impression', 'examination', 'plan_of_management',
  'prescription_url',
] as const;

/**
 * Identity of the prompt the paired audit bills against.
 * Bump when `OPD_AUDIT_SYSTEM`, `buildOpdAuditUser`, `opdCaseText`, or `formatOpdMed` changes.
 * A hash of `Function.toString()` changes when a bundler rewrites a function body and would
 * miss dedupe on every deploy.
 */
export const PAIRED_PROMPT_VERSION = 'paired-opd-prompt/1';

export function opdAuditPromptHash(): string {
  return PAIRED_PROMPT_VERSION;
}

export function pairedEngineVersion(): string {
  return OPD_ENGINE_VERSION;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      if (src[key] !== undefined) out[key] = sortValue(src[key]);
    }
    return out;
  }
  return value ?? null;
}

function stable(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function plain(v: unknown): string {
  return String(v ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nonEmpty(v: unknown): string {
  return plain(v);
}

/** Complaints the signed row already has, including ones that live only on the nested GP object. */
function liftedComplaints(row: Record<string, unknown>): string {
  const direct = plain(row.dpipe_pc);
  if (direct) return direct;
  const top = row.presenting_complaints;
  if (Array.isArray(top)) {
    const parts = top.map((it) => {
      if (typeof it === 'string') return plain(it);
      if (it && typeof it === 'object') {
        const o = it as Record<string, unknown>;
        return plain(o.complaint ?? o.name ?? o.text ?? o.value ?? o.title ?? '');
      }
      return '';
    }).filter(Boolean);
    if (parts.length) return parts.join('\n');
  } else if (typeof top === 'string' && plain(top)) {
    return plain(top);
  }
  const gp = row.general_practitioner_prescription__presenting_complaints;
  if (!Array.isArray(gp)) return '';
  const symptoms: string[] = [];
  for (const it of gp) {
    if (!it || typeof it !== 'object') continue;
    const s = plain((it as Record<string, unknown>).symptoms);
    if (s) symptoms.push(s);
  }
  return symptoms.join('\n');
}

function complaintsFromOverride(s: StructuredOverride): string | null {
  const pc = s.presenting_complaints;
  if (pc == null) return null;
  if (typeof pc === 'string') return plain(pc) || null;
  const joined = pc.map((x) => plain(x)).filter(Boolean).join('\n');
  return joined || null;
}

function namesOf(items: Array<string | { name?: string }> | undefined): string[] {
  if (!items) return [];
  return items.map((item) => (typeof item === 'string' ? plain(item) : plain(item?.name))).filter(Boolean);
}

function toMedRow(m: OverrideMedication): Record<string, string | null> | null {
  const generic = nonEmpty(m.generic_name) || nonEmpty(m.name);
  const brand = nonEmpty(m.brand_name) || nonEmpty(m.brand);
  if (!generic && !brand) return null;
  return {
    generic_name: generic || null,
    brand_name: brand || null,
    strength: nonEmpty(m.strength) || null,
    dosage: nonEmpty(m.dosage) || nonEmpty(m.dose) || null,
    frequency: nonEmpty(m.frequency) || null,
    duration: nonEmpty(m.duration) || null,
    route_of_administration: nonEmpty(m.route_of_administration) || nonEmpty(m.route) || null,
    instruction_to_patient: nonEmpty(m.instruction_to_patient) || nonEmpty(m.instruction) || null,
  };
}

export function hasStructuredContent(s: StructuredOverride | null | undefined): boolean {
  if (!s) return false;
  if (s.no_medications === true) return true;
  const follow = s.follow_up;
  const followPresent = typeof follow === 'string'
    ? plain(follow).length > 0
    : !!(follow && (plain(follow.type) || plain(follow.date)));
  return !!(
    s.medications?.length
    || s.diagnoses?.length
    || s.investigations?.length
    || s.procedures?.length
    || s.advice?.length
    || s.plan?.length
    || s.exam?.length
    || followPresent
    || plain(s.reason)
    || complaintsFromOverride(s)
  );
}

const SECTION_HEAD: Array<{ key: keyof StructuredOverride; re: RegExp }> = [
  { key: 'medications', re: /^(?:medications?|prescription|rx)\b\s*:?\s*(.*)$/i },
  { key: 'diagnoses', re: /^(?:diagnos[ei]s|impressions?|dx)\b\s*:?\s*(.*)$/i },
  { key: 'investigations', re: /^(?:investigations?|labs?|tests? ordered)\b\s*:?\s*(.*)$/i },
  { key: 'procedures', re: /^(?:procedures?)\b\s*:?\s*(.*)$/i },
  { key: 'advice', re: /^(?:advice)\b\s*:?\s*(.*)$/i },
  { key: 'plan', re: /^(?:plan(?: of management)?|management)\b\s*:?\s*(.*)$/i },
  { key: 'exam', re: /^(?:exam(?:ination)?)\b\s*:?\s*(.*)$/i },
  { key: 'follow_up', re: /^(?:follow[- ]?up)\b\s*:?\s*(.*)$/i },
  { key: 'reason', re: /^(?:reason(?: for consult(?:ation)?)?|chief complaint)\b\s*:?\s*(.*)$/i },
  { key: 'presenting_complaints', re: /^(?:presenting complaints?|complaints?)\b\s*:?\s*(.*)$/i },
];

const DOSE_RE = /(\d+(?:\.\d+)?)\s*(mg|mcg|µg|g|ml|iu|units?)\b/i;

/** One medication line. Returns null when the line has no dose, so prose is not turned into a drug. */
export function parseMedLine(line: string): OverrideMedication | null {
  const dose = DOSE_RE.exec(line);
  if (!dose) return null;
  let name = line.slice(0, dose.index)
    .replace(/^(?:tab\.?|cap\.?|syp\.?|inj\.?|tablet|capsule)\s+/i, '')
    .replace(/^.*:\s*/, '')
    .trim();
  name = name.split(/\s+/).filter(Boolean).slice(-4).join(' ');
  if (!/[A-Za-z]{3,}/.test(name)) return null;
  const route = /\b(oral|po|iv|im|sc|topical|sublingual|inhaled)\b/i.exec(line)?.[1];
  const frequency = /\b(od|bd|tds|qid|hs|sos|once daily|twice daily|three times daily|thrice daily)\b/i.exec(line)?.[1];
  const duration = /\b(?:for|x)\s+(\d+|[a-z]+)\s+(day|days|week|weeks|month|months)\b/i.exec(line);
  return {
    name,
    dose: dose[0].replace(/\s+/g, ' '),
    route,
    frequency,
    duration: duration ? `${duration[1]} ${duration[2]}` : undefined,
  };
}

function pushLine(out: StructuredOverride, key: keyof StructuredOverride, line: string): void {
  const text = line.trim();
  if (!text) return;
  if (key === 'medications') {
    const med = parseMedLine(text) ?? { name: text.replace(/^.*:\s*/, '').trim() };
    if (med.name || med.generic_name) (out.medications ??= []).push(med);
    return;
  }
  if (key === 'diagnoses') {
    const coded = /^(.*?)(?:\s*[\(\[]\s*([A-Z]\d{2}(?:\.\d{1,4})?)\s*[\)\]]|\s+[-–]\s*([A-Z]\d{2}(?:\.\d{1,4})?))\s*$/.exec(text);
    const name = (coded?.[1] ?? text).trim();
    const icd = coded?.[2] || coded?.[3];
    if (name) (out.diagnoses ??= []).push(icd ? { name, icd_code: icd } : { name });
    return;
  }
  if (key === 'investigations') {
    (out.investigations ??= []).push(text);
    return;
  }
  if (key === 'procedures') {
    (out.procedures ??= []).push(text);
    return;
  }
  if (key === 'advice') {
    (out.advice ??= []).push(text);
    return;
  }
  if (key === 'plan') {
    (out.plan ??= []).push(text);
    return;
  }
  if (key === 'exam') {
    (out.exam ??= []).push(text);
    return;
  }
  if (key === 'follow_up') {
    const date = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1];
    out.follow_up = date ? { type: text.replace(date, '').replace(/[-–,:]/g, ' ').trim() || 'follow-up', date } : text;
    return;
  }
  if (key === 'reason') {
    out.reason = out.reason ? `${out.reason} ${text}` : text;
    return;
  }
  if (key === 'presenting_complaints') {
    const cur = out.presenting_complaints;
    const list = Array.isArray(cur) ? cur : (cur ? [cur] : []);
    list.push(text);
    out.presenting_complaints = list;
  }
}

function effectiveMeds(s: StructuredOverride | null | undefined): number {
  if (!s?.medications) return 0;
  return s.medications.map(toMedRow).filter((m) => m != null).length;
}

/** Zero medications is a real encounter only when the caller says so. */
export function overrideUnparsed(s: StructuredOverride | null | undefined): boolean {
  if (!s) return true;
  if (s.no_medications === true && effectiveMeds(s) > 0) return true;
  if (effectiveMeds(s) > 0) return false;
  return s.no_medications !== true;
}

export interface TextCoverage {
  structured: StructuredOverride;
  linesTotal: number;
  linesParsed: number;
  ok: boolean;
}

function jsonMed(value: unknown): OverrideMedication | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const str = (key: string) => (typeof o[key] === 'string' ? o[key] as string : undefined);
  const med: OverrideMedication = {
    name: str('name'),
    generic_name: str('generic_name'),
    brand: str('brand'),
    brand_name: str('brand_name'),
    dose: str('dose'),
    dosage: str('dosage'),
    strength: str('strength'),
    route: str('route'),
    route_of_administration: str('route_of_administration'),
    frequency: str('frequency'),
    duration: str('duration'),
    instruction: str('instruction'),
    instruction_to_patient: str('instruction_to_patient'),
  };
  return toMedRow(med) ? med : null;
}

function assessJsonText(text: string): TextCoverage {
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    return { structured: {}, linesTotal: 1, linesParsed: 0, ok: false };
  }
  const root = Array.isArray(value) ? { medications: value } : value;
  if (!root || typeof root !== 'object') {
    return { structured: {}, linesTotal: 1, linesParsed: 0, ok: false };
  }
  const o = root as Record<string, unknown>;
  const structured: StructuredOverride = {};
  if (o.no_medications === true) structured.no_medications = true;
  const named = o.name != null || o.generic_name != null || o.brand != null || o.brand_name != null || o.drug != null;
  const medSource = Array.isArray(o.medications) ? o.medications : (named ? [o] : []);
  const meds: OverrideMedication[] = [];
  let parsed = 0;
  for (const item of medSource) {
    const med = jsonMed(item);
    if (med) { meds.push(med); parsed += 1; }
  }
  if (meds.length) structured.medications = meds;
  const linesTotal = medSource.length > 0 ? medSource.length : 1;
  const ok = medSource.length === parsed && !overrideUnparsed(structured);
  return { structured, linesTotal, linesParsed: parsed, ok };
}

function lineChanged(before: string, out: StructuredOverride): boolean {
  return JSON.stringify(out) !== before;
}

/**
 * The one text-to-structure path. Headed sections map onto the structured fields.
 * An unheaded line is split on `/` and counts only when it parses as a medication.
 * `ok` is false when any of those lines is dropped or when the result has no medications.
 */
export function assessOverrideText(text: string): TextCoverage {
  const trimmed = text.trim();
  if (!trimmed) return { structured: {}, linesTotal: 0, linesParsed: 0, ok: false };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return assessJsonText(trimmed);
  const out: StructuredOverride = {};
  let section: keyof StructuredOverride | null = null;
  let linesTotal = 0;
  let linesParsed = 0;
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-•*]\s*/, '');
    if (!line) continue;
    const headed = SECTION_HEAD.find((h) => h.re.test(line));
    if (headed) {
      section = headed.key;
      linesTotal += 1;
      const rest = headed.re.exec(line)?.[1]?.trim() ?? '';
      if (!rest) { linesParsed += 1; continue; }
      const before = JSON.stringify(out);
      pushLine(out, section, rest);
      if (lineChanged(before, out)) linesParsed += 1;
      continue;
    }
    const pieces = section ? [line] : line.split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean);
    for (const piece of pieces) {
      linesTotal += 1;
      if (section) {
        const before = JSON.stringify(out);
        pushLine(out, section, piece);
        if (lineChanged(before, out)) linesParsed += 1;
      } else {
        const med = parseMedLine(piece);
        if (med && toMedRow(med)) {
          (out.medications ??= []).push(med);
          linesParsed += 1;
        }
      }
    }
  }
  const ok = linesTotal > 0 && linesParsed === linesTotal && !overrideUnparsed(out);
  return { structured: out, linesTotal, linesParsed, ok };
}

export function structureFromOverrideText(text: string): StructuredOverride {
  return assessOverrideText(text).structured;
}

/**
 * Copy of the signed row with prescription-authored columns replaced.
 * Patient context stays. A supplied reason or complaint replaces only that field.
 */
export function applyStructuredOverride(row: Record<string, unknown>, structured: StructuredOverride): Record<string, unknown> {
  const suppliedComplaints = complaintsFromOverride(structured);
  const complaints = suppliedComplaints ?? liftedComplaints(row);
  const next: Record<string, unknown> = { ...row };
  for (const key of RX_CLEAR_KEYS) next[key] = null;
  next.dpipe_pc = complaints || null;
  if (suppliedComplaints != null) next.presenting_complaints = null;
  if (plain(structured.reason)) next.reason_for_consultation = plain(structured.reason);

  const meds = (structured.medications ?? []).map(toMedRow).filter((m): m is Record<string, string | null> => m != null);
  next.medications = meds.length ? meds : null;

  const dx = (structured.diagnoses ?? []).map((d) => ({
    diagnosis: nonEmpty(d.diagnosis) || nonEmpty(d.name) || null,
    icd_code: nonEmpty(d.icd_code) || null,
  })).filter((d) => d.diagnosis || d.icd_code);
  next.dpipe_dx = dx.length ? dx : null;

  const inv = namesOf(structured.investigations).map((name) => ({ name }));
  next.dpipe_inv = inv.length ? inv : null;

  const planLines = [
    ...namesOf(structured.procedures).map((name) => `Procedure: ${name}`),
    ...(structured.advice ?? []).map((line) => plain(line)).filter(Boolean),
    ...(structured.plan ?? []).map((line) => plain(line)).filter(Boolean),
  ];
  next.dpipe_pom = planLines.length ? planLines.map((line) => ({ management_plan: line })) : null;

  const exam = (structured.exam ?? []).map((line) => plain(line)).filter(Boolean);
  next.general_practitioner_prescription__examination = exam.length ? exam.join('\n') : null;

  const follow = structured.follow_up;
  if (typeof follow === 'string' && plain(follow)) {
    next.followup__followup_type = plain(follow);
  } else if (follow && typeof follow === 'object') {
    if (plain(follow.type)) next.followup__followup_type = plain(follow.type);
    if (plain(follow.date)) next.next_follow_up_date = plain(follow.date);
  }
  return next;
}

/** Text fallback: parse, then the same column mapper the structured path uses. */
export function applyNoteBodyOverride(row: Record<string, unknown>, overrideText: string): Record<string, unknown> {
  return applyStructuredOverride(row, structureFromOverrideText(overrideText));
}

/** Shared context and vitals that change the prompt but are not the prescription itself. */
export interface PairedHashContext {
  specialty?: string | null;
  complexityBand?: string | null;
  complexityInputs?: unknown;
  lvcRuleIds?: string[];
  suppressionIds?: string[];
  quietingGen?: number;
}

const VITAL_ROW_KEYS = [
  'vitals_consult_uid', 'vitals_update_time',
  'measurements__blood_pressure', 'measurements__pulse_rate', 'measurements__spo2_level',
  'measurements__temperature', 'measurements__respiratory_value', 'measurements__early_warning_score',
  'patient_details__weight', 'patient_details__height',
] as const;

function patientContext(row: Record<string, unknown>, ctx?: PairedHashContext) {
  const { case: oc } = rowToOpdCase(row);
  const vitalsRaw: Record<string, unknown> = {};
  for (const key of VITAL_ROW_KEYS) vitalsRaw[key] = row[key] ?? null;
  return {
    consultType: oc.consultType,
    reason: oc.reasonForConsult,
    complaints: oc.presentingComplaints,
    history: oc.history,
    comorbidities: oc.comorbidities,
    allergies: oc.allergies,
    vitals: oc.vitals ?? null,
    vitalsRecorded: oc.vitalsRecorded ?? false,
    weightKg: oc.weightKg ?? null,
    heightCm: oc.heightCm ?? null,
    vitalsRaw,
    specialty: ctx?.specialty ?? null,
    complexityBand: ctx?.complexityBand ?? null,
    complexityInputs: ctx?.complexityInputs ?? null,
    lvcRuleIds: [...(ctx?.lvcRuleIds ?? [])].sort(),
    suppressionIds: [...(ctx?.suppressionIds ?? [])].sort(),
    quietingGen: ctx?.quietingGen ?? 0,
  };
}

export function overrideContentHash(
  path: 'structured' | 'text',
  structured: StructuredOverride,
  text: string | null,
  row?: Record<string, unknown>,
  ctx?: PairedHashContext,
): string {
  const body = path === 'text'
    ? { path, text: text ?? '' }
    : { path, structured };
  return sha256(stable({ ...body, context: row ? patientContext(row, ctx) : null }));
}

/** Hash of the signed case the engine will actually read, so a revised signed Rx misses dedupe. */
export function signedContentHash(row: Record<string, unknown>, ctx?: PairedHashContext): string {
  const { case: oc } = rowToOpdCase(row);
  return sha256(stable({
    path: 'signed',
    context: patientContext(row, ctx),
    diagnosisCodes: oc.diagnosisCodes,
    impressions: oc.impressions,
    impressionCodes: oc.impressionCodes,
    medications: oc.medications,
    investigations: oc.investigations,
    advice: oc.advice,
    examination: oc.examination,
    followUpType: oc.followUpType,
    followUpDateSet: oc.followUpDateSet,
    referrals: oc.referrals,
  }));
}

export function resolveOverride(input: {
  override?: StructuredOverride | null;
  override_text?: string | null;
}): {
  path: 'structured' | 'text';
  structured: StructuredOverride;
  text: string | null;
  hash: string;
  unparsed: boolean;
  coverage: TextCoverage | null;
} {
  if (hasStructuredContent(input.override)) {
    const structured = input.override!;
    return {
      path: 'structured', structured, text: null,
      hash: overrideContentHash('structured', structured, null),
      unparsed: overrideUnparsed(structured),
      coverage: null,
    };
  }
  const text = input.override_text ?? '';
  const coverage = assessOverrideText(text);
  return {
    path: 'text', structured: coverage.structured, text,
    hash: overrideContentHash('text', coverage.structured, text),
    unparsed: !coverage.ok,
    coverage,
  };
}

/**
 * When the signed row carries kx_encounter_id or consult_uid, the caller's external_ref
 * must be one of them. Both empty means the warehouse did not send a join key: do not fail,
 * and the caller counts that case.
 */
export function externalRefJoin(row: Record<string, unknown>, externalRef: string): { matches: boolean; neitherKey: boolean } {
  const present = [row.kx_encounter_id, row.consult_uid]
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter((v) => v.length > 0);
  if (present.length === 0) return { matches: true, neitherKey: true };
  return { matches: present.includes(externalRef), neitherKey: false };
}

export function externalRefMatches(row: Record<string, unknown>, externalRef: string): boolean {
  return externalRefJoin(row, externalRef).matches;
}

/** Stable join key for a de-identified results page. Not reversible to the note uid. */
export function pairKeyFor(runId: string, uid: string): string {
  return sha256(`${runId}|${uid}`).slice(0, 24);
}

const KEPT_LINE_PREFIXES = [
  'Consultation date',
  'Treating clinician specialty',
  'Consult type:',
  'Consult purposes:',
  'Encounter modality:',
  'Encounter:',
  'Reason for consult:',
  'Presenting complaints / history:',
  'Relevant history:',
  'Comorbidities:',
  'Allergies documented:',
];

const RX_LINE_PREFIXES = [
  'Diagnosis (ICD-10):',
  'Impression:',
  'Impression (ICD-10):',
  'Examination:',
  'Medications',
  'Investigations ordered:',
  'Clinician advice / plan:',
  'Patient-education',
  'Follow-up:',
  'Referred onward to:',
  'Disposition:',
];

/** Split a rendered case into patient-context lines and prescription-authored lines. */
export function caseTextSections(text: string): { kept: string[]; prescription: string[]; other: string[] } {
  const kept: string[] = [];
  const prescription: string[] = [];
  const other: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('  - ')) {
      prescription.push(line);
      continue;
    }
    if (KEPT_LINE_PREFIXES.some((p) => line.startsWith(p))) kept.push(line);
    else if (RX_LINE_PREFIXES.some((p) => line.startsWith(p))) prescription.push(line);
    else other.push(line);
  }
  return { kept, prescription, other };
}

export interface ProjectedFinding {
  subject: string | null;
  rationale: string | null;
  verdict: string | null;
  confidence: number | null;
  domain: string | null;
  informational: boolean;
  signal_type: string | null;
  rule_ref: string | null;
  lvc_category: string | null;
  direction: string | null;
  severity: string | null;
}

export interface ProjectedAudit {
  arm: string;
  engine_version: string | null;
  band: string | null;
  note_quality_index: number | null;
  llm_leg_failed: boolean;
  findings: ProjectedFinding[];
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length ? s : null;
}

/** Structured audit output. No note body, no keys, no doctor uid. */
export function projectAudit(audit: unknown, arm: string): ProjectedAudit {
  const a = (audit ?? {}) as Record<string, unknown>;
  const scorecard = (a.scorecard ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(a.findings) ? a.findings : [];
  const findings: ProjectedFinding[] = raw.map((item) => {
    const f = (item ?? {}) as Record<string, unknown>;
    const verdict = strOrNull(f.verdict);
    const confidence = typeof f.confidence === 'number' && Number.isFinite(f.confidence) ? f.confidence : null;
    return {
      subject: strOrNull(f.subject),
      rationale: strOrNull(f.rationale),
      verdict,
      confidence,
      domain: strOrNull(f.domain),
      informational: f.informational === true,
      signal_type: strOrNull(f.signal_type),
      rule_ref: strOrNull(f.rule_ref),
      lvc_category: strOrNull(f.lvc_category),
      direction: strOrNull(f.direction),
      severity: strOrNull(f.severity) ?? verdict,
    };
  });
  const headline = scorecard.headline;
  return {
    arm,
    engine_version: strOrNull(a.engineVersion),
    band: strOrNull(scorecard.band),
    note_quality_index: typeof headline === 'number' && Number.isFinite(headline) ? headline : null,
    llm_leg_failed: a.llmLegFailed === true,
    findings,
  };
}

export type PublicFinding = Omit<ProjectedFinding, 'rationale' | 'subject'>;

export function publicFinding(f: ProjectedFinding): PublicFinding {
  const { rationale: _rationale, subject: _subject, ...rest } = f;
  return rest;
}

export type PublicFlagRef = Omit<FlagRef, 'subject'>;

/** De-identified flag identity. The raw key contains the subject, so the public key is a hash. */
export function publicFlag(f: FlagRef): PublicFlagRef {
  const { subject: _subject, ...rest } = f;
  return { ...rest, key: sha256(f.key).slice(0, 24) };
}

export type PublicAgreement = Omit<FlagAgreement, 'subject'>;

export function publicAgreement(f: FlagAgreement): PublicAgreement {
  const { subject: _subject, ...rest } = f;
  return { ...rest, key: sha256(f.key).slice(0, 24) };
}

export interface FlagRef {
  key: string;
  subject: string | null;
  verdict: string | null;
  signal_type: string | null;
  domain: string | null;
  severity: string | null;
}

export function flagKey(f: { signal_type: string | null; subject: string | null; verdict: string | null }): string {
  return [f.signal_type ?? '', f.subject ?? '', f.verdict ?? ''].join('\u001f');
}

export function flagRef(f: ProjectedFinding): FlagRef {
  return {
    key: flagKey(f),
    subject: f.subject,
    verdict: f.verdict,
    signal_type: f.signal_type,
    domain: f.domain,
    severity: f.severity,
  };
}

export interface FlagDiff {
  only_a: FlagRef[];
  only_b: FlagRef[];
  both: FlagRef[];
}

/** Set difference on flag identity. Order follows arm A, then flags that exist only on B. */
export function diffFlags(a: ProjectedFinding[], b: ProjectedFinding[]): FlagDiff {
  const aRefs = new Map<string, FlagRef>();
  const bRefs = new Map<string, FlagRef>();
  for (const f of a) aRefs.set(flagKey(f), flagRef(f));
  for (const f of b) bRefs.set(flagKey(f), flagRef(f));
  const only_a: FlagRef[] = [];
  const both: FlagRef[] = [];
  for (const [key, ref] of aRefs) {
    if (bRefs.has(key)) both.push(ref);
    else only_a.push(ref);
  }
  const only_b: FlagRef[] = [];
  for (const [key, ref] of bRefs) {
    if (!aRefs.has(key)) only_b.push(ref);
  }
  return { only_a, only_b, both };
}

export function sameFlagSet(groups: ProjectedFinding[][]): boolean {
  if (groups.length <= 1) return true;
  const first = groups[0].map(flagKey).sort().join('\n');
  return groups.every((g) => g.map(flagKey).sort().join('\n') === first);
}

export interface FlagAgreement {
  key: string;
  signal_type: string | null;
  subject: string | null;
  verdict: string | null;
  present_in: number;
  repeats: number;
  agreement: number;
}

/** Per-flag rate across repeats of one arm. 1 means the flag was present on every repeat. */
export function flagAgreement(groups: ProjectedFinding[][]): FlagAgreement[] {
  const repeats = groups.length;
  const map = new Map<string, { ref: FlagRef; present: number }>();
  for (const group of groups) {
    const seen = new Set<string>();
    for (const f of group) {
      const key = flagKey(f);
      if (seen.has(key)) continue;
      seen.add(key);
      const cur = map.get(key);
      if (cur) cur.present += 1;
      else map.set(key, { ref: flagRef(f), present: 1 });
    }
  }
  return [...map.values()].map(({ ref, present }) => ({
    key: ref.key,
    signal_type: ref.signal_type,
    subject: ref.subject,
    verdict: ref.verdict,
    present_in: present,
    repeats,
    agreement: repeats === 0 ? 0 : present / repeats,
  }));
}

/**
 * Log records are an allow-list. Anything else — override text, findings, rationales,
 * note bodies — is dropped, including when a caller passes it by mistake.
 */
export const PAIRED_LOG_KEYS = [
  'run_id', 'uid', 'arm', 'repeat_idx', 'status', 'reason', 'calls', 'path',
  'queued', 'succeeded', 'skipped', 'deduped', 'failed', 'stopped',
] as const;

export function pairedLogRecord(event: string, fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { event };
  for (const key of PAIRED_LOG_KEYS) {
    if (fields[key] !== undefined) out[key] = fields[key];
  }
  return out;
}

export function parsePairedModel(spec: string): { provider: 'bedrock' | 'openrouter' | 'ollama' | 'vertex'; model: string } | null {
  const m = /^(bedrock|openrouter|ollama|vertex):(.+)$/.exec(spec.trim());
  if (!m) return null;
  return { provider: m[1] as 'bedrock' | 'openrouter' | 'ollama' | 'vertex', model: m[2] };
}
