/**
 * POST /{slug}/api/encounters/{id}/finalize-text
 *
 * The text analogue of finalize-upload: the typed-note editor sends its document
 * text; we write it as the encounter transcript (input_mode='text', no audio),
 * flip to 'processing', and kick the SAME /process step machine. translate/native/
 * diarize steps are no-ops without audio, so the note + CDMSS pipeline runs exactly
 * as it does for a dictated encounter.
 *
 * Body: { text } -> { encounter: { id, status } }
 */
import { NextRequest, after } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const maxDuration = 300;

type Row = { id: string; doctor_id: string; status: string };

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;

  const cookie = await readDoctorCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let claims;
  try { claims = await verifyDoctorJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }
  if (claims.slug !== slug) return respondError("FORBIDDEN", "Slug mismatch");
  if (!id.startsWith("enc_")) return respondError("VALIDATION_FAILED", "bad_encounter_id");

  let body: { text?: string };
  try { body = (await req.json()) as { text?: string }; } catch { return respondError("VALIDATION_FAILED", "body_not_json"); }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length < 2) return respondError("VALIDATION_FAILED", "empty_text");

  let row: Row | undefined;
  try {
    const rows = (await sql`
      SELECT id, doctor_id, status FROM encounter WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
    `) as Row[];
    row = rows[0];
  } catch (e) {
    return respondError("PIPELINE_FAILED", (e instanceof Error ? e.message : String(e)).slice(0, 150));
  }
  if (!row) return respondError("NOT_FOUND", "encounter_not_found");
  if (row.doctor_id !== claims.doctor_id) return respondError("FORBIDDEN", "not_your_encounter");
  if (row.status !== "draft") return respondError("VALIDATION_FAILED", `cannot_finalize_in_status_${row.status}`);

  // Background kick of the resumable /process step machine (mirror finalize-upload).
  let kick = false;
  if (process.env.MIGRATION_SECRET) {
    const origin = req.nextUrl.origin;
    after(async () => {
      if (!kick) return;
      try {
        const res = await fetch(`${origin}/${slug}/api/encounters/${id}/process`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "x-eta-internal": process.env.MIGRATION_SECRET as string },
          body: JSON.stringify({ step: true }),
          cache: "no-store",
        });
        await res.text().catch(() => {});
      } catch { /* the /3-min resume cron recovers stuck 'processing' rows */ }
    });
  }

  try {
    await sql`
      UPDATE encounter
         SET input_mode        = 'text',
             editor_text       = ${text},
             transcript_raw    = ${text},
             transcript_clean  = ${text},
             detected_language = 'en-IN',
             status            = 'processing'
       WHERE id = ${id}
    `;
  } catch (e) {
    return respondError("PIPELINE_FAILED", (e instanceof Error ? e.message : String(e)).slice(0, 150));
  }

  kick = true;
  return respondOk({ encounter: { id, status: "processing" as const } });
}
