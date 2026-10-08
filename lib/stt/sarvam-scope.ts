/**
 * lib/stt/sarvam-scope.ts — S8A-FIX2. V's ruling O4 (08 Oct 21:05 IST): Sarvam takes ONLY cut consult clips and doctor-app / phone encounter audio,
 * everywhere, from every caller. These helpers answer "does this engine id reach Sarvam" and "does the room stage route to Sarvam", so the MCP
 * door can refuse room / bench audio on the way there with the typed error scope_consult_only. Encounter paths do not call them.
 *
 * "Reaches Sarvam" means: the id itself names Sarvam (sarvam, sarvam-gw, sarvam_*), OR its stt_engine row's adapter_key is `sarvam` (the direct key;
 * the gateway is reached only by lib/sarvam-gw.ts, which this door's own kinds control). A database error answers `unavailable` and the request is REFUSED
 * (fail closed): a database error never means "no".
 */
import { sql } from "@/lib/db";

export const SCOPE_CONSULT_ONLY = "scope_consult_only";
export const ROOM_AUDIO_DETAIL = "room and bench audio is not sent to Sarvam; only cut consult clips and doctor-app / phone encounter audio are";

/** PURE: an engine id that names Sarvam. */
export const namesSarvam = (engineId: string | null | undefined): boolean => typeof engineId === "string" && /sarvam/i.test(engineId);

/**
 * The scope check's answer. FAIL CLOSED (S5): `unavailable` means a database read the check needs FAILED, so nothing can be said about the engine, and it is
 * treated exactly like Sarvam — refused — but with its own reason code (scope_check_unavailable) so the caller is not told a lie about WHY.
 */
export type ScopeVerdict = "sarvam" | "clear" | "unavailable";
export const SCOPE_CHECK_UNAVAILABLE = "scope_check_unavailable";
export const SCOPE_CHECK_DETAIL = "the Sarvam scope check could not be completed (the engine table could not be read), so the request is refused rather than risk sending room audio to Sarvam";

/** An engine id that is, or routes through an adapter that is, Sarvam. A name check needs no database; an id that is not named needs the stt_engine row. */
export async function checkEngine(engineId: string | null | undefined): Promise<ScopeVerdict> {
  if (!engineId) return "clear"; // no engine named is not an engine
  if (namesSarvam(engineId)) return "sarvam";
  try {
    const rows = (await sql`SELECT adapter_key FROM stt_engine WHERE id = ${engineId}::text LIMIT 1`) as Array<{ adapter_key: string | null }>;
    return namesSarvam(rows[0]?.adapter_key ?? null) ? "sarvam" : "clear";
  } catch {
    return "unavailable";
  }
}

/**
 * Does ANY language bucket of the `room` stage route to a Sarvam engine? That is the engine every drained room window would be sent to
 * (stt_routing, stage 'room'). Read before a window is claimed, so refusing leaves the window exactly as it was.
 * `sarvam` wins over `unavailable` (a known Sarvam route is the better reason); a failed routing read, or any route whose engine row cannot be read, is `unavailable`.
 */
export async function checkRoomStage(): Promise<ScopeVerdict> {
  let rows: Array<{ engine_id: string | null }>;
  try {
    rows = (await sql`SELECT engine_id FROM stt_routing WHERE stage = 'room' ORDER BY engine_id NULLS FIRST`) as Array<{ engine_id: string | null }>;
  } catch {
    return "unavailable";
  }
  let unavailable = false;
  for (const r of rows) {
    if (!r.engine_id || r.engine_id === "auto") continue;
    const v = await checkEngine(r.engine_id);
    if (v === "sarvam") return "sarvam";
    if (v === "unavailable") unavailable = true;
  }
  return unavailable ? "unavailable" : "clear";
}

/** Boolean forms: true for Sarvam AND for unavailable (fail closed). Callers that need the REASON use checkEngine / checkRoomStage. */
export const engineRoutesToSarvam = async (engineId: string | null | undefined): Promise<boolean> => (await checkEngine(engineId)) !== "clear";
export const roomStageRoutesToSarvam = async (): Promise<boolean> => (await checkRoomStage()) !== "clear";

/** The typed refusal for a non-clear verdict: scope_consult_only for Sarvam, scope_check_unavailable when the check itself could not run. */
export const sarvamScopeRefusal = (extra: Record<string, unknown> = {}, verdict: ScopeVerdict = "sarvam") =>
  verdict === "unavailable"
    ? { ok: false as const, error: SCOPE_CHECK_UNAVAILABLE, detail: SCOPE_CHECK_DETAIL, ...extra }
    : { ok: false as const, error: SCOPE_CONSULT_ONLY, detail: ROOM_AUDIO_DETAIL, ...extra };
