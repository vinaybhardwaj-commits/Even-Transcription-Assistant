/**
 * /api/bench/sessions/{id} — Room-Bench PRD §3.4.
 *
 * PATCH (room-cookie gated, session must belong to the room):
 *   { action: "pause" | "resume" | "end", notes? } — states are
 *   recording | paused | ended only. End Day is called by the client only
 *   after the final chunk upload is verified (the kiosk blocks on that).
 * GET (admin-gated): session detail — chunk manifest, gaps, totals.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { respondOk, respondError } from "@/lib/respond";
import { readRoomClaims } from "@/lib/room-auth";
import { benchAdminGuard, findBenchSession, listBenchChunks } from "@/lib/bench";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await readRoomClaims();
  if (!claims) return respondError("AUTH_REQUIRED", "Room sign-in required");
  if (!id.startsWith("bs_")) return respondError("VALIDATION_FAILED", "bad_session_id");

  const session = await findBenchSession(id);
  if (!session) return respondError("NOT_FOUND", "session_not_found");
  if (session.room_id !== claims.room_id) {
    return respondError("FORBIDDEN", "not_your_session");
  }

  let body: { action?: string; notes?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  const action = typeof body.action === "string" ? body.action : null;
  const notes =
    typeof body.notes === "string" ? body.notes.trim().slice(0, 2000) : undefined;

  try {
    if (action === "pause") {
      await sql`
        UPDATE bench_session SET status = 'paused'
         WHERE id = ${id} AND room_id = ${claims.room_id} AND status = 'recording'
      `;
    } else if (action === "resume") {
      await sql`
        UPDATE bench_session SET status = 'recording'
         WHERE id = ${id} AND room_id = ${claims.room_id} AND status = 'paused'
      `;
    } else if (action === "end") {
      await sql`
        UPDATE bench_session SET status = 'ended', ended_at = NOW()
         WHERE id = ${id} AND room_id = ${claims.room_id} AND status <> 'ended'
      `;
    } else if (action != null) {
      return respondError("VALIDATION_FAILED", "unknown_action");
    }
    if (notes !== undefined) {
      await sql`
        UPDATE bench_session SET notes = ${notes || null}
         WHERE id = ${id} AND room_id = ${claims.room_id}
      `;
    }
  } catch (e) {
    return respondError("UPSTREAM_UNAVAILABLE", String(e).slice(0, 150));
  }

  return respondOk({ ok: true });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await benchAdminGuard();
  if (!g.ok) return respondError(g.code, g.msg);
  if (!id.startsWith("bs_")) return respondError("VALIDATION_FAILED", "bad_session_id");

  const session = await findBenchSession(id);
  if (!session) return respondError("NOT_FOUND", "session_not_found");
  const chunks = await listBenchChunks(id);

  const verified = chunks.filter((c) => c.upload_state === "verified");
  const totalBytes = chunks.reduce((a, c) => a + Number(c.size_bytes ?? 0), 0);
  const gapMs = chunks.reduce((a, c) => a + (c.gap_before_ms ?? 0), 0);

  return respondOk({
    session: {
      id: session.id,
      room_id: session.room_id,
      room_name: session.room_name,
      room_slug: session.room_slug,
      label: session.label,
      mic_label: session.mic_label,
      started_at: new Date(session.started_at).toISOString(),
      ended_at: session.ended_at ? new Date(session.ended_at).toISOString() : null,
      status: session.status,
      notes: session.notes,
    },
    totals: {
      chunk_count: chunks.length,
      verified_count: verified.length,
      total_bytes: totalBytes,
      gap_ms: gapMs,
    },
    chunks: chunks.map((c) => ({
      id: c.id,
      idx: c.idx,
      r2_key: c.r2_key,
      content_type: c.content_type,
      started_at: new Date(c.started_at).toISOString(),
      ended_at: new Date(c.ended_at).toISOString(),
      duration_ms: c.duration_ms,
      size_bytes: c.size_bytes === null ? null : Number(c.size_bytes),
      upload_state: c.upload_state,
      gap_before_ms: c.gap_before_ms,
    })),
  });
}
