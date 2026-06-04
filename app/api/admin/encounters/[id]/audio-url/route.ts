/**
 * GET /api/admin/encounters/{id}/audio-url — presigned R2 URLs for the original
 * encounter audio (admin-only; all admins are equal, so a valid admin session is
 * the only gate). Returns a streaming play URL + an attachment download URL +
 * metadata. 404 if the encounter has no stored audio. Each access is audit-logged
 * (it's patient audio).
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { headObject, signGetUrl } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "admin sign-in required");
  let adminId = "";
  try {
    const claims = await verifyAdminJwt(cookie);
    adminId = String(claims.sub ?? claims.email ?? "admin");
  } catch {
    return respondError("AUTH_EXPIRED", "session invalid");
  }

  const { id } = await params;
  if (!id.startsWith("enc_")) return respondError("VALIDATION_FAILED", "bad_encounter_id");

  const rows = (await sql`
    SELECT audio_object_key, audio_bytes, duration_seconds
      FROM encounter WHERE id = ${id} LIMIT 1
  `) as Array<{ audio_object_key: string | null; audio_bytes: number | null; duration_seconds: number | null }>;
  const enc = rows[0];
  if (!enc) return respondError("NOT_FOUND", "encounter_not_found");
  if (!enc.audio_object_key) return respondError("NOT_FOUND", "no_audio_stored");

  // Authoritative content-type + size from R2.
  let contentType = "audio/webm";
  let bytes = enc.audio_bytes ?? 0;
  try {
    const head = await headObject(enc.audio_object_key);
    contentType = head.content_type || contentType;
    if (head.size) bytes = head.size;
  } catch { /* fall back to DB values */ }

  const ext = contentType.includes("ogg") ? "ogg" : contentType.includes("mp4") ? "mp4" : "webm";
  const filename = `${id}.${ext}`;

  let playUrl: string;
  let downloadUrl: string;
  try {
    [playUrl, downloadUrl] = await Promise.all([
      signGetUrl({ key: enc.audio_object_key, contentType }),
      signGetUrl({ key: enc.audio_object_key, downloadFilename: filename }),
    ]);
  } catch (e) {
    return respondError("PIPELINE_FAILED", `presign_failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}`);
  }

  // Audit: record that an admin accessed this encounter's audio.
  await sql`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
    VALUES ('admin', ${adminId}, 'encounter.audio_access', 'encounter', ${id},
            ${JSON.stringify({ bytes, content_type: contentType })}::jsonb)
  `.catch(() => { /* intentional: best-effort audit write */ });

  return respondOk({
    play_url: playUrl,
    download_url: downloadUrl,
    filename,
    content_type: contentType,
    bytes,
    duration_seconds: enc.duration_seconds,
  });
}
