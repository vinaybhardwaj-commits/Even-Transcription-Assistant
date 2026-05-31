/**
 * POST /api/admin/doctors/[id]/voice-enroll  (admin kiosk voice enrollment)
 *
 * Admin-authenticated: enroll ANY clinician's voice (clinician physically at the
 * admin's mic). Accepts clip_0..clip_N. Each clip is embedded via the Mac Mini
 * /enroll, its raw audio is retained in R2, and one voice_sample row is stored;
 * the voice_print centroid is then recomputed from ALL accumulated samples
 * (Voiceprint Retention PRD — accumulate, never overwrite). Audit-logged.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { storeEnrollmentSession } from "@/lib/voice-samples";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let adminId = "";
  try { adminId = String((await verifyAdminJwt(cookie)).admin_id ?? ""); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }

  const dr = (await sql`SELECT id FROM clinician WHERE id = ${id} AND deleted_at IS NULL LIMIT 1`) as Array<{ id: string }>;
  if (!dr[0]) return respondError("NOT_FOUND", "doctor_not_found");

  let form: FormData;
  try { form = await req.formData(); } catch { return respondError("VALIDATION_FAILED", "expected_multipart"); }
  const clips: { buf: Buffer; contentType: string }[] = [];
  for (const [k, v] of form.entries()) {
    if (k.startsWith("clip_") && v instanceof Blob && v.size > 0) {
      clips.push({ buf: Buffer.from(await v.arrayBuffer()), contentType: v.type || "audio/webm" });
    }
  }
  if (clips.length === 0) return respondError("VALIDATION_FAILED", "no_clips");

  const res = await storeEnrollmentSession({ clinicianId: id, clips, capturedByAdminId: adminId || null });
  if (!res.ok) return respondError("UPSTREAM_UNAVAILABLE", `enroll_failed: ${res.error}`);

  try {
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES ('admin', ${adminId || null}, 'voice_print.enroll', 'doctor', ${id},
              ${JSON.stringify({ stored: res.stored, clips: clips.length, total_samples: res.totalSamples, via: "admin_kiosk" })}::jsonb)
    `;
  } catch { /* audit best-effort */ }
  return respondOk({ ok: true, sample_count: res.stored, total_samples: res.totalSamples, failed: res.failed });
}
