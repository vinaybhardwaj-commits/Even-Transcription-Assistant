/** GET /api/admin/doctors/[id]/voice-samples/[sampleId]/audio — download the raw clip. */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondError } from "@/lib/respond";
import { getObjectBytes } from "@/lib/r2";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; sampleId: string }> }) {
  const { id, sampleId } = await params;
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try { await verifyAdminJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }

  const rows = (await sql`
    SELECT audio_r2_key, content_type FROM voice_sample WHERE id = ${sampleId} AND clinician_id = ${id} LIMIT 1
  `) as Array<{ audio_r2_key: string | null; content_type: string | null }>;
  if (!rows[0]) return respondError("NOT_FOUND", "sample_not_found");
  if (!rows[0].audio_r2_key) return respondError("NOT_FOUND", "no_audio_for_sample");

  const bytes = await getObjectBytes(rows[0].audio_r2_key);
  if (!bytes) return respondError("NOT_FOUND", "audio_object_missing");
  const ct = rows[0].content_type || "audio/webm";
  const ext = ct.includes("mp4") ? "mp4" : ct.includes("wav") ? "wav" : ct.includes("ogg") ? "ogg" : "webm";
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": ct,
      "Content-Disposition": `attachment; filename="voice-sample-${sampleId}.${ext}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
