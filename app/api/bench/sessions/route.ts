/**
 * /api/bench/sessions — Room-Bench PRD §3.4.
 *
 * POST — create a bench_session (room-cookie gated): { label?, mic_label? }
 * GET  — list sessions + rollups (admin-gated): chunk counts, verified,
 *        gap totals, storage, last-chunk age (drives the live badge <7 min).
 *
 * All queries INFERRED; GET fail-safes to an empty list (never breaks the
 * admin page), POST returns a retryable error rather than fake success.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { respondOk, respondError } from "@/lib/respond";
import { readRoomClaims } from "@/lib/room-auth";
import { benchAdminGuard, newSessionId } from "@/lib/bench";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const claims = await readRoomClaims();
  if (!claims) return respondError("AUTH_REQUIRED", "Room sign-in required");

  let body: { label?: string | null; mic_label?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 200) || null : null;
  const micLabel =
    typeof body.mic_label === "string" ? body.mic_label.trim().slice(0, 200) || null : null;

  const id = newSessionId();
  try {
    await sql`
      INSERT INTO bench_session (id, room_id, label, mic_label)
      VALUES (${id}, ${claims.room_id}, ${label}, ${micLabel})
    `;
  } catch (e) {
    return respondError("UPSTREAM_UNAVAILABLE", String(e).slice(0, 150));
  }
  return respondOk({ session: { id, room_id: claims.room_id, label, mic_label: micLabel, status: "recording" } });
}

type SessionRollupRow = {
  id: string;
  label: string | null;
  mic_label: string | null;
  started_at: string | Date;
  ended_at: string | Date | null;
  status: string;
  notes: string | null;
  room_name: string;
  room_slug: string;
  chunk_count: number;
  verified_count: number;
  total_bytes: string | number | null;
  gap_ms: string | number | null;
  gap_count: number;
  last_chunk_at: string | Date | null;
};

export async function GET() {
  const g = await benchAdminGuard();
  if (!g.ok) return respondError(g.code, g.msg);

  try {
    const rows = (await sql`
      SELECT s.id, s.label, s.mic_label, s.started_at, s.ended_at, s.status, s.notes,
             r.name AS room_name, r.slug AS room_slug,
             COUNT(c.id)::int AS chunk_count,
             COUNT(c.id) FILTER (WHERE c.upload_state = 'verified')::int AS verified_count,
             COALESCE(SUM(c.size_bytes), 0)::bigint AS total_bytes,
             COALESCE(SUM(c.gap_before_ms), 0)::bigint AS gap_ms,
             COUNT(c.id) FILTER (WHERE c.gap_before_ms >= 2000)::int AS gap_count,
             MAX(c.created_at) AS last_chunk_at
        FROM bench_session s
        JOIN room r ON r.id = s.room_id
        LEFT JOIN bench_chunk c ON c.session_id = s.id
       GROUP BY s.id, s.label, s.mic_label, s.started_at, s.ended_at, s.status, s.notes,
                r.name, r.slug
       ORDER BY s.started_at DESC
       LIMIT 200
    `) as SessionRollupRow[];
    return respondOk({
      sessions: rows.map((r) => ({
        id: r.id,
        label: r.label,
        mic_label: r.mic_label,
        started_at: new Date(r.started_at).toISOString(),
        ended_at: r.ended_at ? new Date(r.ended_at).toISOString() : null,
        status: r.status,
        notes: r.notes,
        room_name: r.room_name,
        room_slug: r.room_slug,
        chunk_count: r.chunk_count,
        verified_count: r.verified_count,
        total_bytes: Number(r.total_bytes ?? 0),
        gap_ms: Number(r.gap_ms ?? 0),
        gap_count: r.gap_count,
        last_chunk_at: r.last_chunk_at ? new Date(r.last_chunk_at).toISOString() : null,
      })),
    });
  } catch {
    // Fail-safe: tables may not exist before migration 0041 runs.
    return respondOk({ sessions: [] });
  }
}
