/**
 * POST /{slug}/api/transcribe/whisper-chunk
 *
 * Server proxy for whisper.cpp on V's Mac Mini. After the B7 fix the
 * browser POSTs ONLY the NEW MediaRecorder chunks since the last
 * pass (a "delta"). We append the delta to a per-encounter R2 buffer
 * at `whisper-buffer/{encounter_id}.webm`, then forward the full
 * concatenated audio to whisper.cpp and return the transcript.
 *
 * Why this design (vs the old cumulative-from-zero client POST):
 *   - Vercel serverless functions cap incoming bodies at 4.5 MB. The
 *     cumulative blob grew linearly with recording length and hit the
 *     cap at ~3 min (~pass #17 in V's screenshots) — every pass after
 *     that returned 413 at the platform edge, the client logged
 *     "error", and the rolling badge froze at pass #17. See B7 in
 *     `Daily Dash EHRC/ETA/ETA-BUG-LOG.md`.
 *   - Deltas are small (~one pass-interval worth of audio, ~280 KB at
 *     10 s intervals), well under the platform limit, regardless of
 *     how long the recording runs.
 *
 * Body: multipart/form-data
 *   - audio:           Blob (the delta, raw MediaRecorder output for
 *                      chunks delta_start_idx..delta_end_idx)
 *   - encounter_id:    string (REQUIRED — keys the R2 buffer)
 *   - pass_idx:        string (incrementing sequence, returned verbatim)
 *   - is_first:        "1" | "0" (whether this delta starts at chunk 0;
 *                      if so we PUT the buffer instead of GET+append)
 *   - delta_start_idx: optional, for debug
 *   - delta_end_idx:   optional, for debug
 *
 * Returns: { text, language, duration_seconds, latency_ms, pass_idx,
 *            bytes (delta size), cumulative_bytes (buffer size after append) }
 *
 * maxDuration: 60 s — covers GET + PUT to R2 + Mac Mini round-trip on
 * a 5-min cumulative buffer. The R2 round-trip adds ~1-2 s vs the old
 * design; whisper.cpp inference dominates the budget regardless.
 */
import { NextRequest } from "next/server";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { transcribeWithWhisper } from "@/lib/whisper";
import {
  getObjectBytes,
  putObjectBytes,
  whisperBufferKey,
} from "@/lib/r2";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const maxDuration = 60;

// Hard safety cap on buffer size to prevent runaway storage for a
// stuck recording. 60 MB ≈ 30+ minutes of opus audio, well past any
// realistic OPD visit.
const MAX_BUFFER_BYTES = 60 * 1024 * 1024;

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
  let deltaBytes: Uint8Array;
  let contentType = "audio/webm";
  let passIdx = "0";
  let encounterId = "";
  let isFirst = false;
  try {
    const form = await req.formData();
    const file = form.get("audio");
    if (!(file instanceof Blob)) {
      return respondError("VALIDATION_FAILED", "audio field missing");
    }
    contentType = file.type || "audio/webm";
    deltaBytes = new Uint8Array(await file.arrayBuffer());

    const pi = form.get("pass_idx");
    if (typeof pi === "string") passIdx = pi.slice(0, 16);
    const ei = form.get("encounter_id");
    if (typeof ei === "string") encounterId = ei.slice(0, 40);
    const fi = form.get("is_first");
    if (typeof fi === "string") isFirst = fi === "1" || fi === "true";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("VALIDATION_FAILED", `multipart_parse_failed: ${msg.slice(0, 120)}`);
  }

  if (deltaBytes.length === 0) {
    return respondError("VALIDATION_FAILED", "empty_audio");
  }
  if (!encounterId.startsWith("enc_")) {
    return respondError("VALIDATION_FAILED", "encounter_id_required");
  }

  // Append the delta to the R2 buffer (or start a new one if this is
  // the first chunk in the recording).
  const bufKey = whisperBufferKey(encounterId);
  let combined: Uint8Array;
  if (isFirst) {
    combined = deltaBytes;
  } else {
    let existing: Uint8Array | null = null;
    try {
      existing = await getObjectBytes(bufKey);
    } catch {
      // Transient R2 read failure on an ephemeral, best-effort live-transcript
      // buffer. Don't hard-fail the whole append (which would surface an error
      // mid-consult); treat this window as a fresh buffer and keep going. The
      // saved/uploaded audio is independent of this buffer, so nothing the note
      // depends on is lost.
      existing = null;
    }
    if (!existing) {
      // No prior buffer (transient read failure, client lost state, or this is
      // really the first chunk and is_first wasn't set). Treat the delta as the
      // new buffer rather than failing — better UX.
      combined = deltaBytes;
    } else {
      combined = new Uint8Array(existing.length + deltaBytes.length);
      combined.set(existing, 0);
      combined.set(deltaBytes, existing.length);
    }
  }
  if (combined.length > MAX_BUFFER_BYTES) {
    return respondError(
      "VALIDATION_FAILED",
      `buffer_exceeds_max_${MAX_BUFFER_BYTES}_bytes`,
    );
  }
  try {
    await putObjectBytes(bufKey, combined, contentType);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", `r2_put_failed: ${msg.slice(0, 120)}`);
  }

  // Hand off to Mac Mini whisper.cpp with the full concatenated audio.
  const result = await transcribeWithWhisper(combined, contentType);
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
    bytes: deltaBytes.length,
    cumulative_bytes: combined.length,
  });
}
