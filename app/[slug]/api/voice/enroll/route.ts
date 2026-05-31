/**
 * POST /{slug}/api/voice/enroll  (V2.SD.1 — doctor self-serve enrollment)
 *
 * multipart/form-data with clip_0..clip_N (the wizard's recorded sentences).
 * Each clip is embedded via the Mac Mini /enroll, its raw audio retained in R2,
 * and one voice_sample row stored; the voice_print centroid is recomputed from
 * ALL accumulated samples (Voiceprint Retention PRD — accumulate, not
 * overwrite). Needs >=3 successful embeddings. Audit-logged.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { storeEnrollmentSession } from "@/lib/voice-samples";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const cookie = await readDoctorCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let claims;
  try {
    claims = await verifyDoctorJwt(cookie);
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }
  if (claims.slug !== slug) return respondError("FORBIDDEN", "Slug mismatch");
  const doctorId = claims.doctor_id;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return respondError("VALIDATION_FAILED", "expected_multipart");
  }
  const clips: { buf: Buffer; contentType: string }[] = [];
  for (const [k, v] of form.entries()) {
    if (k.startsWith("clip_") && v instanceof Blob && v.size > 0) {
      clips.push({ buf: Buffer.from(await v.arrayBuffer()), contentType: v.type || "audio/webm" });
    }
  }
  if (clips.length === 0) return respondError("VALIDATION_FAILED", "no_clips");

  const res = await storeEnrollmentSession({ clinicianId: doctorId, clips, capturedByAdminId: null });
  if (!res.ok) return respondError("UPSTREAM_UNAVAILABLE", `enroll_failed: ${res.error}`);

  try {
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES ('doctor', ${doctorId}, 'voice_print.enroll', 'doctor', ${doctorId},
              ${JSON.stringify({ stored: res.stored, clips: clips.length, total_samples: res.totalSamples })}::jsonb)
    `;
  } catch { /* audit best-effort */ }

  return respondOk({ ok: true, sample_count: res.stored, total_samples: res.totalSamples, failed: res.failed });
}
