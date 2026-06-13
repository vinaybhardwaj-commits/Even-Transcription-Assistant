/**
 * POST /{slug}/api/transcribe/indic-live
 *
 * Live native-script transcription via AI4Bharat IndicConformer (Mac-Mini).
 * The browser sends a SHORT, self-contained, decodable webm window plus the
 * language Sarvam has locked (IndicConformer needs an explicit IN-22 language).
 * Returns the native-script text for the parallel "original script" live box.
 * Indic-only: the adapter no-ops on English/unknown. Soft-fail: never throws.
 *
 * Body: multipart/form-data { audio: Blob, language: string, block_idx?: string }
 * Returns: { block_idx, text, language, latency_ms, error }
 */
import { NextRequest } from "next/server";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { indicconformerAdapter } from "@/lib/stt/adapters/indicconformer";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const maxDuration = 60;

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

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return respondError("VALIDATION_FAILED", "expected_multipart");
  }
  const audio = form.get("audio");
  const language = String(form.get("language") ?? "");
  const blockIdx = String(form.get("block_idx") ?? "0");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return respondError("VALIDATION_FAILED", "audio_missing");
  }

  const contentType = audio.type || "audio/webm";
  const buf = Buffer.from(await audio.arrayBuffer());
  const r = await indicconformerAdapter.transcribe(buf, { contentType, language });

  return respondOk({
    block_idx: blockIdx,
    text: r.error ? null : r.original,
    language: r.language ?? language,
    latency_ms: r.latencyMs,
    error: r.error,
  });
}
