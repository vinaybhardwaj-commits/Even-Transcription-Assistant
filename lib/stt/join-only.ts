/**
 * lib/stt/join-only.ts — produce a window's clip, and nothing else.
 *
 * WHY. A clip is written today only by `roomWindowPrepare`, phase 1 of the room_window job, which
 * also probes a language and hands on to Whisper. Producing a clip for the backlog therefore costs
 * a full job. This path is the join alone, calling `joinClipForWindow` — the seam extracted from
 * that phase — so joining has one implementation and not two.
 *
 * ─── TWO DECISIONS, DELIBERATELY SEPARATE ───────────────────────────────────────────────────────
 *
 *   "MAY WE JOIN THIS WINDOW'S AUDIO?"    — the guards below: state, length, D15, service present.
 *   "MAY WE TURN THIS ROOM INTO WORDS?"   — `room.transcript_enabled`, someone's explicit choice.
 *
 * Joining audio is not transcribing it. Nothing in this file reads a transcript, calls Whisper, or
 * writes a turn, so a clip existing does not do what that switch exists to prevent.
 *
 * AND THE DEFAULT IS STILL TO LEAVE THOSE ROOMS ALONE. Someone turned each of those switches off
 * deliberately; pre-building clips for them unasked spends storage and Mini time on rooms nobody
 * has asked us to process. So the second decision is ONE PARAMETER, `includeTranscriptDisabled`,
 * and not a rebuild: when those windows are wanted it is a flag, not a fortnight. The refusal is
 * NAMED (`transcript_disabled_room`), never a silent skip, so a caller that meant to include them
 * finds out that it did not.
 *
 * The drain makes the same check absolutely, on entry, as `step: "flag_off"` (room-drain.ts §C1).
 * That is right for transcription. This path is not transcription, which is why it may be asked.
 */
import { refuseIfTooLong, roomsRecordingNow, joinServiceConfigured } from "@/lib/bench-join";
import { sql } from "@/lib/db";
import { isTranscriptEnabled } from "@/lib/room-switches";
import { joinClipForWindow, loadWindowContext } from "./room-drain";

/**
 * Only a settled, closed window. `transcribing` belongs to a live drain that is about to join it
 * itself, and racing that would produce two clips for one window and orphan one of them.
 */
export const JOIN_ONLY_STATE = "closed";

export type JoinOnlyStep =
  | "not_found"
  | "no_room_day"
  | "no_chunks"
  | "wrong_state"
  | "too_long"
  | "transcript_disabled_room"
  | "room_recording"
  | "recording_unknown"
  | "join_service_not_configured"
  | "join_failed";

export type JoinOnlyOutcome =
  /** A clip exists. `joined: false` means it already did and nothing was re-joined or re-paid for. */
  | {
      ok: true;
      window_id: string;
      clip_r2_key: string;
      joined: boolean;
      audio_seconds: number;
      grid_aligned: boolean;
      ms: number;
    }
  /** Every refusal is named and writes nothing. Counts and ids only — no room slugs, ever. */
  | { ok: false; window_id: string; step: JoinOnlyStep; detail?: string; ms: number };

/**
 * Join one window's chunks into a clip. ONE WINDOW. No loop, no batch, no bulk run.
 *
 * Idempotent: a window that already has a clip returns it and never re-joins. Re-joining would pay
 * the service again for bytes we already hold and leave the previous object referenced by nothing.
 *
 * Safe to interrupt: the only write is the clip key, and `joinClipForWindow` deletes the object if
 * that write fails. There is no half-state to resume from — a re-run either skips or joins cleanly.
 */
export async function joinOnlyWindow(
  windowId: string,
  opts: { includeTranscriptDisabled?: boolean; now?: Date } = {},
): Promise<JoinOnlyOutcome> {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const no = (step: JoinOnlyStep, detail?: string): JoinOnlyOutcome => ({
    ok: false, window_id: windowId, step, ...(detail ? { detail } : {}), ms: ms(),
  });

  const ctx = await loadWindowContext(windowId);
  if ("error" in ctx) {
    const step: JoinOnlyStep =
      ctx.error === "not_found" || ctx.error === "no_room_day" || ctx.error === "no_chunks"
        ? ctx.error
        : "wrong_state";
    return no(step, ctx.detail);
  }
  const { w, startMs, endMs, source, covering, audioSeconds } = ctx;

  // 1. ALREADY DONE. The cheapest guard there is, so it is asked first — before the switch read,
  //    before the recording check, before anything that costs a round trip.
  if (w.clip_r2_key) {
    return {
      ok: true, window_id: windowId, clip_r2_key: w.clip_r2_key, joined: false,
      audio_seconds: audioSeconds, grid_aligned: Boolean(w.grid_aligned), ms: ms(),
    };
  }

  // 2. SETTLED AND CLOSED, or not ours to touch.
  if (w.state !== JOIN_ONLY_STATE) return no("wrong_state", w.state);

  // 3. THE TRANSCRIPT SWITCH — read here and nowhere else in this file, the one room-policy
  //    question, kept apart from every audio question around it.
  if (!opts.includeTranscriptDisabled && !(await isTranscriptEnabled(w.room_id))) {
    return no("transcript_disabled_room", "pass includeTranscriptDisabled to target it deliberately");
  }

  // 4. D2 — the joining service's own thirty-minute cap, asked with its function, not a copy of it.
  const tooLong = refuseIfTooLong(startMs, endMs);
  if (tooLong) return no("too_long", `${tooLong.requested_minutes}m>${tooLong.limit_minutes}m`);

  if (!joinServiceConfigured()) return no("join_service_not_configured");

  // 5. D15 — NEVER COMPETE WITH A LIVE TAPE. This is a client-side guard, not a refusal the
  //    service issues: `callJoinService` would join happily mid-clinic. Only the MCP listen-back
  //    tool asks it today; the drain does not. A backlog run is precisely the heavy, deferrable
  //    work D15 exists to keep off a recording Mini, so it asks.
  //
  //    BACKING OFF IS RETURNING. There is no retry loop here and there must not be one: the caller
  //    stops for the day, and the window is still there tomorrow.
  const recording = await roomsRecordingNow(opts.now ?? new Date());
  if (!recording.known) {
    // The bus could not be read, so we cannot prove nothing is recording. The MCP tool proceeds
    // and carries the reason, because a clinician asking to listen back is waiting. Nothing waits
    // on a backlog, so it holds instead. FAIL-SAFE BY CHOICE — flagged in the handoff.
    return no("recording_unknown", recording.reason.slice(0, 120));
  }
  // COUNT ONLY. The check knows room slugs; a backfill log must not.
  if (recording.rooms.length > 0) return no("room_recording", `${recording.rooms.length} recording`);

  // 6. THE SEAM — the drain's own join step, not a second copy of it.
  const join = await joinClipForWindow({ windowId, sessionId: w.session_id, covering, startMs, endMs, source });
  if (!join.ok) return no("join_failed", `${join.error}${join.hop ? ` @${join.hop}` : ""}`.slice(0, 160));

  return {
    ok: true, window_id: windowId, clip_r2_key: join.key, joined: true,
    audio_seconds: audioSeconds, grid_aligned: Boolean(w.grid_aligned), ms: ms(),
  };
}

/**
 * Closed windows with no clip, oldest first, for an operator choosing a handful.
 *
 * READ ONLY, and it takes the same decision the joiner takes: transcript-disabled rooms are left
 * out unless asked for. A listing that quietly included them would invite a run that quietly
 * processed them. Ids and counts only — no slugs, no names.
 */
export async function listCliplessWindows(opts: {
  limit: number;
  includeTranscriptDisabled?: boolean;
}): Promise<Array<{ window_id: string; transcript_enabled: boolean }>> {
  const include = opts.includeTranscriptDisabled === true;
  const limit = Math.max(1, Math.min(200, Math.trunc(opts.limit)));
  return (await sql`
    SELECT w.id AS window_id, r.transcript_enabled
      FROM bench_window w
      JOIN bench_session s ON s.id = w.session_id
      JOIN room r ON r.id = s.room_id
     WHERE w.clip_r2_key IS NULL
       AND w.state = ${JOIN_ONLY_STATE}
       AND w.room_day_id IS NOT NULL
       AND (${include} OR r.transcript_enabled = TRUE)
     ORDER BY w.start_ms ASC
     LIMIT ${limit}
  `) as Array<{ window_id: string; transcript_enabled: boolean }>;
}
