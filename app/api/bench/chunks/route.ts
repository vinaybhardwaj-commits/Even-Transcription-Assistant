/**
 * POST /api/bench/chunks — record a VERIFIED bench chunk row (Room-Bench
 * PRD §3.4, D8). Room-cookie gated; session must belong to the room.
 *
 * The client calls this after its own HEAD-verify, but the server does NOT
 * trust it: it re-verifies against R2 (headObject: existence + size match)
 * before writing upload_state='verified'. On any mismatch the row is not
 * written and the client keeps its local copy and retries — never wrong
 * data. Idempotent: retries hit ON CONFLICT (session_id, idx).
 *
 * Body: { session_id, idx, content_type, started_at, ended_at,
 *         duration_ms, size_bytes, gap_before_ms, source? }
 * source (K-B, 0045): 'primary' (default — absent = today's behaviour) | 'backup'.
 * Uniqueness is (session_id, source, idx).
 *
 * K4a: on success this ALSO schedules a bench_window evaluation in an after() hook. Nothing
 * about the request path changes — no extra query runs before the response — and the window
 * write is derived from chunk rows that are already committed by the time it runs.
 *
 * ── ENDED DISAGREES (23 Aug 2026) ───────────────────────────────────────────────────────────
 *
 * A chunk can arrive for a session whose row says 'ended'. bs_g3dwud4p is the case: the
 * day-rollover reaper stamped ended_at at 19:00:36, THE KIOSK WAS NEVER TOLD, and the tab — which
 * never reloaded, and held the session id in its own memory — carried on writing chunks until
 * 00:58:46. All 108 are present and verified.
 *
 * THE CHUNK IS ALWAYS ACCEPTED. Never refuse audio because a row says the session is over: those
 * 108 chunks are exactly why. Refusing would have converted a bookkeeping fault into six hours of
 * lost recording, which is a far worse failure than the one being fixed.
 *
 * What changes is that the disagreement is now (a) written once to bench_event, so it is in the
 * timeline and not only in a log, and (b) RETURNED TO THE KIOSK. The chunk upload is the only
 * channel that reaches a tab which is not reloading, and the kiosk is already talking to us on
 * every chunk — so this needs no command bus. A reload was already safe (decideResume rejects an
 * ended session); a tab that never reloads was not, and that is what this closes.
 *
 * Neither addition touches the request path. The status is read off the session row this route
 * already loads, and the event write goes in the same after() hook as the window evaluation.
 */
import { NextRequest, after } from "next/server";
import { sql } from "@/lib/db";
import { respondOk, respondError } from "@/lib/respond";
import { readRoomClaims } from "@/lib/room-auth";
import { findBenchSession, newChunkId, newEventId, ymdUtc } from "@/lib/bench";
import { headObject, benchChunkKey } from "@/lib/r2";
import { evaluateAndWriteWindows, istDateOf } from "@/lib/bench-window";
import { ensureRoomDayOpen } from "@/lib/brain/open-day";
import { ENDED_DISAGREES, CHUNK_DISAGREEMENT_FIELD, chunkDisagreesWithEnd } from "@/lib/bench-bus-constants";
import { parseMicLevelPair } from "@/lib/bench-levels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const claims = await readRoomClaims();
  if (!claims) return respondError("AUTH_REQUIRED", "Room sign-in required");

  let body: {
    session_id?: unknown;
    idx?: unknown;
    content_type?: unknown;
    started_at?: unknown;
    ended_at?: unknown;
    duration_ms?: unknown;
    size_bytes?: unknown;
    peak_level?: unknown;
    avg_level?: unknown;
    gap_before_ms?: unknown;
    source?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }

  const sessionId = typeof body.session_id === "string" ? body.session_id : "";
  const idx = typeof body.idx === "number" && Number.isInteger(body.idx) ? body.idx : -1;
  const contentType =
    typeof body.content_type === "string" && body.content_type
      ? body.content_type.slice(0, 100)
      : "audio/webm";
  const startedAt = typeof body.started_at === "string" ? new Date(body.started_at) : null;
  const endedAt = typeof body.ended_at === "string" ? new Date(body.ended_at) : null;
  const durationMs =
    typeof body.duration_ms === "number" && body.duration_ms >= 0
      ? Math.round(body.duration_ms)
      : null;
  const sizeBytes =
    typeof body.size_bytes === "number" && body.size_bytes >= 0
      ? Math.round(body.size_bytes)
      : null;
  const gapBeforeMs =
    typeof body.gap_before_ms === "number" && body.gap_before_ms >= 0
      ? Math.round(body.gap_before_ms)
      : 0;

  if (
    !sessionId.startsWith("bs_") ||
    idx < 0 ||
    idx > 99_999 ||
    !startedAt ||
    isNaN(startedAt.getTime()) ||
    !endedAt ||
    isNaN(endedAt.getTime()) ||
    durationMs === null ||
    sizeBytes === null
  ) {
    return respondError("VALIDATION_FAILED", "chunk_fields_required");
  }
  if (body.source !== undefined && body.source !== "primary" && body.source !== "backup") {
    return respondError("VALIDATION_FAILED", "bad_source");
  }
  const source: "primary" | "backup" = body.source === "backup" ? "backup" : "primary";
  // D36 — what the meter heard during this piece. OPTIONAL, and its absence is not an error: an
  // older kiosk sends nothing and every piece recorded before Build 2 has nothing. Out-of-range
  // values are DROPPED rather than clamped — RMS is 0..1 by construction, so anything else is a
  // bug upstream, and a clamped value would be indistinguishable from a real one.
  const levels = parseMicLevelPair(body.peak_level, body.avg_level);
  const peakLevel = levels?.peak ?? null;
  const avgLevel = levels?.avg ?? null;

  const session = await findBenchSession(sessionId);
  if (!session) return respondError("NOT_FOUND", "session_not_found");
  if (session.room_id !== claims.room_id) {
    return respondError("FORBIDDEN", "not_your_session");
  }

  // The disagreement, read off the row we already have. NOT a guard — nothing below branches on
  // it, and no chunk is ever refused for it. It only decides what we say afterwards.
  //
  // "Ended" ALONE IS NOT THE FAULT. The kiosk PATCHes the session to ended as soon as the
  // recorder stops and only then finishes uploading its flush, so a chunk arriving for an ended
  // session is what every normal end of day looks like. The question is whether this audio was
  // RECORDED after we said we had stopped — the capture clock, not the upload clock. See
  // chunkDisagreesWithEnd.
  const endedDisagrees = chunkDisagreesWithEnd({
    status: session.status,
    sessionEndedAt: session.ended_at,
    chunkStartedAtMs: startedAt.getTime(),
  });

  // Server-side authoritative verify (D8): the object must exist in R2 with
  // the exact claimed size before a 'verified' row is written.
  const key = benchChunkKey(
    session.room_slug,
    ymdUtc(new Date(session.started_at)),
    sessionId,
    idx,
    source,
  );
  const head = await headObject(key);
  if (head.size === null) {
    return respondError("UPSTREAM_UNAVAILABLE", "r2_object_not_found_or_unreachable");
  }
  if (head.size !== sizeBytes) {
    return respondError("VALIDATION_FAILED", `r2_size_mismatch_${head.size}_${sizeBytes}`);
  }

  const id = newChunkId();
  try {
    await sql`
      INSERT INTO bench_chunk (
        id, session_id, idx, source, r2_key, content_type, started_at, ended_at,
        duration_ms, size_bytes, upload_state, gap_before_ms, peak_level, avg_level
      ) VALUES (
        ${id}, ${sessionId}, ${idx}, ${source}, ${key}, ${contentType},
        ${startedAt.toISOString()}, ${endedAt.toISOString()},
        ${durationMs}, ${sizeBytes}, 'verified', ${gapBeforeMs}, ${peakLevel}, ${avgLevel}
      )
      ON CONFLICT (session_id, source, idx) DO UPDATE SET
        upload_state = 'verified',
        size_bytes = EXCLUDED.size_bytes,
        -- A RETRY MUST NOT ERASE WHAT THE FIRST ATTEMPT HEARD. Levels are parsed as one complete
        -- pair above, so both EXCLUDED values are present or both are NULL: complementary partial
        -- retries can never combine into a measurement that no single request reported.
        peak_level = COALESCE(EXCLUDED.peak_level, bench_chunk.peak_level),
        avg_level  = COALESCE(EXCLUDED.avg_level,  bench_chunk.avg_level)
    `;
  } catch (e) {
    return respondError("UPSTREAM_UNAVAILABLE", String(e).slice(0, 150));
  }

  // ---- K4a A4: bench_window evaluation, AFTER the response ------------------------------
  //
  // THIS IS NOT IN THE REQUEST PATH AND MUST NEVER MOVE INTO IT. Everything above decides the
  // response; `after()` runs once that response is on its way, exactly as the encounter
  // finalize path schedules its fan-out. A kiosk waiting to hear that its upload landed is on
  // the recording critical path, and this build adds not one query in front of it.
  //
  // It never throws: a window is a derived view of chunks that are already durably written,
  // so a failure here costs a re-evaluation on the next chunk, not a chunk.
  after(async () => {
    // ONE event per session, not one per chunk. A kiosk that was never told keeps uploading every
    // five minutes for hours; 108 identical rows is a log, not a timeline. First-detection is
    // decided by Postgres — ON CONFLICT DO NOTHING on 0064's partial unique index — rather than
    // by a read-then-write that two concurrent after() hooks could both pass.
    if (endedDisagrees) {
      try {
        await sql`
          INSERT INTO bench_event (id, session_id, kind, at, brain_status, payload)
          VALUES (
            ${newEventId()}, ${sessionId}, ${ENDED_DISAGREES},
            ${startedAt.toISOString()}, 'none',
            ${JSON.stringify({
              source: "server",
              detected_on: { idx, chunk_source: source },
              session_ended_at: session.ended_at ? new Date(session.ended_at).toISOString() : null,
              chunk_started_at: startedAt.toISOString(),
            })}::jsonb
          )
          ON CONFLICT DO NOTHING
        `;
        // Logged as well as written: a timeline row is for later, a log line is for now.
        console.warn(
          `[bench-chunks] ${ENDED_DISAGREES} session=${sessionId} idx=${idx} source=${source} — chunk ACCEPTED and stored; the kiosk has been told to stop`,
        );
      } catch (e) {
        // The chunk is already durably written and the kiosk already has its signal. A lost
        // timeline row must not cost anything else.
        console.warn(`[bench-chunks] ${ENDED_DISAGREES} event write failed session=${sessionId}: ${String(e).slice(0, 150)}`);
      }
    }
    // D39 (Build 3 §2.3) — THE DAY RECORD OPENS ITSELF WHEN TAPE STARTS. Keyed to THIS PIECE'S own
    // IST date, so a session that crosses midnight opens the new day with its first piece after it.
    // Done BEFORE the window evaluation so the room_day exists when the windows look it up and
    // bind to it — no mark, no key stroke, and no drain-side path (this subsumes PRD §11). It
    // never throws, and a day it fails to open is retried by the very next verified chunk.
    try {
      const opened = await ensureRoomDayOpen(session.room_id, istDateOf(startedAt.getTime()));
      if (opened.created) {
        console.log(`[bench-chunks] D39 opened room_day ${opened.room_day_id} for ${session.room_id} on ${opened.ist_date} (first tape, no mark)`);
      } else if (!opened.ok) {
        console.warn(`[bench-chunks] D39 could not open room_day for ${session.room_id} on ${opened.ist_date}: ${opened.error} — the no-day alarm will surface it; the next chunk retries`);
      }
    } catch {
      /* ensureRoomDayOpen never throws; this is belt-and-braces so a day miss never costs the window write */
    }
    try {
      await evaluateAndWriteWindows(sessionId);
    } catch {
      /* non-critical: the next chunk re-evaluates the whole session */
    }
  });

  // The upload SUCCEEDED and says so exactly as before. The extra field is about the session, not
  // about this chunk, and it is absent on every normal upload.
  return respondOk({
    ok: true,
    key,
    upload_state: "verified",
    ...(endedDisagrees ? { [CHUNK_DISAGREEMENT_FIELD]: ENDED_DISAGREES } : {}),
  });
}
