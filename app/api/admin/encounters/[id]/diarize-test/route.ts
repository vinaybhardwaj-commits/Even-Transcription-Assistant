/** TEMP DIAGNOSTIC — GET /api/admin/encounters/{id}/diarize-test
 * Runs the live diarize call on the encounter's R2 audio FROM THE VERCEL RUNTIME
 * and stores the result (same writes as /process diarizeStore). Verifies the
 * Vercel→Mac Mini diarize path + storage. REMOVE after. */
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { sql } from "@/lib/db";
import { headObject, getObjectBytes } from "@/lib/r2";
import { runDiarize } from "@/lib/diarize";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await readAdminCookie();
  if (!c) return respondError("AUTH_REQUIRED", "x");
  try { await verifyAdminJwt(c); } catch { return respondError("AUTH_EXPIRED", "x"); }
  const { id } = await params;
  const rows = (await sql`SELECT audio_object_key FROM encounter WHERE id = ${id} LIMIT 1`) as Array<{ audio_object_key: string | null }>;
  const key = rows[0]?.audio_object_key;
  if (!key) return respondError("NOT_FOUND", "no audio");
  const head = await headObject(key);
  const bytes = await getObjectBytes(key);
  if (!bytes) return respondError("NOT_FOUND", "no bytes");
  const d = await runDiarize(bytes, head.content_type || "audio/webm", { encounterId: id, clinicianCentroids: [], manualRelabels: [] });
  if (d.ok) {
    await sql`
      UPDATE encounter SET
        speakers = ${JSON.stringify(d.result.speakers)}::jsonb,
        transcript_segments = ${JSON.stringify(d.result.transcript_segments)}::jsonb,
        overlap_windows = ${JSON.stringify(d.result.overlap_windows)}::jsonb,
        aggregates = ${JSON.stringify(d.result.aggregates)}::jsonb,
        diarize_status = 'complete', diarize_completed_at = NOW(), diarize_error = NULL
      WHERE id = ${id}`;
  }
  return respondOk({
    ok: d.ok, latency_ms: d.latencyMs,
    speakers: d.ok ? d.result.speakers : null,
    error: d.ok ? null : d.error,
  });
}
