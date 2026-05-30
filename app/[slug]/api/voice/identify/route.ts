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

  // Load the doctor's enrolled centroid + name.
  const vp = (await sql`
    SELECT encode(vp.centroid, 'base64') AS centroid_b64, d.full_name AS full_name
      FROM voice_print vp JOIN doctor d ON d.id = vp.doctor_id
     WHERE vp.doctor_id = ${claims.doctor_id} LIMIT 1
  `) as Array<{ centroid_b64: string; full_name: string }>;
  if (!vp[0]?.centroid_b64) {
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

  const conf = cosineSimilarity(vp[0].centroid_b64, emb.embeddingBase64);
  return respondOk({
    enrolled: true,
    name,
    confidence: conf,
    identified: conf != null && conf >= LIVE_THRESHOLD,
  });
}
