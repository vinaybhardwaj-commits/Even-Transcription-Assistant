/**
 * lib/bench-orphan.ts — closing a session the kiosk abandoned (K5 Part A).
 *
 * ─── THE DEADLOCK THIS EXISTS FOR ────────────────────────────────────────────────────────
 *
 * Observed on the Home Office rig, 22 August. A backgrounded kiosk tab was throttled until it
 * died mid-recording. The room then could not be recovered by ANY operator action:
 *
 *   end_day   is a NO-OP. The kiosk ends its OWN session — endDayFlow flushes, then
 *             patchSession("end") against the sessionId held in that tab's state. The tab that
 *             owned the session was gone; its replacement signed in fresh with
 *             recording_session_id null, so it had no session to end. The command queues, the
 *             kiosk consumes it, and nothing happens.
 *   start_day is REFUSED. decideStart returns already_recording for any session whose status
 *             is not 'ended' — and the abandoned one qualifies.
 *
 * So the room sat unrecordable until reapBenchSessions fired. STALL_MINUTES is 30, and the
 * reaper keys on the chunk's created_at (UPLOAD time, not ended_at), so a late flush pushes
 * that out further still — the real orphan was ~40 minutes from reapable, not 30.
 *
 * On a clinic day that is half an hour of a room that cannot be recorded, with nothing an
 * operator can do but wait. This module is the hand to pull.
 *
 * ─── WHAT IT IS NOT ──────────────────────────────────────────────────────────────────────
 *
 * NOT AUTOMATIC, and not on a cron. The reaper stays exactly as it was and remains the
 * backstop; this adds a door, not a shorter fuse. STALL_MINUTES is untouched.
 *
 * NOT A SECOND WAY TO STOP A RECORDING. If a kiosk is attached to the session and its listener
 * is fresh, this REFUSES by name (kiosk_attached) and changes nothing. The normal end_day path
 * owns a live room. That refusal is the whole reason this is safe to put on a room card.
 *
 * NOT DESTRUCTIVE TO AUDIO. It sets status and ended_at on ONE row. It never touches
 * bench_chunk — every chunk, primary and backup, verified and pending, is exactly as it was.
 * The tape stays; only the claim that a kiosk is still writing to it is withdrawn.
 */

import { sql } from "@/lib/db";
import { isListening, type ListenerRow } from "@/lib/bench-commands";
import { LISTENER_FRESH_MS } from "@/lib/bench-bus-constants";

/**
 * A2 — the repair's name on the wire, for both doors (the admin route and the MCP tool).
 *
 * Chosen to read as a REPAIR, not as a stop. It is deliberately NOT added to COMMAND_KINDS:
 * that list is the kiosk's vocabulary and pollCommands hands those to a browser, whereas this
 * one exists precisely because no browser is there to execute it.
 */
export const CLOSE_ORPHAN_KIND = "close_orphan" as const;

/** Why the close was refused. Named, never a boolean — the operator has to know which. */
export type OrphanRefusal = "no_open_session" | "kiosk_attached";

/**
 * The listener state AT THE MOMENT OF THE DECISION, recorded on the audit row.
 *
 * This is the evidence that the kiosk was gone. Without it the audit says only that somebody
 * ended a clinical recording by hand; with it, it says why that was the right call and what
 * the system could see when it was made.
 */
export type ListenerEvidence = {
  present: boolean;
  tab_id: string | null;
  last_poll_at: string | null;
  age_ms: number | null;
  listening: boolean;
  claims_session_id: string | null;
  /** which of the three orphan conditions held */
  reason: "no_listener_row" | "listener_stale" | "claims_nothing" | "claims_other_session" | null;
  fresh_window_ms: number;
};

export type OrphanDecision =
  | { action: "close"; session_id: string; evidence: ListenerEvidence }
  | { action: "refuse"; error: OrphanRefusal; session_id: string | null; evidence: ListenerEvidence };

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

/**
 * PURE. Is this session orphaned, and what did the listener look like when we asked?
 *
 * A session is orphaned when it is not 'ended' AND no kiosk currently claims it. "Claims it"
 * is three separate failures, kept separate because they mean different things to an operator:
 *
 *   no_listener_row       no kiosk has ever polled this room
 *   listener_stale        a kiosk polled, but longer than LISTENER_FRESH_MS ago — it is gone
 *   claims_nothing        a kiosk is polling and says it is recording NOTHING (the exact shape
 *                         of the 22 August failure: replacement tab, fresh sign-in, null)
 *   claims_other_session  a kiosk is polling and is on a DIFFERENT session — this one was left
 *                         behind by a handover that did not finish
 */
export function decideOrphanClose(input: {
  listener: ListenerRow | null;
  session: { id: string; status: string } | null;
  now?: Date;
}): OrphanDecision {
  const now = input.now ?? new Date();
  const l = input.listener;
  const fresh = isListening(l, now);
  const age = l ? now.getTime() - new Date(l.last_poll_at).getTime() : null;

  const base = {
    present: Boolean(l),
    tab_id: l?.tab_id ?? null,
    last_poll_at: l ? iso(l.last_poll_at) : null,
    age_ms: age,
    listening: fresh,
    claims_session_id: l?.recording_session_id ?? null,
    fresh_window_ms: LISTENER_FRESH_MS,
  };

  const s = input.session;
  if (!s || s.status === "ended") {
    return { action: "refuse", error: "no_open_session", session_id: s?.id ?? null, evidence: { ...base, reason: null } };
  }

  // A4 — a kiosk that is BOTH fresh AND on this very session owns it. Hands off.
  if (l && fresh && l.recording_session_id === s.id) {
    return { action: "refuse", error: "kiosk_attached", session_id: s.id, evidence: { ...base, reason: null } };
  }

  const reason: ListenerEvidence["reason"] = !l
    ? "no_listener_row"
    : !fresh
      ? "listener_stale"
      : l.recording_session_id === null
        ? "claims_nothing"
        : "claims_other_session";

  return { action: "close", session_id: s.id, evidence: { ...base, reason } };
}

export type OrphanCloseResult =
  | { ok: true; session_id: string; room_id: string; ended_at: string; chunks_before: number; chunks_after: number; evidence: ListenerEvidence }
  | { ok: false; error: OrphanRefusal | "db_error"; session_id: string | null; detail?: string; evidence?: ListenerEvidence };

/**
 * Close it. Reads the listener and the room's open session, decides, and on a close writes
 * exactly one UPDATE plus one audit row.
 *
 * The chunk count is read BEFORE and AFTER and both are returned — not because the UPDATE
 * could plausibly touch bench_chunk, but because "the audio is untouched" is the claim an
 * operator is being asked to trust when they press this, and a claim you can check beats a
 * claim you have to believe.
 */
export async function closeOrphanedSession(input: {
  roomId: string;
  actorType: "admin" | "system";
  actorId: string;
  now?: Date;
}): Promise<OrphanCloseResult> {
  const now = input.now ?? new Date();
  let listener: ListenerRow | null = null;
  let session: { id: string; status: string } | null = null;
  let chunksBefore = 0;

  try {
    const lrows = (await sql`
      SELECT room_id, tab_id, last_poll_at, recording_session_id, paused
        FROM bench_listener WHERE room_id = ${input.roomId} LIMIT 1
    `) as ListenerRow[];
    listener = lrows[0] ?? null;

    const srows = (await sql`
      SELECT id, status FROM bench_session
       WHERE room_id = ${input.roomId} AND status <> 'ended'
       ORDER BY started_at DESC LIMIT 1
    `) as Array<{ id: string; status: string }>;
    session = srows[0] ?? null;

    if (session) {
      const c = (await sql`SELECT COUNT(*)::int AS n FROM bench_chunk WHERE session_id = ${session.id}`) as Array<{ n: number }>;
      chunksBefore = c[0]?.n ?? 0;
    }
  } catch (e) {
    return { ok: false, error: "db_error", session_id: null, detail: String((e as Error)?.message ?? e).slice(0, 200) };
  }

  const decision = decideOrphanClose({ listener, session, now });
  if (decision.action === "refuse") {
    return { ok: false, error: decision.error, session_id: decision.session_id, evidence: decision.evidence };
  }

  try {
    // `AND status <> 'ended'` makes this safe to run twice: a second press finds nothing to do
    // rather than rewriting ended_at. bench_chunk is not named anywhere in this statement.
    // §3.3 / Build 2 §2.5 — THE SAME RULE AS THE NORMAL END PATH, and it matters more here.
    // This closes a session whose kiosk vanished, so the gap between the last piece and the
    // moment somebody presses the repair button is not seconds but hours. `NOW()` would have
    // recorded an end time hours after the audio stopped — exactly the class of wrong row §2.5
    // exists to stop creating. Verified pieces only; NOW() only when there is no tape to read.
    const updated = (await sql`
      UPDATE bench_session s
         SET status = 'ended',
             ended_at = COALESCE(
               (SELECT MAX(c.ended_at) FROM bench_chunk c
                 WHERE c.session_id = s.id AND c.upload_state = 'verified'),
               NOW()
             )
       WHERE s.id = ${decision.session_id} AND s.status <> 'ended'
       RETURNING s.id, s.ended_at
    `) as Array<{ id: string; ended_at: string | Date }>;
    if (updated.length === 0) {
      return { ok: false, error: "no_open_session", session_id: decision.session_id, evidence: decision.evidence };
    }
    const endedAt = new Date(updated[0]!.ended_at).toISOString();

    const c2 = (await sql`SELECT COUNT(*)::int AS n FROM bench_chunk WHERE session_id = ${decision.session_id}`) as Array<{ n: number }>;
    const chunksAfter = c2[0]?.n ?? 0;

    // A3 — attributable. The session, the room, who, and what the system could SEE about the
    // kiosk at the moment the call was made.
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES (${input.actorType}, ${input.actorId}, 'bench.close_orphaned_session', 'bench_session', ${decision.session_id},
              ${JSON.stringify({
                room_id: input.roomId,
                ended_at: endedAt,
                chunks_before: chunksBefore,
                chunks_after: chunksAfter,
                chunks_preserved: chunksBefore === chunksAfter,
                listener_evidence: decision.evidence,
              })}::jsonb)
    `.catch(() => { /* intentional: best-effort audit, never fails the repair */ });

    return {
      ok: true,
      session_id: decision.session_id,
      room_id: input.roomId,
      ended_at: endedAt,
      chunks_before: chunksBefore,
      chunks_after: chunksAfter,
      evidence: decision.evidence,
    };
  } catch (e) {
    return { ok: false, error: "db_error", session_id: decision.session_id, detail: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
