/**
 * lib/freescript/internal.ts — C4 (Fable 5.1, FRX-V10): the heard strength, frequency, duration and the tape pointer of a medicine live in the artifact's
 * `confirm_internal` field. No Pulse-facing or doctor-facing read returns it before the v1.1 gate (spec rule 25). Every serializer calls publicArtifact;
 * only an explicit admin read passes { internal: true }. Pure.
 */
export const INTERNAL_KEYS = ["confirm_internal"] as const;

export function publicArtifact(artifact: unknown, opts: { internal?: boolean } = {}): unknown {
  if (opts.internal === true || artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) return artifact;
  const out: Record<string, unknown> = { ...(artifact as Record<string, unknown>) };
  for (const k of INTERNAL_KEYS) delete out[k];
  return out;
}
