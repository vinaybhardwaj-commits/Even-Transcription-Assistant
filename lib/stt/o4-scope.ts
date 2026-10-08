/**
 * O4 (V, 8 Oct 2026) — ROOM AUDIO NEVER GOES TO SARVAM.
 *
 * Only cut consult clips and doctor-app encounter audio may reach Sarvam. Room windows and room
 * ranges may not, from any caller. This used to hold only because two DB rows happened to say so
 * (stt_routing room = route, stt_engine sarvam is_paid); this is the code rule, so it holds with
 * those rows edited, and with `is_paid = false`, and with the engine explicitly named.
 */

export const SCOPE_CONSULT_ONLY = "scope_consult_only" as const;

/** A typed refusal. Callers treat it as "refused", never as "no route, use the default". */
export type ScopeRefusal = { refused: true; code: typeof SCOPE_CONSULT_ONLY; engine: string };

/** True for adapter_key 'sarvam' or any engine id starting 'sarvam'. Pure. */
export function isSarvamEngine(engineId: string | null | undefined, adapterKey?: string | null): boolean {
  if (adapterKey === "sarvam") return true;
  return typeof engineId === "string" && engineId.startsWith("sarvam");
}

export function isScopeRefusal(v: unknown): v is ScopeRefusal {
  return typeof v === "object" && v !== null && (v as ScopeRefusal).refused === true && (v as ScopeRefusal).code === SCOPE_CONSULT_ONLY;
}
