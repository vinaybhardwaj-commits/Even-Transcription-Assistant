/**
 * O4 (V, 8 Oct 2026) — ROOM AUDIO NEVER GOES TO SARVAM.
 *
 * Only cut consult clips and doctor-app encounter audio may reach Sarvam. Room windows and room
 * ranges may not, from any caller. This used to hold only because two DB rows happened to say so
 * (stt_routing room = route, stt_engine sarvam is_paid); this is the code rule, so it holds with
 * those rows edited, and with `is_paid = false`, and with the engine explicitly named.
 */

export const SCOPE_CONSULT_ONLY = "scope_consult_only" as const;

/**
 * O5 (V, 09 Oct 2026, bus #10669) — the O4 rule now depends on WHO is calling.
 *   "production": the day-to-day ETA pipeline and anything that feeds notes or the app. Sarvam takes isolated consult clips only (doctor-app and phone encounter audio count as clips).
 *   "mcp": research and Scribe MCP tools. Any clip may go to Sarvam, including whole room windows and on-demand room segments; blind room-days are still never processed.
 * The class is set by the MCP tool layer ONLY (the authenticated MCP principal reaching submitJob as `callerClass`); no job argument can claim it. Anything unknown is production (fail closed).
 */
export type CallerClass = "production" | "mcp";
export const callerClassOf = (v: unknown): CallerClass => (v === "mcp" ? "mcp" : "production");
/** May this caller send ROOM audio (a window, a room-session range) to Sarvam? Only the MCP class. */
export const roomAudioAllowed = (caller: CallerClass): boolean => caller === "mcp";
/** The scopes a production caller may write to the paid-call row; the room ones are MCP-only (code-enforced where the row is written). */
export const PRODUCTION_SCOPES = ["consult_clip", "encounter"] as const;
export const RESEARCH_SOURCE_LABEL = "sarvam_mcp_research" as const;

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
