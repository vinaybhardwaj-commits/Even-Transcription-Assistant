/**
 * POST /{slug}/api/transcribe/sarvam-live
 *
 * Server proxy for Sarvam AI (multilingual testbed engine). The browser
 * sends a SHORT, self-contained, decodable webm window (<=30s of audio:
 * the MediaRecorder header chunk + a recent block of media chunks). We
 * run Sarvam transcribe (original script) AND translate (English) on it
 * in parallel and return both, plus the detected language.
 *
 * Why windows (not the cumulative delta-buffer the Whisper route uses):
 * Sarvam's sync REST caps at 30s of audio, so each call must be a bounded
 * window. The client sends NON-OVERLAPPING sequential blocks and stitches
 * the results, so there is no 30s ceiling on total recording length and
 * no batch API needed.
 *
 * Body: multipart/form-data
 *   - audio:        Blob (a decodable webm window, <=~25s)
 *   - encounter_id: string (optional, for logging)
 *   - block_idx:    string (optional, echoed)
 *
 * Returns: { block_idx, original, english, language_code, latency_ms, errors }
 * Soft-fail: a failed engine returns null for that field; never throws.
 */
import { NextRequest } from "next/server";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { sarvamTranscribe, sarvamTranslate } from "@/lib/sarvam";
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
  const blockIdx = String(form.get("block_idx") ?? "0");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return respondError("VALIDATION_FAILED", "audio_missing");
  }

  const contentType = audio.type || "audio/webm";
  const buf = Buffer.from(await audio.arrayBuffer());

  // Run both engines in parallel. Each soft-fails independently.
  const [tr, tl] = await Promise.all([
    sarvamTranscribe(buf, contentType),
    sarvamTranslate(buf, contentType),
  ]);

  const original = tr.ok ? tr.transcript : null;
  const english = tl.ok ? tl.transcript : null;
  const language_code =
    (tr.ok ? tr.languageCode : null) ?? (tl.ok ? tl.languageCode : null);
  const latency_ms = Math.max(tr.latencyMs, tl.latencyMs);

  return respondOk({
    block_idx: blockIdx,
    original,
    english,
    language_code,
    latency_ms,
    errors: {
      transcribe: tr.ok ? null : tr.error,
      translate: tl.ok ? null : tl.error,
    },
  });
}
