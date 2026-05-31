/** POST /api/admin/doctors/[id]/voice-retrain — rebuild the voiceprint from all included samples. */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { recomputeCentroid } from "@/lib/voice-samples";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let adminId = "";
  try { adminId = String((await verifyAdminJwt(cookie)).admin_id ?? ""); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }
  const ar = (await sql`SELECT role FROM admin_user WHERE id = ${adminId}::uuid LIMIT 1`) as Array<{ role: string }>;
  if (ar[0]?.role === "viewer") return respondError("FORBIDDEN", "Read-only admins cannot retrain");

  const dr = (await sql`SELECT id FROM clinician WHERE id = ${id} AND deleted_at IS NULL LIMIT 1`) as Array<{ id: string }>;
  if (!dr[0]) return respondError("NOT_FOUND", "doctor_not_found");

  const { sampleCount } = await recomputeCentroid(id);
  try {
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES ('admin', ${adminId || null}, 'voice_print.retrain', 'doctor', ${id},
              ${JSON.stringify({ sample_count: sampleCount })}::jsonb)
    `;
  } catch { /* best-effort */ }
  return respondOk({ ok: true, sample_count: sampleCount });
}
