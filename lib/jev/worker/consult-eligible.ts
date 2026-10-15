/**
 * lib/jev/worker/consult-eligible.ts — JEV-EVERY-CONSULT S1: every closed consult with a stored transcript, oldest first (V ruling 15 Oct 2026: Jev on EVERY consult, record-only).
 * Replaces the seeded daily EVR sample for the two consult-level sets. Differences from selectEvrWindows (which is unchanged): no warehouse_prescription_uid, no BLIND_ROOM_DAYS,
 * a backfill window instead of a first day, ONE consult_key per consult_uid (the lexically smallest qualifying key), and subjects already decided for the set are excluded IN SQL so a
 * backlog larger than limit*4 never starves newer consults. The transcript test is TIGHTER than selectEvrWindows' (Addendum 1+2): a non-shadow ok reb translate row, OR a non-shadow ok stt row with an English consult_sarvam_result.language_code (en*)
 * (INFERRED: reb_track_index has no language column), AND the encounter_catalog stage sealed.state = 'ok' (cut final; NOT consult_index.sealed, which means "refuse Sarvam"). The bench cue path is dropped.
 * NOT HANDLED: a partial translate (gapfilled later); buildConsultState reads reb translate first, else the stt track when wholly English (from the R2 doc), then window_english / bench text.
 */
import { selectTranscribedConsults } from "@/lib/room-access/consult-select";

export const BACKFILL_DEFAULT_DAYS = 7;
export const BACKFILL_MAX_DAYS = 14;
export const CONSULT_SUBJECT_TYPE = "consult";

export function backfillDays(): number {
  const raw = process.env.JEV_CONSULT_BACKFILL_DAYS;
  const v = raw === undefined || raw.trim() === "" ? BACKFILL_DEFAULT_DAYS : Math.trunc(Number(raw));
  return Number.isFinite(v) && v >= 1 ? Math.min(BACKFILL_MAX_DAYS, v) : BACKFILL_DEFAULT_DAYS;
}

/** `ctx` (sha, mode) excludes subjects with a derived decision for that set sha in that mode — for ANY consult_key sharing the uid. Absent = no exclusion. */
export async function allTranscribedConsults(limit: number, ctx?: { sha: string; mode: string }): Promise<string[]> {
  const n = Math.max(1, Math.min(2000, Math.trunc(limit) || 1));
  const days = backfillDays();
  const sha = ctx?.sha ?? null, mode = ctx?.mode ?? "shadow";
  return selectTranscribedConsults(n, days, sha, mode, CONSULT_SUBJECT_TYPE);
}
