/** GET /api/admin/doctors/[id]/voice-samples/[sampleId]/embedding — download the embedding vector (JSON). */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondError } from "@/lib/respond";
import { embeddingBase64ToFloats } from "@/lib/voice-samples";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; sampleId: string }> }) {
  const { id, sampleId } = await params;
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try { await verifyAdminJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }

  const rows = (await sql`
    SELECT encode(embedding, 'base64') AS emb, source, created_at, session_id
      FROM voice_sample WHERE id = ${sampleId} AND clinician_id = ${id} LIMIT 1
  `) as Array<{ emb: string; source: string; created_at: string; session_id: string | null }>;
  if (!rows[0]) return respondError("NOT_FOUND", "sample_not_found");
  const vector = embeddingBase64ToFloats(rows[0].emb);
  const body = JSON.stringify({
    sample_id: sampleId, clinician_id: id, source: rows[0].source,
    session_id: rows[0].session_id, created_at: rows[0].created_at,
    model: "ecapa-192", dim: vector.length, embedding: vector,
  }, null, 2);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="embedding-${sampleId}.json"`,
      "Cache-Control": "private, no-store",
    },
  });
}
