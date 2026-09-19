/**
 * lib/jev/role-composite.ts — Slice J3 (ETA-JEV-ARM-D §6.3). PURE. Bench-side only: never feeds
 * room_turn_speaker (§6.1's own note). Acoustic (voiceprint cosine match) always outranks text —
 * text can say "a clinician is speaking", it cannot say WHICH one, so it never mints a
 * clinician_id.
 */
export type JevRoleAnswer = { role: string; role_confidence: number };
export type AcousticInfo = { clinician_id: string | null; match_confidence: number | null };

export type CompositeResult =
  | { role: "clinician"; clinician_id: string; agree: boolean }
  | { role: string; clinician_id: null }
  | { role: null; clinician_id: null; reason: "low_confidence" };

export const ETA_JEV_T_ROLE_DEFAULT = 0.6;

function envFloat(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

export const ETA_JEV_T_ROLE = envFloat("ETA_JEV_T_ROLE", ETA_JEV_T_ROLE_DEFAULT);

/**
 * `compositeRole` — acoustic wins outright when a voiceprint matched (never overridden by text,
 * and text never assigns a clinician_id even when it agrees). Otherwise text stands alone above
 * the confidence floor; below it the speaker is left null with reason 'low_confidence', never a
 * guess.
 */
export function compositeRole(text: JevRoleAnswer, acoustic: AcousticInfo, tRole: number = ETA_JEV_T_ROLE): CompositeResult {
  if (acoustic.clinician_id) {
    return { role: "clinician", clinician_id: acoustic.clinician_id, agree: text.role === "clinician" };
  }
  if (text.role_confidence >= tRole) {
    return { role: text.role, clinician_id: null };
  }
  return { role: null, clinician_id: null, reason: "low_confidence" };
}
