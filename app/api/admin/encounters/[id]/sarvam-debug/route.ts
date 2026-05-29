/**
 * TEMP DIAGNOSTIC — GET /api/admin/encounters/{id}/sarvam-debug
 * Pulls the encounter's real recorded audio from R2 and runs Sarvam on the
 * FULL file to see what the device actually produced and whether Sarvam can
 * process it. Admin-gated, read-only. REMOVE after diagnosis.
 */
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { sql } from "@/lib/db";
import { headObject, getObjectBytes } from "@/lib/r2";
import { sarvamTranscribe, sarvamTranslate } from "@/lib/sarvam";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try { await verifyAdminJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "bad"); }

  const { id } = await params;
  const rows = (await sql`SELECT audio_object_key, detected_language, transcript_original FROM encounter WHERE id = ${id} LIMIT 1`) as Array<{ audio_object_key: string | null; detected_language: string | null; transcript_original: string | null }>;
  const row = rows[0];
  if (!row?.audio_object_key) return respondError("NOT_FOUND", "no audio");

  const head = await headObject(row.audio_object_key);
  const bytes = await getObjectBytes(row.audio_object_key);
  if (!bytes) return respondError("NOT_FOUND", "audio bytes missing");

  // sniff first bytes to identify container
  const sig = Buffer.from(bytes.slice(0, 16)).toString("hex");
  const ct = head.content_type || "audio/webm";

  const [tr, tl] = await Promise.all([
    sarvamTranscribe(bytes, ct),
    sarvamTranslate(bytes, ct),
  ]);

  return respondOk({
    audio_object_key: row.audio_object_key,
    content_type: head.content_type,
    bytes: head.size,
    first16_hex: sig,
    sarvam_key_present: !!process.env.SARVAM_API_KEY,
    stored_detected_language: row.detected_language,
    stored_transcript_original: row.transcript_original,
    transcribe: tr.ok ? { ok: true, lang: tr.languageCode, text: tr.transcript.slice(0, 200) } : { ok: false, error: tr.error },
    translate: tl.ok ? { ok: true, lang: tl.languageCode, text: tl.transcript.slice(0, 200) } : { ok: false, error: tl.error },
  });
}
