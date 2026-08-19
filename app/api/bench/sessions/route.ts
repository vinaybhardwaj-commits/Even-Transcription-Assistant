/**
 * /api/bench/sessions — Room-Bench PRD §3.4.
 *
 * POST — create a bench_session (room-cookie gated): { label?, mic_label? }
 * GET  — list sessions + rollups (admin-gated): chunk counts, verified,
 *        gap totals, storage, last-chunk age (drives the live badge <7 min).
 *        K-B: counts are PRIMARY-stream; plus backup_chunk_count,
 *        backup_verified_count, primary_lost/restored_count and mic_status
 *        (on_backup | backup_covered | lost_no_backup | null) for the R10 badge.
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
  /** K-B: backup-stream chunks and primary-mic loss events */
  backup_chunk_count: number;
  backup_verified_count: number;
  primary_lost_count: number;
  primary_restored_count: number;
};

export async function GET() {
  const g = await benchAdminGuard();
  if (!g.ok) return respondError(g.code, g.msg);

  try {
    const rows = (await sql`
      SELECT s.id, s.label, s.mic_label, s.started_at, s.ended_at, s.status, s.notes,
             r.name AS room_name, r.slug AS room_slug,
             COUNT(c.id) FILTER (WHERE c.source = 'primary')::int AS chunk_count,
             COUNT(c.id) FILTER (WHERE c.source = 'primary' AND c.upload_state = 'verified')::int AS verified_count,
             COALESCE(SUM(c.size_bytes), 0)::bigint AS total_bytes,
             COALESCE(SUM(c.gap_before_ms) FILTER (WHERE c.source = 'primary'), 0)::bigint AS gap_ms,
             COUNT(c.id) FILTER (WHERE c.source = 'primary' AND c.gap_before_ms >= 2000)::int AS gap_count,
             MAX(c.created_at) FILTER (WHERE c.source = 'primary') AS last_chunk_at,
             COUNT(c.id) FILTER (WHERE c.source = 'backup')::int AS backup_chunk_count,
             COUNT(c.id) FILTER (WHERE c.source = 'backup' AND c.upload_state = 'verified')::int AS backup_verified_count,
             COALESCE(ev.primary_lost_count, 0)::int AS primary_lost_count,
             COALESCE(ev.primary_restored_count, 0)::int AS primary_restored_count
        FROM bench_session s
        JOIN room r ON r.id = s.room_id
        LEFT JOIN bench_chunk c ON c.session_id = s.id
        LEFT JOIN LATERAL (
          SELECT COUNT(*) FILTER (WHERE e.kind = 'mic_primary_lost') AS primary_lost_count,
                 COUNT(*) FILTER (WHERE e.kind = 'mic_primary_restored') AS primary_restored_count
            FROM bench_event e
           WHERE e.session_id = s.id
        ) ev ON true
       GROUP BY s.id, s.label, s.mic_label, s.started_at, s.ended_at, s.status, s.notes,
                r.name, r.slug, ev.primary_lost_count, ev.primary_restored_count
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
        backup_chunk_count: r.backup_chunk_count,
        backup_verified_count: r.backup_verified_count,
        primary_lost_count: r.primary_lost_count,
        primary_restored_count: r.primary_restored_count,
        // K-B R10 badge: red = primary was lost with NO backup tape; amber = lost but backup
        // covered it (or primary currently down); null = clean day.
        mic_status:
          r.primary_lost_count > 0
            ? r.backup_chunk_count > 0
              ? r.primary_lost_count > r.primary_restored_count
                ? "on_backup"
                : "backup_covered"
              : "lost_no_backup"
            : null,
      })),
    });
  } catch {
    // Fail-safe: tables may not exist before migration 0041 runs.
    return respondOk({ sessions: [] });
  }
}
