/**
 * POST /{slug}/api/transcribe/whisper-chunk
 *
 * Server proxy for whisper.cpp on V's Mac Mini. The browser POSTs a
 * cumulative WebM/Opus blob (from time 0 to "now"); we forward it to
 * whisper.llmvinayminihome.uk/inference and return the transcript.
 *
 * Why server-side proxy (not direct browser → Mac Mini):
 *   1. Auth — we need the doctor cookie to gate access to the GPU
 *   2. CORS — the Mac Mini tunnel doesn't expose CORS to browsers
 *   3. Network — Cloudflare tunnel auth tokens stay server-side
 *
 * Body: multipart/form-data
 *   - audio: Blob (the cumulative WebM/Opus stream)
 *   - encounter_id?: string
 *   - pass_idx?: string  (sequence number, returned verbatim for client correlation)
 *
 * Returns: { text, language, duration_seconds, latency_ms, pass_idx }
 *
 * maxDuration: 60s — covers a 5-min cumulative recording on
 * whisper-large-v3-turbo (~5-8s typical, headroom for network jitter).
 */
import { NextRequest } from "next/server";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { transcribeWithWhisper } from "@/lib/whisper";
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

  // Multipart parse
  let audioBytes: Uint8Array;
  let contentType = "audio/webm";
  let passIdx = "0";
  let encounterId = "unknown";
  try {
    const form = await req.formData();
    const file = form.get("audio");
    if (!(file instanceof Blob)) {
      return respondError("VALIDATION_FAILED", "audio field missing");
    }
    contentType = file.type || "audio/webm";
    audioBytes = new Uint8Array(await file.arrayBuffer());

    const pi = form.get("pass_idx");
    if (typeof pi === "string") passIdx = pi.slice(0, 16);
    const ei = form.get("encounter_id");
    if (typeof ei === "string") encounterId = ei.slice(0, 40);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("VALIDATION_FAILED", `multipart_parse_failed: ${msg.slice(0, 120)}`);
  }

  if (audioBytes.length === 0) {
    return respondError("VALIDATION_FAILED", "empty_audio");
  }

  // Hand off to Mac Mini
  const result = await transcribeWithWhisper(audioBytes, contentType);
  if (!result.ok) {
    return respondError(
      "UPSTREAM_UNAVAILABLE",
      `whisper_failed: ${result.error}`,
    );
  }

  return respondOk({
    text: result.transcript,
    language: result.language ?? null,
    duration_seconds: result.duration_seconds ?? null,
    latency_ms: result.latency_ms,
    pass_idx: passIdx,
    encounter_id: encounterId,
    bytes: audioBytes.length,
  });
}
