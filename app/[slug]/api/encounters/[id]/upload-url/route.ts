/**
 * POST /{slug}/api/encounters/{id}/upload-url
 *
 * Issues a presigned PUT URL to R2 so the browser can upload the
 * consolidated audio blob directly. Bypasses Vercel function payload
 * limits and keeps the lambda short-lived.
 *
 * Body: { content_type?: string }   default "audio/webm"
 * Returns: { url, key, expires_in_seconds, method: "PUT" }
 *
 * Guards:
 *   - Doctor cookie + slug match
 *   - Encounter row exists, owned by this doctor, not deleted
 *   - Encounter status is "draft" (haven't finalized yet)
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { signPutUrl, audioObjectKey } from "@/lib/r2";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";

type EncounterRow = {
  id: string;
  doctor_id: string;
  status: "draft" | "processing" | "complete" | "failed" | "deleted";
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;

  const cookie = await readDoctorCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let claims;
  try {
    claims = await verifyDoctorJwt(cookie);
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }
  if (claims.slug !== slug) return respondError("FORBIDDEN", "Slug mismatch");
  if (!id.startsWith("enc_")) {
    return respondError("VALIDATION_FAILED", "bad_encounter_id");
  }

  // Verify ownership + draft status
  let row: EncounterRow | undefined;
  try {
    const rows = (await sql`
      SELECT id, doctor_id, status
        FROM encounter
       WHERE id = ${id} AND deleted_at IS NULL
       LIMIT 1
    `) as EncounterRow[];
    row = rows[0];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
  if (!row) return respondError("NOT_FOUND", "encounter_not_found");
  if (row.doctor_id !== claims.doctor_id) {
    return respondError("FORBIDDEN", "not_your_encounter");
  }
  if (row.status !== "draft") {
    return respondError(
      "VALIDATION_FAILED",
      `cannot_upload_in_status_${row.status}`,
    );
  }

  // Body
  let contentType = "audio/webm";
  try {
    const body = (await req.json().catch(() => ({}))) as {
      content_type?: string;
    };
    if (typeof body.content_type === "string" && body.content_type.length > 0) {
      contentType = body.content_type.slice(0, 100);
    }
  } catch {
    /* empty body fine */
  }

  const ext = contentType.includes("mp4")
    ? "mp4"
    : contentType.includes("ogg")
    ? "ogg"
    : "webm";
  const key = audioObjectKey(id, ext);

  try {
    const url = await signPutUrl({
      key,
      contentType,
      expiresInSeconds: 600,
    });
    return respondOk({
      url,
      key,
      expires_in_seconds: 600,
      method: "PUT",
      content_type: contentType,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError(
      "UPSTREAM_UNAVAILABLE",
      `r2_sign_failed: ${msg.slice(0, 150)}`,
    );
  }
}
