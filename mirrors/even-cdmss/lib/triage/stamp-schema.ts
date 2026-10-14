import { TRIAGE_SHADOW_VERBS, type TriageShadowVerb } from './shadow-schema';

export interface TriageStampInput {
  queue_item_ref?: string;
  verb?: string;
  reason?: string | null;
  actor?: string;
  policy_version?: string;
  run_id?: string | null;
  run_metadata?: Record<string, unknown> | null;
}

export interface NormalizedTriageStamp {
  queue_item_ref: string;
  verb: TriageShadowVerb;
  reason: string;
  actor: 'triage-bot' | 'human';
  policy_version: string;
  run_id: string | null;
  run_metadata: Record<string, unknown>;
}

const dstr = (value: unknown, cap: number): string | null =>
  value == null || value === '' ? null : String(value).trim().slice(0, cap);

export function triageWriteEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.TRIAGE_BOT_WRITE === '1';
}

export function parseQueueItemRef(ref: string): { doctor_uid: string; signal_type: string } | null {
  const split = ref.indexOf('|');
  if (split <= 0 || split === ref.length - 1 || ref.indexOf('|', split + 1) !== -1) return null;
  const doctor_uid = ref.slice(0, split).trim();
  const signal_type = ref.slice(split + 1).trim();
  return doctor_uid && signal_type ? { doctor_uid, signal_type } : null;
}

export function validateTriageStamp(
  input: TriageStampInput,
): { ok: true; value: NormalizedTriageStamp } | { ok: false; error: string } {
  const queue_item_ref = dstr(input.queue_item_ref, 200);
  if (!queue_item_ref || !parseQueueItemRef(queue_item_ref)) {
    return { ok: false, error: 'queue_item_ref required as doctor_uid|signal_type' };
  }
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
      verb: input.verb as TriageShadowVerb,
      reason,
      actor: input.actor,
      policy_version,
      run_id: dstr(input.run_id, 120),
      run_metadata,
    },
  };
}
