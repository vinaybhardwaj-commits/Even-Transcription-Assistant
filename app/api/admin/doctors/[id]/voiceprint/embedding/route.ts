/** GET /api/admin/doctors/[id]/voiceprint/embedding — download the computed voiceprint centroid (JSON). */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondError } from "@/lib/respond";
import { embeddingBase64ToFloats } from "@/lib/voice-samples";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try { await verifyAdminJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }

  const rows = (await sql`
    SELECT encode(centroid, 'base64') AS emb, sample_count, enrolled_at, last_sample_at
      FROM voice_print WHERE doctor_id = ${id} LIMIT 1
  `) as Array<{ emb: string | null; sample_count: number; enrolled_at: string; last_sample_at: string }>;
  if (!rows[0] || !rows[0].emb) return respondError("NOT_FOUND", "no_voiceprint");
  const vector = embeddingBase64ToFloats(rows[0].emb);
  const body = JSON.stringify({
    clinician_id: id, kind: "centroid", model: "ecapa-192", dim: vector.length,
    sample_count: rows[0].sample_count, enrolled_at: rows[0].enrolled_at,
    last_sample_at: rows[0].last_sample_at, embedding: vector,
  }, null, 2);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="voiceprint-${id}.json"`,
      "Cache-Control": "private, no-store",
    },
  });
}
