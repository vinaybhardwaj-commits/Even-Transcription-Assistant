/**
 * lib/timbre/consults.ts — the consult list the nightly Timbre job scores (Architecture #79 step 1).
 *
 * Reads consult_index (0150) through its one store (lib/room-access/consult-index-store.ts::listIndexDay; no new SQL) for
 * ONE IST date. Held-out room-days (BLIND_ROOM_DAYS) are dropped HERE, before the GPU host sees a key, so no blind audio is
 * ever fetched; they are counted (`withheld_blind`), never named. Clipless and `unclosed` rows are left out (no consult is
 * ever `sealed` in 0150 today, so sealed is passed through, not required).
 * Returned per consult: uid, cut_version, times, the clip key (the GPU host fetches it with its own R2 read), room id/slug,
 * session, doctor_uid8 (first 8 chars of the doctor uid: a pseudonymous calibration cell). No names, no text.
 */
import { listIndexDay } from "@/lib/room-access/consult-index-store";
import { isBlindRoomDay } from "@/lib/rubrics/blind-room-days";

export const TIMBRE_CONSULTS_MAX = 2000;

export type TimbreConsult = {
  consult_uid: string; cut_version: string; t0_ms: number; t1_ms: number; clip_r2_key: string;
  room_id: string; room_slug: string | null; session_id: string | null; doctor_uid8: string | null; minutes: number | null;
  quality: string | null; sealed: boolean;
};

export async function timbreConsultsForDay(date: string): Promise<{ consults: TimbreConsult[]; withheld_blind: number; skipped: number; total: number }> {
  const { rows, total } = await listIndexDay(date, null, TIMBRE_CONSULTS_MAX);
  let withheld = 0;
  let skipped = 0;
  const consults: TimbreConsult[] = [];
  for (const r of rows) {
    if (isBlindRoomDay(date, r.room_id)) { withheld++; continue; }
    if (!r.clip_r2_key || !r.cut_version || r.quality === "unclosed") { skipped++; continue; }
    consults.push({
      consult_uid: r.consult_uid, cut_version: r.cut_version, t0_ms: Number(r.t0_ms), t1_ms: Number(r.t1_ms), clip_r2_key: r.clip_r2_key,
      room_id: r.room_id, room_slug: r.room_slug ?? null, session_id: r.session_id ?? null,
      doctor_uid8: r.doctor_uid ? String(r.doctor_uid).slice(0, 8) : null, minutes: r.minutes === null || r.minutes === undefined ? null : Number(r.minutes),
      quality: r.quality ?? null, sealed: r.sealed === true,
    });
  }
  return { consults, withheld_blind: withheld, skipped, total };
}
