/**
 * POST /{slug}/api/encounters/{id}/finalize-upload
 *
 * Called after the browser successfully PUTs the audio to R2. We verify
 * the object exists, update the encounter row with the object key +
 * size + duration, and flip status to "processing".
 *
 * (Sprint 1.F.7 will fan out the note + CDMSS pipelines from here.)
 *
 * Body: { key, duration_seconds, deepgram_transcript?, whisper_transcript? }
 * Returns: { encounter: {id, status} }
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { headObject } from "@/lib/r2";
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
      `cannot_finalize_in_status_${row.status}`,
    );
  }

  // Parse body
  let body: {
    key?: string;
    duration_seconds?: number;
    deepgram_transcript?: string;
    whisper_transcript?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  if (typeof body.key !== "string" || !body.key.startsWith("encounters/")) {
    return respondError("VALIDATION_FAILED", "bad_key");
  }

  // Confirm object exists in R2
  const head = await headObject(body.key);
  if (head.size === null) {
    return respondError(
      "UPSTREAM_UNAVAILABLE",
      `r2_object_missing: ${body.key}`,
    );
  }
  if (head.size === 0) {
    return respondError("VALIDATION_FAILED", "uploaded_object_is_empty");
  }

  const durationSeconds =
    typeof body.duration_seconds === "number" &&
    Number.isFinite(body.duration_seconds) &&
    body.duration_seconds > 0
      ? Math.floor(body.duration_seconds)
      : null;

  // Prefer Whisper transcript when present (higher accuracy), else Deepgram raw
  const transcriptRaw =
    typeof body.whisper_transcript === "string" &&
    body.whisper_transcript.trim().length > 0
      ? body.whisper_transcript.trim()
      : typeof body.deepgram_transcript === "string"
      ? body.deepgram_transcript.trim()
      : null;

  // Update row → processing
  try {
    await sql`
      UPDATE encounter
         SET audio_object_key = ${body.key},
             audio_bytes      = ${head.size},
             duration_seconds = ${durationSeconds},
             transcript_raw   = ${transcriptRaw},
             status           = 'processing'
       WHERE id = ${id}
    `;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }

  return respondOk({
    encounter: { id, status: "processing" as const },
    audio: { key: body.key, bytes: head.size, content_type: head.content_type },
  });
}
