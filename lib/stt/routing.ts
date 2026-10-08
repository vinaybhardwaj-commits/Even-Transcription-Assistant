/**
 * STT Engine Lab — routing resolver (L5).
 * Returns the engine an admin has pinned for a stage × language bucket, or null
 * to mean "use the built-in default logic". Safe by construction: a missing
 * row, an 'auto' value, or a disabled/adapterless engine all resolve to null
 * (default behaviour). Never throws.
 */
import { sql } from "@/lib/db";
import { adapterFor } from "./registry";
import { isSarvamEngine, SCOPE_CONSULT_ONLY, type ScopeRefusal } from "./o4-scope";

export type Stage = "live" | "note" | "diarize" | "room";
export type Bucket = "english" | "indic" | "default";

/**
 * O4: for stage 'room' a Sarvam engine is never returned — the answer is a typed refusal
 * (`scope_consult_only`). Other stages are unchanged and still resolve to `string | null`.
 */
export async function resolveRouting(stage: "room", bucket: Bucket): Promise<string | null | ScopeRefusal>;
export async function resolveRouting(stage: Stage, bucket: Bucket): Promise<string | null>;
export async function resolveRouting(stage: Stage, bucket: Bucket): Promise<string | null | ScopeRefusal> {
  try {
    let eng: string | null = null;
    const rows = (await sql`SELECT engine_id FROM stt_routing WHERE stage = ${stage} AND language_bucket = ${bucket} LIMIT 1`) as Array<{ engine_id: string }>;
    eng = rows[0]?.engine_id ?? null;
    if (!eng || eng === "auto") {
      const d = (await sql`SELECT engine_id FROM stt_routing WHERE stage = ${stage} AND language_bucket = 'default' LIMIT 1`) as Array<{ engine_id: string }>;
      eng = d[0]?.engine_id ?? null;
      if (!eng || eng === "auto") return null;
    }
    // Only honor an override if the engine is enabled AND has a code adapter.
    const ok = (await sql`SELECT enabled, adapter_key FROM stt_engine WHERE id = ${eng} LIMIT 1`) as Array<{ enabled: boolean; adapter_key?: string }>;
    // O4 comes BEFORE the enabled/adapter checks: a disabled Sarvam row must read as a refusal, not
    // as "no route", so nobody "fixes" it by enabling something else under the same name.
    if (stage === "room" && isSarvamEngine(eng, ok[0]?.adapter_key)) return { refused: true, code: SCOPE_CONSULT_ONLY, engine: eng };
    if (!ok[0]?.enabled) return null;
    if (!adapterFor(eng)) return null;
    return eng;
  } catch {
    return null; // any error -> default behaviour
  }
}
