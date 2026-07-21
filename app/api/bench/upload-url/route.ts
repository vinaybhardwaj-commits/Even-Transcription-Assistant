/**
 * POST /api/bench/upload-url — presigned PUT (+ HEAD for the D8 client
 * verify) for the next bench chunk. Room-cookie gated; session must belong
 * to the room. Copies the presigned-PUT pattern of
 * app/[slug]/api/encounters/[id]/upload-url.
 *
 * Body: { session_id, idx, content_type? }
 * Returns { url, head_url, key, expires_in_seconds, method: "PUT" } or
 * { already_verified: true } when a verified bench_chunk row already exists
 * for (session, idx) — the bench/ prefix is never overwritten (D6), so the
 * client releases its local copy instead of re-uploading.
 *
 * The R2 key is computed SERVER-side (never trusted from the client):
 * bench/{room_slug}/{YYYY-MM-DD of session start, UTC}/{session_id}/chunk_{idx 5-pad}.webm
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { respondOk, respondError } from "@/lib/respond";
import { readRoomClaims } from "@/lib/room-auth";
import { findBenchSession, ymdUtc } from "@/lib/bench";
import { signPutUrl, signHeadUrl, benchChunkKey } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const claims = await readRoomClaims();
  if (!claims) return respondError("AUTH_REQUIRED", "Room sign-in required");

  let body: { session_id?: unknown; idx?: unknown; content_type?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  const sessionId = typeof body.session_id === "string" ? body.session_id : "";
  const idx = typeof body.idx === "number" && Number.isInteger(body.idx) ? body.idx : -1;
  let contentType = "audio/webm";
  if (typeof body.content_type === "string" && body.content_type.length > 0) {
    contentType = body.content_type.slice(0, 100);
  }
  if (!sessionId.startsWith("bs_") || idx < 0 || idx > 99_999) {
    return respondError("VALIDATION_FAILED", "session_id_and_idx_required");
  }

  const session = await findBenchSession(sessionId);
  if (!session) return respondError("NOT_FOUND", "session_not_found");
  if (session.room_id !== claims.room_id) {
    return respondError("FORBIDDEN", "not_your_session");
  }
  // No status restriction: recovery uploads may arrive for any session state —
  // audio durability wins (D8).

  // Skip if this chunk is already verified (D6: never overwrite bench/).
  try {
    const existing = (await sql`
      SELECT upload_state FROM bench_chunk
       WHERE session_id = ${sessionId} AND idx = ${idx}
       LIMIT 1
    `) as Array<{ upload_state: string }>;
    if (existing[0]?.upload_state === "verified") {
      return respondOk({ already_verified: true });
    }
  } catch {
    // Fail-safe: presign anyway; POST /chunks re-verifies before writing rows.
  }

  const key = benchChunkKey(
    session.room_slug,
    ymdUtc(new Date(session.started_at)),
    sessionId,
    idx,
  );

  try {
    const [url, headUrl] = await Promise.all([
      signPutUrl({ key, contentType, expiresInSeconds: 600 }),
      signHeadUrl({ key, expiresInSeconds: 600 }),
    ]);
    return respondOk({
      url,
      head_url: headUrl,
      key,
      expires_in_seconds: 600,
      method: "PUT",
      content_type: contentType,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("UPSTREAM_UNAVAILABLE", `r2_sign_failed: ${msg.slice(0, 150)}`);
  }
}
