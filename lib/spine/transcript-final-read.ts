/**
 * lib/spine/transcript-final-read.ts — SPINE S7a: what feed-orch polls. Events are spine_tick rows of kind `transcript_final_event` (live; shadow ones are kind `transcript_final_shadow`, off by default),
 * read in id order after a cursor, each joined at READ TIME to its encounter (room, IST date, whether this cut is still the current one) and the encounter's active consult_uid / consult_key links.
 * Ids, counts, stamps, run ids and a sha256 only: no transcript text. A newer cut_version of the same encounter is a NEW event; `current` says which one stands now.
 */
import { sql } from "@/lib/db";
import { EVENT_KIND, SHADOW_KIND, type FinalEvent } from "./transcript-final";

export type FinalEventRow = FinalEvent & { event_id: number; recorded_at: string; consult_uid: string | null; consult_key: string | null; current: boolean };
export const READ_LIMIT_MAX = 200;

export async function readFinalEvents(o: { after?: number; limit?: number; shadow?: boolean } = {}): Promise<{ events: FinalEventRow[]; next_after: number }> {
  const after = Number.isInteger(o.after) && (o.after as number) > 0 ? (o.after as number) : 0;
  const limit = Math.min(READ_LIMIT_MAX, Math.max(1, Number.isInteger(o.limit) ? (o.limit as number) : 50));
  const kind = o.shadow === true ? SHADOW_KIND : EVENT_KIND;
  const rows = (await sql`
    SELECT t.id, t.ticked_at, t.counts, e.status, e.boundary_rev,
      (SELECT l.value FROM spine_link l WHERE l.encounter_id = t.counts->>'encounter_id' AND l.key_kind = 'consult_uid' AND l.active ORDER BY l.created_at DESC LIMIT 1) AS consult_uid,
      (SELECT l.value FROM spine_link l WHERE l.encounter_id = t.counts->>'encounter_id' AND l.key_kind = 'consult_key' AND l.active ORDER BY l.created_at DESC LIMIT 1) AS consult_key
      FROM spine_tick t LEFT JOIN spine_encounter e ON e.encounter_id = t.counts->>'encounter_id'
     WHERE t.kind = ${kind}::text AND t.id > ${after}::bigint
     ORDER BY t.id LIMIT ${limit}::int`) as Array<Record<string, unknown>>;
  const events = rows.map((r) => {
    const ev = (typeof r.counts === "string" ? JSON.parse(r.counts) : r.counts) as FinalEvent;
    return {
      ...ev, event_id: Number(r.id), recorded_at: new Date(String(r.ticked_at)).toISOString(),
      consult_uid: r.consult_uid == null ? null : String(r.consult_uid), consult_key: r.consult_key == null ? null : String(r.consult_key),
      current: r.status === "confirmed" && ev.cut_version === `r${Number(r.boundary_rev)}`,
    };
  });
  return { events, next_after: events.length ? events[events.length - 1].event_id : after };
}
