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
 * POST — the §3.4 gap record: one durable bench_event row, kind 'kiosk_remount_resumed',
 * written by the kiosk after a successful rejoin. It lives HERE (not POST /api/bench/events)
 * because that route validates kind against BENCH_EVENT_KINDS in lib/bench-dual.ts and both
 * files are outside this build's file contract — flagged in the build report. Same durable
 * shape as the events route (brain_status 'failed' = provisional, no brain hop is attempted);
 * the kind set in the table is open (0043), no migration.
 *
 * SQL — INFERRED against 0041 / 0043 / 0045 (no live DB in the sandbox).
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { respondOk, respondError } from "@/lib/respond";
import { readRoomClaims } from "@/lib/room-auth";
import { newEventId } from "@/lib/bench";
import { newestChunkMs } from "@/lib/bench-reaper-core";
import { decideResume, type BenchResumeCandidate, type ResumeReason } from "@/lib/bench-resume-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ActiveRow = BenchResumeCandidate & {
  max_primary_idx?: number | string | null;
  max_backup_idx?: number | string | null;
};

const notResumable = (reason: ResumeReason | "lookup_failed") =>
  respondOk({ ok: true, resumable: false, session: null, next_idx: null, reason });

/** Highest stored number + 1; a stream with no chunk starts at 0 (§3.3). */
function nextIdx(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) + 1 : 0;
}

export async function GET() {
  try {
    const claims = await readRoomClaims();
    if (!claims) return respondError("AUTH_REQUIRED", "Room sign-in required");

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
      next_idx: { primary: nextIdx(row.max_primary_idx), backup: nextIdx(row.max_backup_idx) },
      reason: null,
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
      session_id?: unknown;
      silence_seconds?: unknown;
      next_idx?: { primary?: unknown; backup?: unknown } | null;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return respondError("VALIDATION_FAILED", "body_not_json");
    }
    const sessionId = typeof body.session_id === "string" ? body.session_id : "";
    const silenceSeconds =
      typeof body.silence_seconds === "number" && Number.isFinite(body.silence_seconds)
        ? Math.max(0, Math.round(body.silence_seconds))
        : null;
    const idxOf = (v: unknown): number | null =>
      typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_IDX ? v : null;
    const primaryIdx = idxOf(body.next_idx?.primary);
    const backupIdx = idxOf(body.next_idx?.backup);
    if (!sessionId.startsWith("bs_") || silenceSeconds === null || primaryIdx === null || backupIdx === null) {
      return respondError("VALIDATION_FAILED", "resume_event_fields_required");
    }

    // The session must belong to the cookie's room and still be open.
    const owned = (await sql`
      SELECT id FROM bench_session
       WHERE id = ${sessionId} AND room_id = ${claims.room_id} AND status <> 'ended'
       LIMIT 1
    `) as Array<{ id: string }>;
    if (!owned[0]) return respondError("NOT_FOUND", "session_not_found");

    const eventId = newEventId();
    const payload = {
      source: "kiosk",
      session_id: sessionId,
      silence_seconds: silenceSeconds,
      next_idx: { primary: primaryIdx, backup: backupIdx },
    };
    await sql`
      INSERT INTO bench_event (id, session_id, kind, at, brain_status, payload)
      VALUES (${eventId}, ${sessionId}, 'kiosk_remount_resumed', ${new Date().toISOString()}, 'failed', ${JSON.stringify(payload)}::jsonb)
    `;
    console.info("[bench-resume]", JSON.stringify({ event_id: eventId, ...payload }));
    return respondOk({ ok: true, event_id: eventId });
  } catch (e) {
    // Same fail-safe posture: the rejoin already happened; a lost gap record must not 500.
    console.warn("[bench-resume] event write failed", String((e as Error)?.message ?? e).slice(0, 200));
    return respondOk({ ok: false, error: "event_write_failed" });
  }
}
