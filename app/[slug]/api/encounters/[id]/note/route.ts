/**
 * PATCH /{slug}/api/encounters/{id}/note
 *
 * Writes the doctor-edited note to note_json_edited. The LLM-generated
 * note_json is preserved untouched. Email render uses
 * COALESCE(note_json_edited, note_json) so edits override automatically.
 *
 * Body: full EncounterNote JSON (same shape as note_json). We
 * defensively re-shape on write so malformed client input can't
 * corrupt the column.
 *
 * Returns: { encounter: {id, status}, note }
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import type { EncounterNote } from "@/lib/note-generation";

export const runtime = "nodejs";

type Row = {
  id: string;
  doctor_id: string;
  status: string;
};

function strOrEmpty(v: unknown): string {
  return typeof v === "string" ? v.slice(0, 8000) : "";
}
function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.slice(0, 1000))
    .slice(0, 200);
}

export async function PATCH(
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

  let body: Partial<EncounterNote> & { plan?: Partial<EncounterNote["plan"]> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }

  let row: Row | undefined;
  try {
    const rows = (await sql`
      SELECT id, doctor_id, status FROM encounter
       WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
    `) as Row[];
    row = rows[0];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
  if (!row) return respondError("NOT_FOUND", "encounter_not_found");
  if (row.doctor_id !== claims.doctor_id) {
    return respondError("FORBIDDEN", "not_your_encounter");
  }
  if (row.status === "deleted") {
    return respondError("VALIDATION_FAILED", "encounter_deleted");
  }

  const note: EncounterNote = {
    chief_complaint: strOrEmpty(body.chief_complaint),
    history_present_illness: strOrEmpty(body.history_present_illness),
    past_medical_history: strArr(body.past_medical_history),
    current_medications: strArr(body.current_medications),
    allergies: strArr(body.allergies),
    examination: strOrEmpty(body.examination),
    assessment: strOrEmpty(body.assessment),
    plan: {
      investigations: strArr(body.plan?.investigations),
      treatment: strArr(body.plan?.treatment),
      follow_up: strOrEmpty(body.plan?.follow_up),
    },
  };

  try {
    await sql`
      UPDATE encounter
         SET note_json_edited = ${JSON.stringify(note)}::jsonb,
             updated_at       = NOW()
       WHERE id = ${id}
    `;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }

  return respondOk({
    encounter: { id, status: row.status },
    note,
  });
}
