/** DELETE /api/admin/doctors/[id]/voice-samples/[sampleId] — remove a sample + recompute. */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { deleteObject } from "@/lib/r2";
import { recomputeCentroid } from "@/lib/voice-samples";

export const runtime = "nodejs";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; sampleId: string }> }) {
  const { id, sampleId } = await params;
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let adminId = "";
  try { adminId = String((await verifyAdminJwt(cookie)).admin_id ?? ""); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }
  const ar = (await sql`SELECT role FROM admin_user WHERE id = ${adminId}::uuid LIMIT 1`) as Array<{ role: string }>;
  if (ar[0]?.role === "viewer") return respondError("FORBIDDEN", "Read-only admins cannot delete samples");

  const rows = (await sql`
    SELECT source, audio_r2_key FROM voice_sample WHERE id = ${sampleId} AND clinician_id = ${id} LIMIT 1
  `) as Array<{ source: string; audio_r2_key: string | null }>;
  if (!rows[0]) return respondError("NOT_FOUND", "sample_not_found");

  await sql`DELETE FROM voice_sample WHERE id = ${sampleId} AND clinician_id = ${id}`;
  // Only delete enrollment audio we own; never delete a passive sample's source encounter recording.
  if (rows[0].source === "enrollment" && rows[0].audio_r2_key) {
    await deleteObject(rows[0].audio_r2_key);
  }
  const { sampleCount } = await recomputeCentroid(id);
  try {
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES ('admin', ${adminId || null}, 'voice_sample.delete', 'doctor', ${id},
              ${JSON.stringify({ sample_id: sampleId, remaining: sampleCount })}::jsonb)
    `;
  } catch { /* best-effort */ }
  return respondOk({ ok: true, remaining_samples: sampleCount });
}
