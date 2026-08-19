/**
 * /api/bench/sessions — Room-Bench PRD §3.4.
 *
 * POST — create a bench_session (room-cookie gated): { label?, mic_label? }
 * GET  — list sessions + rollups (admin-gated): chunk counts, verified,
 *        gap totals, storage, last-chunk age (drives the live badge <7 min).
 *        K-B: counts are PRIMARY-stream; plus backup_chunk_count,
 *        backup_verified_count, primary_lost/restored_count and mic_status
 *        (on_backup | backup_covered | lost_no_backup | null) for the R10 badge.
 *        K-A: last_any_chunk_at (newest chunk across both sources) for the
 *        time-based `stalled` chip.
 *
 * All queries INFERRED; GET fail-safes to an empty list (never breaks the
 * admin page), POST returns a retryable error rather than fake success.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { respondOk, respondError } from "@/lib/respond";
import { readRoomClaims } from "@/lib/room-auth";
import { benchAdminGuard, listBenchSessions, newSessionId, type BenchSessionListFilters } from "@/lib/bench";

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

/**
 * Operator MCP S1 (additive): optional query filters `room_id`, `room_slug`, `ist_date`
 * (IST calendar date of session start), `status`, `limit` (1..200). With NO params the
 * response is byte-identical to the pre-MCP route (same query via lib/bench
 * listBenchSessions — K-A/K-B rollup — last 200 by started_at DESC).
 */
export async function GET(req: NextRequest) {
  const g = await benchAdminGuard();
  if (!g.ok) return respondError(g.code, g.msg);

  const sp = req.nextUrl.searchParams;
  const str = (k: string): string | null => {
    const v = sp.get(k);
    return v && v.length > 0 && v.length <= 128 ? v : null;
  };
  const istDate = str("ist_date");
  const rawLimit = sp.get("limit");
  const parsedLimit = rawLimit === null ? null : Number(rawLimit);
  const filters: BenchSessionListFilters = {
    room_id: str("room_id"),
    room_slug: str("room_slug"),
    ist_date: istDate && /^\d{4}-\d{2}-\d{2}$/.test(istDate) ? istDate : null,
    status: str("status"),
    limit: parsedLimit !== null && Number.isFinite(parsedLimit) ? parsedLimit : null,
  };

  try {
    const rows = await listBenchSessions(filters);
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
        // K-A (R10 time-based case): newest chunk across BOTH sources; the admin list derives the
        // red `stalled` chip from it (> 10 min on a 'recording' session). Additive.
        last_any_chunk_at: r.last_any_chunk_at ? new Date(r.last_any_chunk_at).toISOString() : null,
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
