import { TRIAGE_SHADOW_VERBS, type TriageShadowVerb } from './shadow-schema';
import { isNoteClass, noteClassOf, type NoteClass } from './note-class';

export interface TriageStampInput {
  queue_item_ref?: string;
  note_class?: string;
  verb?: string;
  reason?: string | null;
  actor?: string;
  policy_version?: string;
  run_id?: string | null;
  run_metadata?: Record<string, unknown> | null;
}

export interface NormalizedTriageStamp {
  queue_item_ref: string;
  note_class: NoteClass;
  verb: TriageShadowVerb;
  reason: string;
  actor: 'triage-bot' | 'human';
  policy_version: string;
  run_id: string | null;
  run_metadata: Record<string, unknown>;
}

const dstr = (value: unknown, cap: number): string | null =>
  value == null || value === '' ? null : String(value).trim().slice(0, cap);

/** Verbs that call insertDecision. A retry of one of these must not mint a second row. */
const CLINICAL_STAMP_VERBS = ['valid', 'bug', 'route'] as const;

export function triageWriteEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.TRIAGE_BOT_WRITE === '1';
}

/**
 * Classes the bot may mint into Findings. Unset or blank → opd only.
 * An explicit list is taken as written (`opd,discharge_summary`). Tokens that
 * are not a note class are ignored; if none remain, the list falls back to opd
 * so a typo cannot open discharge mint and cannot lock OPD out by accident.
 * This does not read or set the flag. Discharge and OT mint stay off until the
 * allow-list names `discharge_summary` / `ot`.
 */
export function triageWriteClasses(env: Record<string, string | undefined> = process.env): NoteClass[] {
  const raw = env.TRIAGE_BOT_WRITE_CLASSES;
  if (raw == null || String(raw).trim() === '') return ['opd'];
  const out: NoteClass[] = [];
  for (const part of String(raw).split(',')) {
    const token = part.trim();
    if (isNoteClass(token) && !out.includes(token)) out.push(token);
  }
  return out.length ? out : ['opd'];
}

export function triageClassMintAllowed(
  noteClass: NoteClass,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return triageWriteClasses(env).includes(noteClass);
}

export function clinicalStampRequiresIdentity(verb: string): boolean {
  return (CLINICAL_STAMP_VERBS as readonly string[]).includes(verb);
}

/**
 * Same identity doctor-response uses: body client_request_id, else the Idempotency-Key header.
 * Empty after trim is treated as absent so a blank header does not become a shared key.
 */
export function resolveStampRequestId(
  clientRequestId: unknown,
  idempotencyKeyHeader: string | null | undefined,
): string | null {
  const fromBody = dstr(clientRequestId, 200);
  const fromHeader = dstr(idempotencyKeyHeader, 200);
  return fromBody || fromHeader || null;
}

export interface ParsedQueueItemRef {
  note_class: NoteClass;
  doctor_uid: string;
  signal_type: string;
}

/**
 * Class-safe `note_class|doctor_uid|signal_type`, or the legacy OPD form
 * `doctor_uid|signal_type` (note_class opd). A 3-part ref whose first segment
 * is not a note class is rejected. Extra pipes are rejected.
 */
export function parseQueueItemRef(ref: string): ParsedQueueItemRef | null {
  const parts = ref.split('|').map((part) => part.trim());
  if (parts.some((part) => !part)) return null;
  if (parts.length === 2) {
    return { note_class: 'opd', doctor_uid: parts[0], signal_type: parts[1] };
  }
  if (parts.length === 3 && isNoteClass(parts[0])) {
    return { note_class: parts[0], doctor_uid: parts[1], signal_type: parts[2] };
  }
  return null;
}

/** Legacy `doctor_uid|signal_type` and `opd|doctor_uid|signal_type` name the same OPD card. */
export function sameQueueItem(a: string, b: string): boolean {
  const left = parseQueueItemRef(a);
  const right = parseQueueItemRef(b);
  if (!left || !right) return false;
  return left.note_class === right.note_class
    && left.doctor_uid === right.doctor_uid
    && left.signal_type === right.signal_type;
}

export function validateTriageStamp(
  input: TriageStampInput,
): { ok: true; value: NormalizedTriageStamp } | { ok: false; error: string } {
  const queue_item_ref = dstr(input.queue_item_ref, 200);
  const parsed = queue_item_ref ? parseQueueItemRef(queue_item_ref) : null;
  if (!queue_item_ref || !parsed) {
    return { ok: false, error: 'queue_item_ref required as note_class|doctor_uid|signal_type' };
  }
  const echoedRaw = input.note_class == null || input.note_class === '' ? null : String(input.note_class).trim();
  if (echoedRaw != null && !isNoteClass(echoedRaw)) {
    return { ok: false, error: 'note_class must be opd|discharge_summary|ot' };
  }
  const segments = queue_item_ref.split('|').length;
  if (segments === 3) {
    if (!echoedRaw) return { ok: false, error: 'note_class required' };
    if (echoedRaw !== parsed.note_class) return { ok: false, error: 'note_class must match queue_item_ref' };
  } else if (echoedRaw && echoedRaw !== 'opd') {
    return { ok: false, error: 'note_class discharge_summary|ot requires queue_item_ref note_class|doctor_uid|signal_type' };
  }
  const note_class = noteClassOf(echoedRaw ?? parsed.note_class);
  if (typeof input.verb !== 'string' || !(TRIAGE_SHADOW_VERBS as readonly string[]).includes(input.verb)) {
    return { ok: false, error: 'verb must be valid|bug|route|hold|drop_informational' };
  }
  if (input.actor !== 'triage-bot' && input.actor !== 'human') {
    return { ok: false, error: 'actor must be triage-bot|human' };
  }
  const reason = dstr(input.reason, 4000);
  if (!reason) return { ok: false, error: 'reason required' };
  const policy_version = dstr(input.policy_version, 80);
  if (!policy_version) return { ok: false, error: 'policy_version required' };
  const run_metadata = input.run_metadata == null ? {} : input.run_metadata;
  if (typeof run_metadata !== 'object' || Array.isArray(run_metadata)) {
    return { ok: false, error: 'run_metadata must be an object' };
  }
  return {
    ok: true,
    value: {
      queue_item_ref,
      note_class,
      verb: input.verb as TriageShadowVerb,
      reason,
      actor: input.actor,
      policy_version,
      run_id: dstr(input.run_id, 120),
      run_metadata,
    },
  };
}
