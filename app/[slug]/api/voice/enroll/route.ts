/**
 * POST /{slug}/api/voice/enroll  (V2.SD.1)
 *
 * multipart/form-data with clip_0 .. clip_N (the wizard's 6 recorded sentences).
 * Server-side: each clip → Mac Mini /enroll → 192-d ECAPA embedding; the
 * embeddings are averaged into a centroid; both are stored in voice_print
 * (centroid as bytea, the per-sentence embeddings as samples_json). Re-enroll
 * overwrites (ON CONFLICT). Audit-logged.
 *
 * Soft requirement: needs >=3 successful embeddings to enroll.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { runEnroll, averageEmbeddings } from "@/lib/enroll";
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
  const clips: Blob[] = [];
  for (const [k, v] of form.entries()) {
    if (k.startsWith("clip_") && v instanceof Blob && v.size > 0) clips.push(v);
  }
  if (clips.length === 0) return respondError("VALIDATION_FAILED", "no_clips");

  // Embed each clip via the Mac Mini /enroll (parallel).
  const results = await Promise.all(
    clips.map(async (c) => {
      const buf = Buffer.from(await c.arrayBuffer());
      return runEnroll(buf, c.type || "audio/webm");
    }),
  );
  const embeddings = results.filter((r): r is { ok: true; embeddingBase64: string } => r.ok).map((r) => r.embeddingBase64);
  const errors = results.filter((r) => !r.ok).map((r) => (r as { ok: false; error: string }).error);

  if (embeddings.length < 3) {
    return respondError(
      "UPSTREAM_UNAVAILABLE",
      `enroll_failed: only ${embeddings.length}/${clips.length} clips embedded (${errors.slice(0, 2).join("; ")})`,
    );
  }

  let centroidB64: string;
  try {
    centroidB64 = averageEmbeddings(embeddings);
  } catch (e) {
    return respondError("PIPELINE_FAILED", `centroid_failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    await sql`
      INSERT INTO voice_print
        (doctor_id, centroid, sample_count, samples_json, enrolled_at, last_sample_at, needs_reenrollment)
      VALUES
        (${doctorId}, decode(${centroidB64}, 'base64'), ${embeddings.length},
         ${JSON.stringify(embeddings)}::jsonb, NOW(), NOW(), FALSE)
      ON CONFLICT (doctor_id) DO UPDATE SET
        centroid           = EXCLUDED.centroid,
        sample_count       = EXCLUDED.sample_count,
        samples_json       = EXCLUDED.samples_json,
        enrolled_at        = NOW(),
        last_sample_at     = NOW(),
        needs_reenrollment = FALSE
    `;
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES ('doctor', ${doctorId}, 'voice_print.enroll', 'doctor', ${doctorId},
              ${JSON.stringify({ samples: embeddings.length, clips: clips.length })}::jsonb)
    `;
  } catch (e) {
    return respondError("PIPELINE_FAILED", `voice_print_write_failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 150)}`);
  }

  return respondOk({ ok: true, sample_count: embeddings.length, failed: errors.length });
}
