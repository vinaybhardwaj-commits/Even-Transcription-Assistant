/**
 * lib/voice-blind.ts — S6-BLIND: the held-out room-day rule for the voice / diarize READ tools (scribe_window_speakers, scribe_diarize_segments, scribe_get_clusters, scribe_list_voice_samples).
 * The set is lib/rubrics/blind-room-days.ts (14 pairs). A window is placed through bench_window.room_day_id (and room_diarize_window.room_day_id) -> room_day (room_id, ist_date). The guard runs BEFORE
 * any content row or R2 read: it asks only for the window's / room-day's placement. A held-out pair is refused `blind_room_day`; a window with no resolvable room-day is refused `window_unplaced`
 * (fail closed). No pair is ever named in an answer. Read only.
 */
import { sql } from "@/lib/db";
import { isBlindRoomDay } from "@/lib/rubrics/blind-room-days";

export type BlindRefusal = "blind_room_day" | "window_unplaced";
type Pair = { room_id: string; ist_date: string };

/** PURE — the refusal for a set of resolved pairs: none resolved = unplaced; any held out = blind. */
export function refusalForPairs(pairs: ReadonlyArray<Pair | null>): BlindRefusal | null {
  const real = pairs.filter((p): p is Pair => !!p && !!p.room_id && !!p.ist_date);
  if (real.length === 0) return "window_unplaced";
  return real.some((p) => isBlindRoomDay(p.ist_date, p.room_id)) ? "blind_room_day" : null;
}

/** A window's placement(s): bench_window.room_day_id and room_diarize_window.room_day_id, each through room_day. `known` = the window exists at all. */
export async function windowPlacement(windowId: string): Promise<{ known: boolean; pairs: Array<Pair | null> }> {
  const rows = (await sql`
    SELECT w.id, rd.room_id AS room_id, rd.ist_date::text AS ist_date, rd2.room_id AS room_id2, rd2.ist_date::text AS ist_date2
      FROM bench_window w
      LEFT JOIN room_day rd ON rd.id = w.room_day_id
      LEFT JOIN room_diarize_window d ON d.window_id = w.id
      LEFT JOIN room_day rd2 ON rd2.id = d.room_day_id
     WHERE w.id = ${windowId}::text
     LIMIT 1
  `) as Array<{ id: string; room_id: string | null; ist_date: string | null; room_id2: string | null; ist_date2: string | null }>;
  const r = rows[0];
  if (!r) return { known: false, pairs: [] };
  return { known: true, pairs: [r.room_id && r.ist_date ? { room_id: r.room_id, ist_date: r.ist_date } : null, r.room_id2 && r.ist_date2 ? { room_id: r.room_id2, ist_date: r.ist_date2 } : null] };
}

export async function roomDayPlacement(roomDayId: string): Promise<Pair | null> {
  const rows = (await sql`SELECT room_id, ist_date::text AS ist_date FROM room_day WHERE id = ${roomDayId}::text LIMIT 1`) as Array<Pair>;
  return rows[0] ?? null;
}

/** The refusal for a window id (unknown windows are `window_unplaced` here: no placement, fail closed), or null. */
export async function guardWindow(windowId: string): Promise<BlindRefusal | null> {
  const p = await windowPlacement(windowId);
  return refusalForPairs(p.pairs);
}
export async function guardRoomDay(roomDayId: string): Promise<BlindRefusal | null> {
  return refusalForPairs([await roomDayPlacement(roomDayId)]);
}

/**
 * Source ids of voice samples that are held out or unplaced WINDOWS. A passive sample is keyed by an ENCOUNTER (no room-day link: left as is); only an id that is a bench_window is checked, and a
 * window that is held out or unplaced blocks its sample's audio URL. Returns the blocked source ids.
 */
export async function blockedSampleSources(sourceIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(sourceIds.filter((x) => /^[A-Za-z0-9_-]{1,64}$/.test(x)))];
  if (ids.length === 0) return new Set();
  const rows = (await sql`
    SELECT w.id, rd.room_id AS room_id, rd.ist_date::text AS ist_date, rd2.room_id AS room_id2, rd2.ist_date::text AS ist_date2
      FROM bench_window w
      LEFT JOIN room_day rd ON rd.id = w.room_day_id
      LEFT JOIN room_diarize_window d ON d.window_id = w.id
      LEFT JOIN room_day rd2 ON rd2.id = d.room_day_id
     WHERE w.id = ANY(${ids}::text[])
  `) as Array<{ id: string; room_id: string | null; ist_date: string | null; room_id2: string | null; ist_date2: string | null }>;
  const out = new Set<string>();
  for (const r of rows) if (refusalForPairs([r.room_id && r.ist_date ? { room_id: r.room_id, ist_date: r.ist_date } : null, r.room_id2 && r.ist_date2 ? { room_id: r.room_id2, ist_date: r.ist_date2 } : null])) out.add(r.id);
  return out;
}
