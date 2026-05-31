/**
 * STT Engine Lab — routing resolver (L5).
 * Returns the engine an admin has pinned for a stage × language bucket, or null
 * to mean "use the built-in default logic". Safe by construction: a missing
 * row, an 'auto' value, or a disabled/adapterless engine all resolve to null
 * (default behaviour). Never throws.
 */
import { sql } from "@/lib/db";
import { adapterFor } from "./registry";

export type Stage = "live" | "note" | "diarize";
export type Bucket = "english" | "indic" | "default";

export async function resolveRouting(stage: Stage, bucket: Bucket): Promise<string | null> {
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
    const ok = (await sql`SELECT enabled FROM stt_engine WHERE id = ${eng} LIMIT 1`) as Array<{ enabled: boolean }>;
    if (!ok[0]?.enabled) return null;
    if (!adapterFor(eng)) return null;
    return eng;
  } catch {
    return null; // any error -> default behaviour
  }
}
