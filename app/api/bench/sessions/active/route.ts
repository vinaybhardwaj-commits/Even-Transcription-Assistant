/**
 * /api/bench/sessions/active — Room Bench remount resume (ETA-REMOUNT-RESUME PRD v1.0 §4;
 * MCP PRD §8.5 rev 3e).
 *
 * GET — the resume test. ROOM COOKIE (same guard as /api/bench/chunks; never the admin
 * guard — D1: the cookie is the only proof of ownership the kiosk needs). Reads the room's
 * newest non-ended session with the newest chunk time and highest chunk number per stream,
 * then asks lib/bench-resume-core's decideResume (which imports the reaper's own window —
 * no second clock).
 *
 *   resumable     → { ok, resumable:true, session:{ id, status, started_at, last_any_chunk_at },
 *                     next_idx:{ primary, backup }, reason:null }
 *   not resumable → { ok, resumable:false, session:null, next_idx:null,
 *                     reason: none | stalled | previous_day | ended | lookup_failed }
 *
 * next_idx = highest stored chunk number + 1 per stream; a stream with no chunk returns 0
 * (§3.3 — the table is unique on session/source/idx and the upload route overwrites on
 * conflict, so a resume must never count from zero).
 *
 * FAIL SAFE: the whole handler is wrapped. Never a throw, never a 500 — any fault answers
 * resumable:false with reason "lookup_failed" and the kiosk shows the start screen (today's
 * behaviour, which loses nothing that is not already lost).
 *
 * FU2 (addendum 2) + S3-1 (addendum 3, proof of life): GET also answers `handover_pending` —
 * true only when BOTH hold: the bench_listener row carries a DIFFERENT live tab (last poll
 * within the command bus's own LISTENER_FRESH_MS) AND that listener's recording_session_id
 * equals the session being rejoined (a tab that polls but holds no session cannot block
 * anybody). S4-2: `tab_gone` — the tab named in the listener row wrote a kiosk_tab_gone
 * beacon (newest event, EXACT tab_id match): the ordinary reload's fast path, start at once,
 * no probe. With `since` (ISO) the GET also answers `handover_started` / `handover_complete`
 * — whether those events exist for the session at or after that time; a not-gone tab is
 * probed for the announce (HANDOVER_PROBE_MS, one hidden poll round + margin) before the
 * ACK_WAIT_MS wait, so a crashed tab costs one bounded probe, never the full window.
 * Everything fails safe to "no wait".
 *
 * POST — the kiosk's four remount event rows: 'kiosk_tab_gone' (S4-1, the pagehide beacon —
 * reload, navigation, close all mean this tab hands nothing over), 'kiosk_handover_started'
 * (S3-1a, the losing tab's proof of life, before its flush), 'kiosk_handover_complete'
 * (FU2b, after its last segment is uploaded), and 'kiosk_remount_resumed' (§3.4 gap record,
 * after a successful rejoin; payload may carry handover_timed_out). They live HERE (not
 * POST /api/bench/events)
 * for two ratified reasons: that route whitelists kinds via locked lib/bench-dual.ts, and it
 * forwards a best-effort cue to the brain — a remount must not reach the brain as a live
 * cue. brain_status is 'none' (FU1a): no brain hop is ever attempted, and 'failed' means
 * "attempted, not yet succeeded" everywhere else. The kind set in the table is open (0043),
 * no migration.
 *
 * SQL — INFERRED against 0041 / 0043 / 0045 (no live DB in the sandbox).
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { respondOk, respondError } from "@/lib/respond";
import { readRoomClaims } from "@/lib/room-auth";
import { newEventId } from "@/lib/bench";
import { newestChunkMs } from "@/lib/bench-reaper-core";
import { getListener } from "@/lib/bench-commands";
import {
  decideHandoverPending,
  decideResume,
  hasHandoverEventSince,
  isListenerTabGone,
  nextIdxFromMax,
  type BenchResumeCandidate,
  type ResumeReason,
} from "@/lib/bench-resume-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ActiveRow = BenchResumeCandidate & {
  max_primary_idx?: number | string | null;
  max_backup_idx?: number | string | null;
};

const notResumable = (reason: ResumeReason | "lookup_failed") =>
  respondOk({
    ok: true,
    resumable: false,
    session: null,
    next_idx: null,
    reason,
    handover_pending: false,
    tab_gone: false,
    handover_started: null,
    handover_complete: null,
  });

export async function GET(req: NextRequest) {
  try {
    const claims = await readRoomClaims();
    if (!claims) return respondError("AUTH_REQUIRED", "Room sign-in required");

    const sp = req.nextUrl.searchParams;
    const rawTabId = sp.get("tab_id");
    const callerTabId = rawTabId && rawTabId.length <= 64 ? rawTabId : null;
    const rawSince = sp.get("since");
    const sinceMs = rawSince ? Date.parse(rawSince) : NaN;

    const rows = (await sql`
      SELECT s.id, s.status, s.started_at,
             MAX(c.created_at) FILTER (WHERE c.source = 'primary') AS last_primary_at,
             MAX(c.created_at) FILTER (WHERE c.source = 'backup')  AS last_backup_at,
             MAX(c.idx)        FILTER (WHERE c.source = 'primary') AS max_primary_idx,
             MAX(c.idx)        FILTER (WHERE c.source = 'backup')  AS max_backup_idx
        FROM bench_session s
        LEFT JOIN bench_chunk c ON c.session_id = s.id
       WHERE s.room_id = ${claims.room_id} AND s.status <> 'ended'
       GROUP BY s.id, s.status, s.started_at
       ORDER BY s.started_at DESC
       LIMIT 1
    `) as ActiveRow[];
    const row = rows?.[0] ?? null;

    const decision = decideResume(row, Date.now());
    if (!row || !decision.resumable) {
      return notResumable(decision.reason === "ok" ? "none" : decision.reason);
    }

    // FU2a + S3-1b — is a LIVE different tab holding THIS session? (A tab that polls but
    // holds no session, or another one, cannot block anybody.) Fail-safe false: bus not
    // migrated (0044) or bus down means no wait, which is the pre-handover behaviour.
    // S4-2 — tab_gone: the tab named in the listener row announced its own death via the
    // pagehide beacon (newest kiosk_tab_gone event, EXACT tab_id match, no time test).
    // True = the ordinary reload: the caller starts at once, no probe. Fail-safe false:
    // the caller then probes, which is bounded.
    let handoverPending = false;
    let tabGone = false;
    try {
      const listener = await getListener(claims.room_id);
      handoverPending = decideHandoverPending(listener, callerTabId, row.id, Date.now());
      if (listener?.tab_id) {
        const gone = (await sql`
          SELECT payload FROM bench_event
           WHERE session_id = ${row.id} AND kind = 'kiosk_tab_gone'
           ORDER BY at DESC
           LIMIT 1
        `) as Array<{ payload: unknown }>;
        tabGone = isListenerTabGone(gone?.[0]?.payload ?? null, listener.tab_id);
      }
    } catch {
      handoverPending = false;
      tabGone = false;
    }

    // FU2d + S3-1c — has the displaced tab announced (started) and finished (complete)?
    // Only asked when the caller passes `since`. Fail-safe false on either: the waiting
    // tab then falls through the probe or the ack window and starts anyway (bounded).
    let handoverStarted: boolean | null = null;
    let handoverComplete: boolean | null = null;
    if (Number.isFinite(sinceMs)) {
      handoverStarted = false;
      handoverComplete = false;
      try {
        const ev = (await sql`
          SELECT kind, MAX(at) AS at
            FROM bench_event
           WHERE session_id = ${row.id}
             AND kind IN ('kiosk_handover_started', 'kiosk_handover_complete')
           GROUP BY kind
        `) as Array<{ kind: string; at: string | Date }>;
        for (const e of ev ?? []) {
          if (e.kind === "kiosk_handover_started") handoverStarted = hasHandoverEventSince(e.at, sinceMs);
          if (e.kind === "kiosk_handover_complete") handoverComplete = hasHandoverEventSince(e.at, sinceMs);
        }
      } catch {
        handoverStarted = false;
        handoverComplete = false;
      }
    }

    const lastAny = newestChunkMs(row);
    return respondOk({
      ok: true,
      resumable: true,
      session: {
        id: row.id,
        status: row.status,
        started_at: new Date(row.started_at as string).toISOString(),
        last_any_chunk_at: lastAny !== null ? new Date(lastAny).toISOString() : null,
      },
      next_idx: {
        primary: nextIdxFromMax(row.max_primary_idx),
        backup: nextIdxFromMax(row.max_backup_idx),
      },
      reason: null,
      handover_pending: handoverPending,
      tab_gone: tabGone,
      handover_started: handoverStarted,
      handover_complete: handoverComplete,
    });
  } catch (e) {
    // Fail safe (§4): a fault degrades to the start screen, never a 500.
    console.warn("[bench-resume] lookup failed", String((e as Error)?.message ?? e).slice(0, 200));
    return notResumable("lookup_failed");
  }
}

const MAX_IDX = 1_000_000;

export async function POST(req: NextRequest) {
  try {
    const claims = await readRoomClaims();
    if (!claims) return respondError("AUTH_REQUIRED", "Room sign-in required");

    let body: {
      kind?: unknown;
      session_id?: unknown;
      silence_seconds?: unknown;
      next_idx?: { primary?: unknown; backup?: unknown } | null;
      handover_timed_out?: unknown;
      last_idx?: { primary?: unknown; backup?: unknown } | null;
      tab_id?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return respondError("VALIDATION_FAILED", "body_not_json");
    }
    // Four kiosk-remount kinds only; absent = the original remount body (pre-FU2 kiosks).
    const kind =
      body.kind === undefined || body.kind === "kiosk_remount_resumed"
        ? ("kiosk_remount_resumed" as const)
        : body.kind === "kiosk_handover_complete"
          ? ("kiosk_handover_complete" as const)
          : body.kind === "kiosk_handover_started"
            ? ("kiosk_handover_started" as const)
            : body.kind === "kiosk_tab_gone"
              ? ("kiosk_tab_gone" as const)
              : null;
    if (!kind) return respondError("VALIDATION_FAILED", "kind_not_allowed");

    const sessionId = typeof body.session_id === "string" ? body.session_id : "";
    if (!sessionId.startsWith("bs_")) {
      return respondError("VALIDATION_FAILED", "resume_event_fields_required");
    }
    const idxOf = (v: unknown, min: number): number | null =>
      typeof v === "number" && Number.isInteger(v) && v >= min && v <= MAX_IDX ? v : null;

    let payload: Record<string, unknown>;
    if (kind === "kiosk_remount_resumed") {
      const silenceSeconds =
        typeof body.silence_seconds === "number" && Number.isFinite(body.silence_seconds)
          ? Math.max(0, Math.round(body.silence_seconds))
          : null;
      const primaryIdx = idxOf(body.next_idx?.primary, 0);
      const backupIdx = idxOf(body.next_idx?.backup, 0);
      if (silenceSeconds === null || primaryIdx === null || backupIdx === null) {
        return respondError("VALIDATION_FAILED", "resume_event_fields_required");
      }
      payload = {
        source: "kiosk",
        session_id: sessionId,
        silence_seconds: silenceSeconds,
        next_idx: { primary: primaryIdx, backup: backupIdx },
        ...(body.handover_timed_out === true ? { handover_timed_out: true } : {}),
      };
    } else if (kind === "kiosk_handover_complete") {
      // FU2b: the last number the losing tab used per stream (-1 = the stream never
      // produced a chunk in that tab's life).
      const lastPrimary = idxOf(body.last_idx?.primary, -1);
      const lastBackup = idxOf(body.last_idx?.backup, -1);
      if (lastPrimary === null || lastBackup === null) {
        return respondError("VALIDATION_FAILED", "handover_event_fields_required");
      }
      payload = {
        source: "kiosk",
        session_id: sessionId,
        last_idx: { primary: lastPrimary, backup: lastBackup },
      };
    } else if (kind === "kiosk_handover_started") {
      // S3-1a: the proof of life, written before the flush.
      payload = { source: "kiosk", session_id: sessionId };
    } else {
      // kiosk_tab_gone (S4-1): the pagehide beacon — this tab will not be handing anything
      // over. The tab_id is what GET's tab_gone exact-matches against the listener row.
      const tabId = typeof body.tab_id === "string" && body.tab_id.length > 0 && body.tab_id.length <= 64 ? body.tab_id : null;
      if (!tabId) return respondError("VALIDATION_FAILED", "tab_gone_fields_required");
      payload = { source: "kiosk", session_id: sessionId, tab_id: tabId };
    }

    // The session must belong to the cookie's room and still be open.
    const owned = (await sql`
      SELECT id FROM bench_session
       WHERE id = ${sessionId} AND room_id = ${claims.room_id} AND status <> 'ended'
       LIMIT 1
    `) as Array<{ id: string }>;
    if (!owned[0]) return respondError("NOT_FOUND", "session_not_found");

    const eventId = newEventId();
    // brain_status 'none' (FU1a): no brain hop is ever attempted for these rows — 'failed'
    // is every other writer's "attempted, not yet succeeded" and would read as a lie.
    await sql`
      INSERT INTO bench_event (id, session_id, kind, at, brain_status, payload)
      VALUES (${eventId}, ${sessionId}, ${kind}, ${new Date().toISOString()}, 'none', ${JSON.stringify(payload)}::jsonb)
    `;
    console.info("[bench-resume]", JSON.stringify({ event_id: eventId, kind, ...payload }));
    return respondOk({ ok: true, event_id: eventId });
  } catch (e) {
    // Same fail-safe posture: the rejoin already happened; a lost gap record must not 500.
    console.warn("[bench-resume] event write failed", String((e as Error)?.message ?? e).slice(0, 200));
    return respondOk({ ok: false, error: "event_write_failed" });
  }
}
