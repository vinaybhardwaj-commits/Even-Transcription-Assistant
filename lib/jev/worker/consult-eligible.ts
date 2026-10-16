/**
 * lib/jev/worker/consult-eligible.ts — JEV-EVERY-CONSULT S1: every closed consult with a stored transcript, oldest first (V ruling 15 Oct 2026: Jev on EVERY consult, record-only).
 * Replaces the seeded daily EVR sample for the two consult-level sets. Differences from selectEvrWindows (which is unchanged): no warehouse_prescription_uid, no BLIND_ROOM_DAYS,
 * a backfill window instead of a first day, ONE consult_key per consult_uid (the lexically smallest qualifying key), and subjects already decided for the set are excluded IN SQL so a
 * backlog larger than limit*4 never starves newer consults. The transcript test (Fix 2, palimpsest-architect's rule) is the encounter_catalog stage rule: sealed ok AND stt ok AND (translate ok OR translate n/a with reason english); see consult-select.ts (INFERRED stage keys). It is TIGHTER than selectEvrWindows'. The bench cue path is dropped.
 * buildConsultState reads reb translate first, else the stt track when wholly English (from the R2 doc), then window_english / bench text.
 */
import { selectTranscribedConsults, selectTranscribedConsultsBefore } from "@/lib/room-access/consult-select";

export const BACKFILL_DEFAULT_DAYS = 7;
export const BACKFILL_MAX_DAYS = 14;
export const CONSULT_SUBJECT_TYPE = "consult";

export function backfillDays(): number {
  const raw = process.env.JEV_CONSULT_BACKFILL_DAYS;
  const v = raw === undefined || raw.trim() === "" ? BACKFILL_DEFAULT_DAYS : Math.trunc(Number(raw));
  return Number.isFinite(v) && v >= 1 ? Math.min(BACKFILL_MAX_DAYS, v) : BACKFILL_DEFAULT_DAYS;
}

/** Floor for the two BACKFILL_SINCE env vars (IST date). */
export const BACKFILL_SINCE_FLOOR = "2026-09-01";

/**
 * An IST calendar date `YYYY-MM-DD` that is real, at or after BACKFILL_SINCE_FLOOR and not after today (IST), else null (= OFF). Never throws.
 * Shared by JEV_CONSULT_BACKFILL_SINCE and CATALOG_C4_BACKFILL_SINCE. `nowMs` is injectable for tests.
 */
export function parseBackfillSince(raw: string | undefined, nowMs: number = Date.now()): string | null {
  const v = (raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return null;
  if (v < BACKFILL_SINCE_FLOOR) return null;
  const todayIst = new Date(nowMs + 5.5 * 3_600_000).toISOString().slice(0, 10);
  return v > todayIst ? null : v;
}

export type BackfillSinceState = "off" | "on" | "bad";
/** off = unset or empty after trim; on = parses; bad = set to something the parser rejects. Never returns or logs the value. */
export function backfillSinceState(raw: string | undefined, nowMs: number = Date.now()): BackfillSinceState {
  if ((raw ?? "").trim() === "") return "off";
  return parseBackfillSince(raw, nowMs) === null ? "bad" : "on";
}

/** JEV_CONSULT_BACKFILL_SINCE: the Jev sweeper's second pass lower bound (IST date), or null = OFF. */
export function jevBackfillSince(nowMs: number = Date.now()): string | null {
  return parseBackfillSince(process.env.JEV_CONSULT_BACKFILL_SINCE, nowMs);
}

const IST_MS = 5.5 * 3_600_000, DAY_MS = 86_400_000;
/**
 * FIX1 F2: the two instants of a backfill range, computed ONCE per call in JS so both statements of a pass pair see the same boundary even across IST midnight.
 * hi = start of the `days`-IST-day window (IST midnight, `days` days before today's), lo = `since` 00:00 IST. ISO UTC strings, bound as timestamptz.
 */
export function backfillBounds(nowMs: number, days: number, since: string): { hi: string; lo: string; hiMs: number; loMs: number } {
  const hiMs = Math.floor((nowMs + IST_MS) / DAY_MS) * DAY_MS - days * DAY_MS - IST_MS;
  const loMs = Date.parse(`${since}T00:00:00Z`) - IST_MS;
  return { hi: new Date(hiMs).toISOString(), lo: new Date(loMs).toISOString(), hiMs, loMs };
}

/** `ctx` (sha, mode) excludes subjects with a derived decision for that set sha in that mode — for ANY consult_key sharing the uid. Absent = no exclusion. */
export async function allTranscribedConsults(limit: number, ctx?: { sha: string; mode: string }, nowMs: number = Date.now()): Promise<string[]> {
  const n = Math.max(1, Math.min(2000, Math.trunc(limit) || 1));
  const days = backfillDays();
  const sha = ctx?.sha ?? null, mode = ctx?.mode ?? "shadow";
  const live = await selectTranscribedConsults(n, days, sha, mode, CONSULT_SUBJECT_TYPE);
  const since = jevBackfillSince(nowMs);
  if (since === null && backfillSinceState(process.env.JEV_CONSULT_BACKFILL_SINCE, nowMs) === "bad") console.info("jev consult backfill_since=bad");
  if (since === null || live.length >= n) return live;
  // pass 2: only capacity the live window leaves unused, from the half-open range [since 00:00 IST, start of the pass-1 window)
  const b = backfillBounds(nowMs, days, since);
  const older = await selectTranscribedConsultsBefore(n - live.length, b.lo, b.hi, live, sha, mode, CONSULT_SUBJECT_TYPE);
  console.info(`jev consult backfill_picked=${older.length}`);
  return [...new Set([...live, ...older])];
}
