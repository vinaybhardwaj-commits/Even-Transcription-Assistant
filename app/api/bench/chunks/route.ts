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
 * (ARCH #21, 8 Oct 2026: the one exception is a session the REAPER ended — see "A REAPED SESSION TAKES
 * NO NEW CHUNK ROWS" below. Its late chunk is not registered, its audio stays in R2, and the kiosk is told.)
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
import { createHash } from "node:crypto";
import { NextRequest, after } from "next/server";
import { sql } from "@/lib/db";
import { respondOk, respondError } from "@/lib/respond";
import { readRoomClaims } from "@/lib/room-auth";
import { findBenchSession, newChunkId, newEventId, newSessionId, ymdUtc } from "@/lib/bench";
import { headObject, benchChunkKey } from "@/lib/r2";
import { evaluateAndWriteWindows, istDateOf } from "@/lib/bench-window";
import { ensureRoomDayOpen } from "@/lib/brain/open-day";
import { ENDED_DISAGREES, CHUNK_DISAGREEMENT_FIELD, chunkDisagreesWithEnd } from "@/lib/bench-bus-constants";
import { parseMicLevelPair } from "@/lib/bench-levels";
import { isReaperNote, rehomeNote, SESSION_REAPED } from "@/lib/bench-reaper-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The disagreement signal under BOTH names. The server has always sent `disagreement`; the browser
 * kiosk reads that. The native Room Recorder decodes `ended_disagrees` (BenchClient.swift
 * ChunkRegistrationResponse and its contract tests) — a key this route never sent, so the native
 * app could not learn its session was ended through the chunk reply (found 8 Oct, Arch #21).
 */
function disagreementFields(): Record<string, string> {
  return { [CHUNK_DISAGREEMENT_FIELD]: ENDED_DISAGREES, ended_disagrees: ENDED_DISAGREES };
}

/**
 * ROLLOUT FLAG (Arch #21 round 2). The new replies (`ended_disagrees`, `rehomed_after_reap`, `refused_session_reaped`) and the re-home itself are for kiosks that run the new app:
 * an OLD app stops a healthy recording on any `ended_disagrees` and retries a non-"verified" upload for ever. So they go out only when BENCH_CHUNK_REAPED_REPLIES=1; unset / anything
 * else is OFF and the route answers exactly as main does (append to the ended session, `disagreement` only, upload_state "verified"). Read per request. Flip it after every kiosk runs the new app.
 */
const reapedRepliesOn = (): boolean => process.env.BENCH_CHUNK_REAPED_REPLIES === "1";

/** Natural key of a re-home / refusal event: the same piece retried (same target, source, idx) is the same event, so a retry loop writes ONE row. */
const eventIdFor = (kind: string, sessionId: string, source: string, idx: number): string =>
  `be_${kind}_${createHash("sha1").update(`${sessionId}|${source}|${idx}`).digest("hex").slice(0, 24)}`;

/** Re-homed chunks live in a high idx band so they can never collide with another session's own 0.. numbering. */
const REHOME_IDX_BASE = 90_000;

/**
 * ARCH #21 (F3, reworked after the re-check) — where a late chunk of a REAPED session goes: ONE dedicated session per reaped session, never an
 * open one (re-check R1: two reaped sessions' idx collided inside a shared open session and a piece vanished; R2: audio landed out of time order).
 *
 *  - the home is an ENDED session of the room whose notes are exactly "re-homed after reap of <old id>" (so no phantom Recording chip), created on
 *    the first late chunk and reused by every later one;
 *  - CREATE-OR-GET IS SERIALISED PER REAPED SESSION (R4): one transaction takes pg_advisory_xact_lock(hashtext('rehome:<old id>')), inserts the
 *    home only if none exists (the INSERT is its own statement, so it sees the winner's commit), then widens its bounds and returns its id. No
 *    unique index, no migration. Neon's HTTP driver has no interactive transactions; sql.transaction([...]) is the non-interactive form;
 *  - EVERY re-homed chunk widens the home's started_at / ended_at with LEAST / GREATEST (R5), so the bounds always cover the pieces in it;
 *  - the idx moves into the 90 000+ band; a retry of the same piece hits the same (session, source, idx) and is idempotent. The event records the
 *    R2 key AND the source (R1's recovery gap).
 * Returns null when it cannot (idx outside the band, or any write fails) and the caller falls back to refusing.
 */
async function rehomeAfterReap(a: { roomId: string; oldSessionId: string; idx: number; source: string; r2Key: string; startedAt: Date; endedAt: Date }): Promise<{ sessionId: string; idx: number } | null> {
  if (a.idx < 0 || a.idx >= 9_999) return null;
  const note = rehomeNote(a.oldSessionId);
  try {
    const results = (await sql.transaction([
      sql`SELECT pg_advisory_xact_lock(hashtext(${"rehome:" + a.oldSessionId}))`,
      sql`
        INSERT INTO bench_session (id, room_id, started_at, ended_at, status, notes)
        SELECT ${newSessionId()}, ${a.roomId}, ${a.startedAt.toISOString()}::timestamptz, ${a.endedAt.toISOString()}::timestamptz, 'ended', ${note}
         WHERE NOT EXISTS (SELECT 1 FROM bench_session WHERE room_id = ${a.roomId} AND notes = ${note})
      `,
      sql`
        UPDATE bench_session
           SET started_at = LEAST(started_at, ${a.startedAt.toISOString()}::timestamptz),
               ended_at   = GREATEST(ended_at, ${a.endedAt.toISOString()}::timestamptz)
         WHERE room_id = ${a.roomId} AND notes = ${note}
        RETURNING id
      `,
    ])) as unknown as Array<Array<{ id: string }>>;
    const target = results?.[2]?.[0]?.id ?? null;
    if (!target) return null;
    await sql`
      INSERT INTO bench_event (id, session_id, kind, at, brain_status, payload)
      VALUES (${eventIdFor("rehomed", target, a.source, REHOME_IDX_BASE + a.idx)}, ${target}, 'chunk_rehomed', ${a.startedAt.toISOString()}, 'none',
              ${JSON.stringify({ source: "server", reaped_session_id: a.oldSessionId, original_idx: a.idx, rehomed_idx: REHOME_IDX_BASE + a.idx, chunk_source: a.source, r2_key: a.r2Key, chunk_started_at: a.startedAt.toISOString() })}::jsonb)
      ON CONFLICT (id) DO NOTHING
    `;
    return { sessionId: target, idx: REHOME_IDX_BASE + a.idx };
  } catch (e) {
    console.warn(`[bench-chunks] re-home after reap failed for ${a.oldSessionId}: ${String(e).slice(0, 150)}`);
    return null;
  }
}

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

  // ── ARCH #21 — A REAPED SESSION TAKES NO NEW CHUNK ROWS; REAL AUDIO IS RE-HOMED ─────────
  //
  // The header above says a chunk is always accepted, and for an OPERATOR-ended session that
  // stands. A session the REAPER ended is different: the system declared it dead, raised an
  // alert, and the room is expected to start a new one. bs_wrnpdr4e (reaped 12:26 IST) took a
  // chunk at 15:41 from a zombie kiosk, leaving a 3 h gap recorded inside an ended session.
  //
  // So the chunk is NEVER appended to the ended session. But it is real audio (it can also be a
  // backlog from a Mac that kept capturing through a network outage and was reaped meanwhile), so
  // it is not left unregistered either: it is RE-HOMED, explicitly, into a session of the same
  // room (see rehomeAfterReap) and flagged with a `chunk_rehomed` event + a note on the target.
  // The reply is a 200 carrying BOTH disagreement spellings, so the browser kiosk and the native
  // app each learn their old session was reaped. Only if re-homing is impossible does the chunk
  // fall back to the earlier behaviour: no row, a `chunk_refused_reaped` event naming the R2 key.
  const originalKey = benchChunkKey(session.room_slug, ymdUtc(new Date(session.started_at)), sessionId, idx, source);
  // Server-side authoritative verify (D8) — BEFORE any re-home, so a bogus claim cannot create a session.
  const head = await headObject(originalKey);
  if (head.size === null) {
    return respondError("UPSTREAM_UNAVAILABLE", "r2_object_not_found_or_unreachable");
  }
  if (head.size !== sizeBytes) {
    return respondError("VALIDATION_FAILED", `r2_size_mismatch_${head.size}_${sizeBytes}`);
  }
  let targetSessionId = sessionId;
  let targetIdx = idx;
  let rehomed = false;
  if (reapedRepliesOn() && endedDisagrees && isReaperNote(session.notes)) {
    const home = await rehomeAfterReap({ roomId: session.room_id, oldSessionId: sessionId, idx, source, r2Key: originalKey, startedAt, endedAt });
    if (!home) {
      try {
        await sql`
          INSERT INTO bench_event (id, session_id, kind, at, brain_status, payload)
          VALUES (${eventIdFor("refused", sessionId, source, idx)}, ${sessionId}, 'chunk_refused_reaped', ${startedAt.toISOString()}, 'none',
                  ${JSON.stringify({ source: "server", idx, chunk_source: source, size_bytes: sizeBytes, r2_key: originalKey, chunk_started_at: startedAt.toISOString() })}::jsonb)
          ON CONFLICT (id) DO NOTHING
        `;
      } catch (e) {
        console.warn(`[bench-chunks] reaped-session refusal event write failed session=${sessionId}: ${String(e).slice(0, 150)}`);
      }
      console.warn(`[bench-chunks] ${SESSION_REAPED} session=${sessionId} idx=${idx} source=${source} — could not re-home; chunk NOT registered; audio left in R2; kiosk told`);
      return respondOk({
        ok: true,
        key: originalKey,
        upload_state: "refused_session_reaped",
        session_reaped: true,
        ...disagreementFields(),
      });
    }
    targetSessionId = home.sessionId;
    targetIdx = home.idx;
    rehomed = true;
  }

  const key = originalKey;   // the object stays where the kiosk PUT it, whichever session the row belongs to

  const id = newChunkId();
  try {
    await sql`
      INSERT INTO bench_chunk (
        id, session_id, idx, source, r2_key, content_type, started_at, ended_at,
        duration_ms, size_bytes, upload_state, gap_before_ms, peak_level, avg_level
      ) VALUES (
        ${id}, ${targetSessionId}, ${targetIdx}, ${source}, ${key}, ${contentType},
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
    if (endedDisagrees && !rehomed) {
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
      await evaluateAndWriteWindows(targetSessionId);
    } catch {
      /* non-critical: the next chunk re-evaluates the whole session */
    }
  });

  // The upload SUCCEEDED and says so exactly as before. The extra field is about the session, not
  // about this chunk, and it is absent on every normal upload.
  return respondOk({
    ok: true,
    key,
    upload_state: rehomed ? "rehomed_after_reap" : "verified",
    ...(rehomed ? { session_reaped: true, rehomed_session_id: targetSessionId } : {}),
    ...(endedDisagrees ? (reapedRepliesOn() ? disagreementFields() : { [CHUNK_DISAGREEMENT_FIELD]: ENDED_DISAGREES }) : {}),
  });
}
