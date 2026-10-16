/**
 * Reader consult_windows — RUBRIC-SWEEP FIX3/FIX5. eta_encounter_windows: for a page of catalog consult_uids, the CLOSED window rows, so the rubric sweep can name each consult by its
 * consult_key ('<encounter_id>@<machine>', the key the consult unit is resolved by in readConsultSpan). Read only, ONE bound statement for the whole page; the caller bounds the page (the sweep
 * passes at most one page of 5,000 uids). Ids and UTC times only; no text. A still-open window (no t_close) is not a unit yet and is not returned. A held-out room-day is the caller's
 * concern (the sweep filters the catalog side; the run's own readers refuse a held-out consult_key): this reader returns keys and times, never room data.
 */
import { sql } from "@/lib/db";

export type WindowRow = { consult_uid: string; consult_key: string; t_open: string | Date; t_close: string | Date };

export async function readConsultWindows(uids: readonly string[]): Promise<WindowRow[]> {
  if (uids.length === 0) return [];
  return (await sql`
    SELECT consult_uid, consult_key, t_open, t_close FROM eta_encounter_windows
     WHERE consult_uid = ANY(${[...uids]}::text[]) AND t_close IS NOT NULL
  `) as WindowRow[];
}
