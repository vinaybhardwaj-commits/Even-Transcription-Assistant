/**
 * lib/triage/shadow-schema.ts — CAT Managed Care Audit Triage shadow proposals (pure).
 *
 * Bot verbs match the CM Action-queue language, not Review Mode pills and not stewardship scores.
 * This module never stamps opd_audit_triage and never mints opd_gov_signal.
 */

export const TRIAGE_SHADOW_VERBS = ['valid', 'bug', 'route', 'hold', 'drop_informational'] as const;
export type TriageShadowVerb = (typeof TRIAGE_SHADOW_VERBS)[number];

/** Type-level Action-queue card identity — same key the CM board uses (`doctor_uid|signal_type`). */
export function actionQueueItemRef(doctorUid: string, signalType: string): string {
  return `${doctorUid}|${signalType}`;
}

export interface ShadowProposalInput {
  queue_item_ref?: string;
  verb?: string;
  reason?: string | null;
  confidence?: number | null;
  policy_version?: string;
  run_id?: string;
  actor?: string | null;
}

export interface NormalizedShadowProposal {
  queue_item_ref: string;
  verb: TriageShadowVerb;
  reason: string | null;
  confidence: number | null;
  policy_version: string;
  run_id: string;
  actor: string | null;
}

const inSet = <T extends string>(arr: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (arr as readonly string[]).includes(v);

const dstr = (v: unknown, cap: number): string | null =>
  (v == null || v === '' ? null : String(v).trim().slice(0, cap));

/**
 * Real Valid/Bug/Route that mutates triage or mints opd_gov_signal is out of this slice.
 * Propose (shadow table) is allowed. Stamp is always refused — SHADOW_ONLY hard gate.
 */
export function assertShadowOnlyWrite(kind: 'propose' | 'stamp'): { ok: true } | { ok: false; error: string } {
  if (kind === 'stamp') {
    return { ok: false, error: 'SHADOW_ONLY: real triage Valid/Bug/Route and opd_gov_signal mint are not exposed' };
  }
  return { ok: true };
}

export function validateShadowProposal(
  input: ShadowProposalInput,
  defaults: { policy_version?: string; run_id?: string; actor?: string | null } = {},
): { ok: true; value: NormalizedShadowProposal } | { ok: false; error: string } {
  const queue_item_ref = dstr(input.queue_item_ref, 200);
  if (!queue_item_ref || !queue_item_ref.includes('|')) {
    return { ok: false, error: 'queue_item_ref required as doctor_uid|signal_type' };
  }
  if (!inSet(TRIAGE_SHADOW_VERBS, input.verb)) {
    return { ok: false, error: 'verb must be valid|bug|route|hold|drop_informational' };
  }
  const policy_version = dstr(input.policy_version, 80) || dstr(defaults.policy_version, 80);
  if (!policy_version) return { ok: false, error: 'policy_version required' };
  const run_id = dstr(input.run_id, 120) || dstr(defaults.run_id, 120);
  if (!run_id) return { ok: false, error: 'run_id required' };
  let confidence: number | null = null;
  if (input.confidence != null && input.confidence !== ('' as unknown)) {
    const n = Number(input.confidence);
    if (!Number.isFinite(n) || n < 0 || n > 1) return { ok: false, error: 'confidence must be 0..1' };
    confidence = n;
  }
  return {
    ok: true,
    value: {
      queue_item_ref,
      verb: input.verb,
      reason: dstr(input.reason, 4000),
      confidence,
      policy_version,
      run_id,
      actor: dstr(input.actor, 64) ?? dstr(defaults.actor, 64),
    },
  };
}
