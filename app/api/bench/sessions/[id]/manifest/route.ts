/**
 * GET /api/bench/sessions/{id}/manifest — manifest.json alone (Room-Bench
 * PRD §3.4): session row + chunk rows (keys, times, gaps) + per-chunk
 * presigned GET links. Admin-gated.
 */
import { NextRequest, NextResponse } from "next/server";
import { respondError } from "@/lib/respond";
import { benchAdminGuard, findBenchSession, listBenchChunks } from "@/lib/bench";
import { signGetUrl } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const withUrls = await Promise.all(
    chunks.map(async (c) => {
      let url: string | null = null;
      try {
        url = await signGetUrl({
          key: c.r2_key,
          expiresInSeconds: 3600,
          contentType: c.content_type,
        });
      } catch {
        // Fail-safe: manifest still lists the chunk; link degrades to null.
      }
      return {
        idx: c.idx,
        r2_key: c.r2_key,
        content_type: c.content_type,
        started_at: new Date(c.started_at).toISOString(),
        ended_at: new Date(c.ended_at).toISOString(),
        duration_ms: c.duration_ms,
        size_bytes: c.size_bytes === null ? null : Number(c.size_bytes),
        upload_state: c.upload_state,
        gap_before_ms: c.gap_before_ms,
        presigned_get: url,
      };
    }),
  );

  const manifest = {
    generated_at: new Date().toISOString(),
    session: {
      id: session.id,
      room_name: session.room_name,
      room_slug: session.room_slug,
      label: session.label,
      mic_label: session.mic_label,
      started_at: new Date(session.started_at).toISOString(),
      ended_at: session.ended_at ? new Date(session.ended_at).toISOString() : null,
      status: session.status,
      notes: session.notes,
    },
    archive_policy:
      "bench/ prefix is a permanent archive — exempt from retention policy and self-delete (Room-Bench PRD D6)",
    chunks: withUrls,
    gaps: withUrls
      .filter((c) => c.gap_before_ms >= 2000)
      .map((c) => ({ before_idx: c.idx, gap_ms: c.gap_before_ms })),
  };

  return new NextResponse(JSON.stringify(manifest, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${session.id}_manifest.json"`,
    },
  });
}
