/**
 * POST /{slug}/api/voice/identify  (V2.SD.2)
 *
 * Live clinician identification for the recording-screen "Speakers" pill.
 * The browser sends a short recent audio window; we embed it via the Mac Mini
 * /enroll (same ECAPA model /diarize uses), compute cosine vs the doctor's
 * stored voice_print centroid, and return whether the clinician is currently
 * identified (>= 0.78 live threshold, SD-Q1). Light + stateless.
 *
 * Returns: { enrolled, name, confidence, identified }
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { runEnroll, cosineSimilarity } from "@/lib/enroll";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const maxDuration = 30;

const LIVE_THRESHOLD = 0.78;

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cookie = await readDoctorCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let claims;
  try { claims = await verifyDoctorJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }
  if (claims.slug !== slug) return respondError("FORBIDDEN", "Slug mismatch");

  // Load the doctor — and RE-CHECK THEIR STATUS. The login token outlives a disable: it was valid
  // when issued and nothing revokes it. A disabled or deleted doctor must not identify, so the
  // clinician row is read on every call and the active predicate room matching uses
  // (`status = 'active' AND deleted_at IS NULL`) decides, before any centroid is touched.
  const vp = (await sql`
    SELECT (d.status = 'active' AND d.deleted_at IS NULL) AS active,
           encode(vp.centroid, 'base64') AS centroid_b64, d.full_name AS full_name
      FROM clinician d LEFT JOIN voice_print vp ON vp.doctor_id = d.id
     WHERE d.id = ${claims.doctor_id} LIMIT 1
  `) as Array<{ active: boolean; centroid_b64: string | null; full_name: string }>;
  if (!vp[0] || vp[0].active !== true) return respondError("FORBIDDEN", "clinician_not_active");
  if (!vp[0].centroid_b64) {
    return respondOk({ enrolled: false, identified: false, confidence: null, name: null });
  }
  const name = vp[0].full_name.replace(/^Dr\.?\s+/i, "");

  let form: FormData;
  try { form = await req.formData(); } catch { return respondError("VALIDATION_FAILED", "expected_multipart"); }
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) return respondError("VALIDATION_FAILED", "audio_missing");

  const buf = Buffer.from(await audio.arrayBuffer());
  const emb = await runEnroll(buf, audio.type || "audio/webm");
  if (!emb.ok) return respondOk({ enrolled: true, identified: false, confidence: null, name, error: emb.error });

  const conf = cosineSimilarity(vp[0].centroid_b64!, emb.embeddingBase64);
  return respondOk({
    enrolled: true,
    name,
    confidence: conf,
    identified: conf != null && conf >= LIVE_THRESHOLD,
  });
}
