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
 */
import { NextRequest, after } from "next/server";
import { sql } from "@/lib/db";
import { respondOk, respondError } from "@/lib/respond";
import { readRoomClaims } from "@/lib/room-auth";
import { findBenchSession, newChunkId, ymdUtc } from "@/lib/bench";
import { headObject, benchChunkKey } from "@/lib/r2";
import { evaluateAndWriteWindows } from "@/lib/bench-window";

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

  const session = await findBenchSession(sessionId);
  if (!session) return respondError("NOT_FOUND", "session_not_found");
  if (session.room_id !== claims.room_id) {
    return respondError("FORBIDDEN", "not_your_session");
  }

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
        duration_ms, size_bytes, upload_state, gap_before_ms
      ) VALUES (
        ${id}, ${sessionId}, ${idx}, ${source}, ${key}, ${contentType},
        ${startedAt.toISOString()}, ${endedAt.toISOString()},
        ${durationMs}, ${sizeBytes}, 'verified', ${gapBeforeMs}
      )
      ON CONFLICT (session_id, source, idx) DO UPDATE SET
        upload_state = 'verified',
        size_bytes = EXCLUDED.size_bytes
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
    try {
      await evaluateAndWriteWindows(sessionId);
    } catch {
      /* non-critical: the next chunk re-evaluates the whole session */
    }
  });

  return respondOk({ ok: true, key, upload_state: "verified" });
}
