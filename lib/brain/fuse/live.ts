/**
 * lib/brain/fuse/live.ts — the fuse runs by itself, behind the room's Visits switch (K2 Part D).
 *
 * Until now the fuse was an operator tool: scribe_fuse_run, scratch-only, dry-run by default.
 * ZERO visit rows existed on any live clinic day. This module is the first thing that writes a
 * visit on a real day, and every decision in it is shaped by that being true two days before a
 * live OPD recording day.
 *
 * ─── THE FLAG IS THE WHOLE SAFETY STORY ──────────────────────────────────────────────────
 * `isVisitsEnabled(roomId)` is per-room and defaults off (see lib/room-switches.ts, which carries the
 * hazard list of every call site). With the flag off for a room, NOTHING in this file executes
 * for that room: the cue route's call is inside an `if`, and runLiveFuse re-checks on entry so
 * the entry point is safe to call directly. The cue write path for a flag-off room is therefore
 * byte-for-byte what it was at 8b6e548 — provable by reading the route, not by trusting this
 * comment.
 *
 * ─── D4: READ AND COMPUTE OUTSIDE THE LOCK. TAKE THE LOCK ONLY TO WRITE. ─────────────────
 * The room_day advisory lock is per room_day and is held for the whole transaction. Arm A
 * reads the day's ENTIRE cue list, which grows all day — 19 August produced 2,030 stt_turn
 * cues on one room_day — so holding the lock across that read means every cue write for that
 * room queues behind a scan that gets slower as the day gets busier. On a stateless,
 * time-limited Vercel function that is how the kiosk starts timing out mid-clinic.
 *
 * So the order is: read (no lock) → compute (no lock, pure) → lock → write → release. It is
 * safe to compute outside the lock because arm A is a pure function, the insert is ON CONFLICT
 * DO NOTHING, and the update path takes optimistic concurrency on updated_at (C3) — a
 * computation that went stale while it was thinking LOSES rather than overwrites.
 *
 * The lock hold time is measured and returned as `lock_ms` so this claim can be checked
 * against a real busy day instead of believed.
 *
 * ─── D3: DEBOUNCE ────────────────────────────────────────────────────────────────────────
 * A burst of cues must collapse into one run. The debounce is IN-PROCESS and leading-edge with
 * a cooldown: the first cue for a room_day runs the fuse, and cues arriving inside the cooldown
 * mark the day dirty and return immediately. When a run finishes and the day was marked dirty
 * while it was running, exactly one more run follows, so the last cue of a burst is never left
 * unfused.
 *
 * IN-PROCESS IS HONESTLY WEAKER THAN IT SOUNDS, and this is the limit worth knowing: Vercel
 * runs many instances, so two instances can each run the fuse for the same room_day at the same
 * moment. That is SAFE — the insert is idempotent on (arm, opened_by) and the update is
 * optimistic — but it is not a global debounce, and the collapse ratio is per instance. A true
 * cross-instance debounce needs shared state; that is a table, and this build does not add one.
 */

import { sql } from "@/lib/db";
import { getPool } from "@/lib/brain/db";
import { withRoomDayLock } from "@/lib/brain/lock";
import {
  newVisitId,
  SQL_CUES_FOR_ROOM_DAY,
  SQL_VISIT_INSERT,
  SQL_VISITS_FOR_FUSE,
  DEFAULT_ARM,
} from "@/lib/brain/state";
import { ambiguityOf, runRulesArm, type TapeSession } from "./rules";
import { VISIT_STATES, type DraftVisit, type FuseCue } from "./types";
import { isVisitsEnabled } from "@/lib/room-switches";
import { updateOpenVisit } from "./visit-update";

/**
 * The cooldown. Not a clinical constant and not a prior about consultations — it is a
 * scheduling parameter about how often a machine may re-read a cue list, which is why it lives
 * here and not in rules.ts. rules.ts still contains exactly one invented constant.
 */
export const FUSE_DEBOUNCE_MS = 3_000;

type DebounceEntry = { running: boolean; dirty: boolean; lastStartedAt: number };
/** Module-scope, deliberately: this is per-instance scheduling state, NOT the flag. */
const debounce = new Map<string, DebounceEntry>();

export type LiveFuseResult = {
  ok: boolean;
  room_day_id: string;
  /** B3 — which branch the runner chose for this day. Observable, not inferred. */
  day_complete?: boolean;
  skipped?: "flag_off" | "debounced";
  cues_read?: number;
  drafts?: number;
  inserted?: number;
  updated?: number;
  unchanged?: number;
  lost?: number;
  frozen?: number;
  failed?: number;
  /** how long the advisory lock was actually held, ms — D4's claim, measured */
  lock_ms?: number;
  /** how long the read + pure compute took OUTSIDE the lock, ms */
  compute_ms?: number;
  error?: string;
};

type CueRow = { id: string; type: string; at: Date | string; payload: unknown; source: string | null; source_ref: string | null };
type VisitRow = {
  id: string;
  state: string;
  /** TEXT, not Date — see SQL_VISITS_FOR_FUSE. Microseconds must survive the round trip. */
  updated_at: string;
  opened_by: string | null;
  clinician_id: string | null;
  clinician_source: string | null;
  clinician_confidence: number | null;
};

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/**
 * The instant this IST day rolls over — midnight at the START OF THE NEXT DAY, in +05:30.
 *
 * Computed by the RUNNER and passed into the arm, which must not read a clock. On a live day
 * this boundary is in the future, and arm A closes everything it holds regardless; a visit that
 * is genuinely still running is therefore written already-closed at a future instant. That is
 * arm A's existing "a fused day has nothing still running" rule meeting a day that has not
 * finished, and K2 does not change the rule.
 */
/** The IST calendar date of an instant — the same rule istDate() uses, applied to a given ISO. */
function istDate0(iso: string): string {
  return new Date(new Date(iso).getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function istDayRolloverAt(istDate: string): string {
  const startOfDay = new Date(`${istDate}T00:00:00.000+05:30`);
  return new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

/** Bench sessions on this room that overlap the IST day. App DB — the tape lives there. */
export async function readSessionsForDay(roomId: string, istDate: string): Promise<TapeSession[]> {
  const dayStart = new Date(`${istDate}T00:00:00.000+05:30`).toISOString();
  const dayEnd = istDayRolloverAt(istDate);
  try {
    const rows = (await sql`
      SELECT id, started_at, ended_at
        FROM bench_session
       WHERE room_id = ${roomId}
         AND started_at < ${dayEnd}::timestamptz
         AND (ended_at IS NULL OR ended_at > ${dayStart}::timestamptz)
       ORDER BY started_at ASC, id ASC
    `) as Array<{ id: string; started_at: string | Date; ended_at: string | Date | null }>;
    return rows.map((r) => ({ id: r.id, started_at: iso(r.started_at), ended_at: r.ended_at ? iso(r.ended_at) : null }));
  } catch (e) {
    // No tape is a FINDING, not a failure: every visit simply gets a null binding. Failing the
    // whole fuse because the app DB was busy would turn a missing binding into a missing visit.
    console.warn("[fuse-live] session read failed; visits will bind to no tape", String((e as Error)?.message ?? e).slice(0, 160));
    return [];
  }
}

/**
 * Run the fuse for one LIVE room_day. Re-checks the Visits switch on entry, so the runner is safe to call directly.
 *
 * Never throws: a fuse failure must not turn a successful cue write into an error, because the
 * cue is the durable record and the fuse is a derived view of it.
 */
export async function runLiveFuse(roomId: string, roomDayId: string, istDate: string): Promise<LiveFuseResult> {
  if (!(await isVisitsEnabled(roomId))) return { ok: true, room_day_id: roomDayId, skipped: "flag_off" };
  try {
    return await fuseNow(roomId, roomDayId, istDate);
  } catch (e) {
    console.warn("[fuse-live] run failed", JSON.stringify({ room_day_id: roomDayId, err: String((e as Error)?.message ?? e).slice(0, 200) }));
    return { ok: false, room_day_id: roomDayId, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

/**
 * D3 — the debounced entry point the cue route calls. Collapses a burst into one run and
 * follows a burst with exactly one trailing run so nothing is left unfused.
 */
export async function scheduleLiveFuse(roomId: string, roomDayId: string, istDate: string): Promise<LiveFuseResult> {
  if (!(await isVisitsEnabled(roomId))) return { ok: true, room_day_id: roomDayId, skipped: "flag_off" };

  const now = Date.now();
  const entry = debounce.get(roomDayId) ?? { running: false, dirty: false, lastStartedAt: 0 };
  if (entry.running || now - entry.lastStartedAt < FUSE_DEBOUNCE_MS) {
    // Someone is already on it, or one just ran. Mark the day dirty so the in-flight run (or
    // the next cue) picks this evidence up, and get out of the cue path's way.
    entry.dirty = true;
    debounce.set(roomDayId, entry);
    return { ok: true, room_day_id: roomDayId, skipped: "debounced" };
  }

  entry.running = true;
  entry.dirty = false;
  entry.lastStartedAt = now;
  debounce.set(roomDayId, entry);
  try {
    const first = await runLiveFuse(roomId, roomDayId, istDate);
    // Cues that arrived WHILE we were computing are not lost: one trailing run, and only one,
    // so a steady stream of cues cannot spin this forever.
    const after = debounce.get(roomDayId);
    if (after?.dirty) {
      after.dirty = false;
      debounce.set(roomDayId, after);
      return await runLiveFuse(roomId, roomDayId, istDate);
    }
    return first;
  } finally {
    const e = debounce.get(roomDayId);
    if (e) {
      e.running = false;
      debounce.set(roomDayId, e);
    }
  }
}

async function fuseNow(roomId: string, roomDayId: string, istDate: string): Promise<LiveFuseResult> {
  const arm = DEFAULT_ARM;
  const t0 = Date.now();

  // ---- READ, NO LOCK (D4) -----------------------------------------------------------------
  const pool = getPool();
  const [cueRes, visitRes, sessions] = await Promise.all([
    pool.query<CueRow>(SQL_CUES_FOR_ROOM_DAY, [roomDayId]),
    pool.query<VisitRow>(SQL_VISITS_FOR_FUSE, [roomDayId, arm]),
    readSessionsForDay(roomId, istDate),
  ]);
  const cues: FuseCue[] = cueRes.rows.map((c) => ({
    id: c.id,
    type: c.type,
    at: iso(c.at),
    payload: c.payload && typeof c.payload === "object" && !Array.isArray(c.payload) ? (c.payload as Record<string, unknown>) : null,
    source: c.source,
    source_ref: c.source_ref,
  }));

  // ---- COMPUTE, NO LOCK, PURE (D4) --------------------------------------------------------
  //
  // K5 B3 — IS THIS DAY OVER? The runner knows; the arm must not guess.
  //
  //   today          → NO. The boundary is hours away, so rolling over to it would write every
  //                    visit already-ended at an instant that has not happened. `asOf` is now:
  //                    the only instant actually known to have passed, which is what a mark's
  //                    45-minute window is measured against.
  //   a PAST IST day → YES. Nothing more is coming; the boundary is real and behind us.
  //
  // This is the one clock read in the fuse, and it is HERE, in the runner, not in rules.ts.
  const nowIso = new Date().toISOString();
  const dayComplete = istDate < istDate0(nowIso);
  const { visits: drafts } = runRulesArm(cues, {
    day_complete: dayComplete,
    ...(dayComplete ? { rolloverAt: istDayRolloverAt(istDate) } : { asOf: nowIso }),
    sessions,
  });
  // (arm, opened_by) is the unique key, so opened_by is how a draft finds the row it already wrote.
  const existing = new Map<string, VisitRow>();
  for (const v of visitRes.rows) if (v.opened_by) existing.set(v.opened_by, v);
  const compute_ms = Date.now() - t0;

  // ---- WRITE, UNDER THE LOCK, AND NOTHING ELSE (D4) ---------------------------------------
  let lockAcquiredAt = 0;
  const counts = { inserted: 0, updated: 0, unchanged: 0, lost: 0, frozen: 0, failed: 0 };
  await withRoomDayLock(roomDayId, async (client) => {
    lockAcquiredAt = Date.now();
    for (const d of drafts) {
      if (!d.opened_by || !(VISIT_STATES as readonly string[]).includes(d.state)) {
        counts.failed++;
        continue;
      }
      const prior = existing.get(d.opened_by);
      if (!prior) {
        try {
          const r = await client.query<{ id: string }>(SQL_VISIT_INSERT, insertParams(roomDayId, arm, d));
          // No row back means the partial unique index absorbed it — another writer got there
          // first. That is "already exists", the same contract the cue writers have.
          if ((r.rowCount ?? 0) > 0) counts.inserted++;
          else counts.unchanged++;
        } catch {
          counts.failed++;
        }
        continue;
      }
      if (prior.state === "ended") {
        // C1's freeze. A closed visit's account of what happened is final here; only the
        // operator path may still name its clinician.
        counts.frozen++;
        continue;
      }
      try {
        const out = await updateOpenVisit(client, prior.id, prior.updated_at, {
          state: d.state,
          ended_at: d.state === "ended" ? d.ended_at : null,
          confidence: d.confidence,
          end_reason: d.state === "ended" ? d.end_reason : null,
          ambiguity: ambiguityOf(d.reasons),
          session_id: d.session_id,
          tape_start_ms: d.tape_start_ms,
          tape_end_ms: d.tape_end_ms,
          clinician_id: d.clinician_id,
          clinician_source: d.clinician_source,
          clinician_confidence: d.clinician_confidence,
        });
        // C3: a lost write is not an error. The row moved under us; the next run re-reads it.
        if (out.won) counts.updated++;
        else counts.lost++;
      } catch {
        counts.failed++;
      }
    }
  });
  const lock_ms = lockAcquiredAt > 0 ? Date.now() - lockAcquiredAt : 0;

  return { ok: true, room_day_id: roomDayId, day_complete: dayComplete, cues_read: cues.length, drafts: drafts.length, ...counts, lock_ms, compute_ms };
}

function insertParams(roomDayId: string, arm: string, d: DraftVisit): unknown[] {
  return [
    newVisitId(),
    roomDayId,
    d.individual_uid,
    d.consult_uid,
    d.state,
    d.pstart_at,
    d.confidence,
    d.state === "ended" ? d.end_reason : null,
    ambiguityOf(d.reasons),
    arm,
    d.opened_by,
    d.opened_by_kind,
    d.state === "ended" ? d.ended_at : null,
    d.session_id,
    d.tape_start_ms,
    d.tape_end_ms,
    d.clinician_id,
    d.clinician_source,
    d.clinician_confidence,
  ];
}
