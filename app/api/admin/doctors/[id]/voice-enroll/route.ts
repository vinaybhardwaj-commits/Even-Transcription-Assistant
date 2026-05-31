/**
 * POST /api/admin/doctors/[id]/voice-enroll  (admin kiosk voice enrollment)
 *
 * Admin-authenticated mirror of /{slug}/api/voice/enroll: lets an admin enroll
 * ANY doctor's voice (doctor physically present at the admin's mic). Accepts
 * clip_0..clip_N → Mac Mini /enroll ×N → averaged centroid → voice_print for
 * the URL's doctor id. Re-enroll overwrites. Audit-logged as the admin actor.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { runEnroll, averageEmbeddings } from "@/lib/enroll";
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
  const clips: Blob[] = [];
  for (const [k, v] of form.entries()) {
    if (k.startsWith("clip_") && v instanceof Blob && v.size > 0) clips.push(v);
  }
  if (clips.length === 0) return respondError("VALIDATION_FAILED", "no_clips");

  const results = await Promise.all(clips.map(async (c) => {
    const buf = Buffer.from(await c.arrayBuffer());
    return runEnroll(buf, c.type || "audio/webm");
  }));
  const embeddings = results.filter((r): r is { ok: true; embeddingBase64: string } => r.ok).map((r) => r.embeddingBase64);
  const errors = results.filter((r) => !r.ok).map((r) => (r as { ok: false; error: string }).error);
  if (embeddings.length < 3) {
    return respondError("UPSTREAM_UNAVAILABLE", `enroll_failed: only ${embeddings.length}/${clips.length} clips embedded (${errors.slice(0, 2).join("; ")})`);
  }

  let centroidB64: string;
  try { centroidB64 = averageEmbeddings(embeddings); }
  catch (e) { return respondError("PIPELINE_FAILED", `centroid_failed: ${e instanceof Error ? e.message : String(e)}`); }

  try {
    await sql`
      INSERT INTO voice_print
        (doctor_id, centroid, sample_count, samples_json, enrolled_at, last_sample_at, needs_reenrollment)
      VALUES
        (${id}, decode(${centroidB64}, 'base64'), ${embeddings.length},
         ${JSON.stringify(embeddings)}::jsonb, NOW(), NOW(), FALSE)
      ON CONFLICT (doctor_id) DO UPDATE SET
        centroid = EXCLUDED.centroid, sample_count = EXCLUDED.sample_count,
        samples_json = EXCLUDED.samples_json, enrolled_at = NOW(),
        last_sample_at = NOW(), needs_reenrollment = FALSE
    `;
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES ('admin', ${adminId || null}, 'voice_print.enroll', 'doctor', ${id},
              ${JSON.stringify({ samples: embeddings.length, clips: clips.length, via: "admin_kiosk" })}::jsonb)
    `;
  } catch (e) {
    return respondError("PIPELINE_FAILED", `voice_print_write_failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 150)}`);
  }
  return respondOk({ ok: true, sample_count: embeddings.length, failed: errors.length });
}
