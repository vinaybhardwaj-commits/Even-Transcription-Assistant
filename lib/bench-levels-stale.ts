import { sql } from "@/lib/db";
import { levelsStale, type LevelStamp } from "@/lib/bench-meter";

/**
 * Arch #19 — per room, is the level frozen or old. Derived here, at read time, from the last 30 s of bench_level_sample rows; nothing is
 * written. A read that fails leaves the room out of the map: `levels_stale: null` means "could not judge", and the card does not grey on it.
 * NO SAMPLES IN THE WINDOW IS STALE (true), not unknown: this runs for rooms whose kiosk is polling, and a kiosk that keeps polling but stops sending
 * levels would otherwise show its last listener value lit again once the 30 s window emptied (refuter C1). Only a newest sample with no zero_ratio is null.
 */
export async function readLevelsStale(ids: readonly string[], nowMs: number): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  if (ids.length === 0) return out;
  try {
    const rows = (await sql`
      SELECT room_id, sampled_at, peak, avg, zero_ratio
        FROM bench_level_sample
       WHERE room_id = ANY(${ids}::text[])
         AND ist_date >= ((now() - interval '1 day') AT TIME ZONE 'Asia/Kolkata')::date
         AND sampled_at > now() - interval '30 seconds'
       ORDER BY sampled_at ASC
       LIMIT 2000
    `) as Array<{ room_id: string; sampled_at: string | Date; peak: number | string; avg: number | string | null; zero_ratio: number | string | null }>;
    const by = new Map<string, LevelStamp[]>();
    for (const r of rows) {
      const list = by.get(r.room_id) ?? [];
      list.push({ t_ms: new Date(r.sampled_at).getTime(), peak: Number(r.peak), avg: r.avg === null ? null : Number(r.avg), zero_ratio: r.zero_ratio === null ? null : Number(r.zero_ratio) });
      by.set(r.room_id, list);
    }
    for (const id of ids) out.set(id, levelsStale(by.get(id) ?? [], nowMs));
  } catch (e) {
    console.warn("[bench-listeners] levels_stale read failed", String((e as Error)?.message ?? e).slice(0, 160));
  }
  return out;
}

