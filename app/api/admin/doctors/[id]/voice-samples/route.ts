/** GET /api/admin/doctors/[id]/voice-samples — list retained voice samples. */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { listSamples } from "@/lib/voice-samples";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try { await verifyAdminJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }

  const vp = (await sql`
    SELECT sample_count, enrolled_at, last_sample_at, needs_reenrollment,
           (centroid IS NOT NULL) AS has_centroid
      FROM voice_print WHERE doctor_id = ${id} LIMIT 1
  `) as Array<{ sample_count: number; enrolled_at: string; last_sample_at: string; needs_reenrollment: boolean; has_centroid: boolean }>;
  const samples = await listSamples(id);
  return respondOk({
    voiceprint: vp[0] ?? null,
    total_samples: samples.length,
    samples,
  });
}
