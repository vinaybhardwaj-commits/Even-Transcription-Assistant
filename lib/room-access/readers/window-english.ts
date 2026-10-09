/**
 * Reader window_english — S7-0. jev_window_text.english: the English text a bench window is read as. Refuses a blind room-day, and a window whose text is not a success
 * (source empty / not_ready / failed). The text itself is returned only with includeText (an LLM evaluator needs it; a count-only caller does not).
 */
import { sql } from "@/lib/db";
import { blindGuardWindow, refuse, type ReadResult } from "@/lib/room-access/readers/common";

export type WindowEnglish = { window_id: string; room_day_id: string; source: string; char_count: number; english: string | null };
const SUCCESS = new Set(["run_english", "native_en", "translated"]);

export async function readWindowEnglish(windowId: string, opts: { includeText?: boolean } = {}): Promise<ReadResult<WindowEnglish>> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(windowId)) return refuse("bad_unit_key");
  const blind = await blindGuardWindow(windowId); // the held-out set, BEFORE any content is read
  if (blind) return blind;
  const rows = (opts.includeText
    ? await sql`SELECT window_id, room_day_id, source, char_count, english FROM jev_window_text WHERE window_id = ${windowId}::text LIMIT 1`
    : await sql`SELECT window_id, room_day_id, source, char_count, NULL::text AS english FROM jev_window_text WHERE window_id = ${windowId}::text LIMIT 1`) as Array<WindowEnglish>;
  const r = rows[0];
  if (!r) return refuse("not_found", "no jev_window_text row");
  if (!SUCCESS.has(r.source)) return refuse("no_data", `window text source is ${r.source}`);
  return { ok: true, data: { ...r, char_count: Number(r.char_count) } };
}
