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
import type { AnyNote } from "@/lib/note-generation";

export const runtime = "nodejs";

type Row = {
  id: string;
  doctor_id: string;
  status: string;
  note_type: string | null;
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

  let body: Record<string, unknown> & { plan?: Record<string, unknown> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }

  let row: Row | undefined;
  try {
    const rows = (await sql`
      SELECT id, doctor_id, status, note_type FROM encounter
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

  const plan = (body.plan ?? {}) as Record<string, unknown>;
  let note: AnyNote;
  if (row.note_type === "general_medical") {
    note = {
      reason_for_visit: strOrEmpty(body.reason_for_visit),
      active_problems: strArr(body.active_problems),
      interval_history: strOrEmpty(body.interval_history),
      current_medications: strArr(body.current_medications),
      allergies: strArr(body.allergies),
      examination: strOrEmpty(body.examination),
      impression: strOrEmpty(body.impression),
      plan: {
        investigations_ordered: strArr(plan.investigations_ordered),
        treatment_changes: strArr(plan.treatment_changes),
        consultations_requested: strArr(plan.consultations_requested),
        follow_up: strOrEmpty(plan.follow_up),
      },
    };
  } else if (row.note_type === "operative_procedure") {
    const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
    const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
    const specimens = Array.isArray(body.specimens)
      ? (body.specimens as unknown[]).map((x) => {
          const ob = (x ?? {}) as Record<string, unknown>;
          const sent = strOrEmpty(ob.sent_to).toLowerCase();
          return { description: strOrEmpty(ob.description), sent_to: sent === "pathology" || sent === "discarded" ? sent : "other" };
        }).filter((z) => z.description.trim().length > 0)
      : [];
    const implants = Array.isArray(body.implants)
      ? (body.implants as unknown[]).map((x) => {
          const ob = (x ?? {}) as Record<string, unknown>;
          return { description: strOrEmpty(ob.description), catalog_or_serial: strOrEmpty(ob.catalog_or_serial) };
        }).filter((z) => z.description.trim().length > 0)
      : [];
    note = {
      procedure_date_time: strOrEmpty(body.procedure_date_time),
      surgical_specialty: strOrEmpty(body.surgical_specialty),
      pre_op_diagnosis: strOrEmpty(body.pre_op_diagnosis),
      post_op_diagnosis: strOrEmpty(body.post_op_diagnosis),
      procedure_performed: strArr(body.procedure_performed),
      surgeon: strOrEmpty(body.surgeon),
      assistants: strArr(body.assistants),
      anesthesiologist: strOrEmpty(body.anesthesiologist),
      anesthesia_type: strOrEmpty(body.anesthesia_type),
      indication: strOrEmpty(body.indication),
      findings: strOrEmpty(body.findings),
      procedure_narrative: strOrEmpty(body.procedure_narrative),
      estimated_blood_loss_ml: num(body.estimated_blood_loss_ml),
      fluids_in: strOrEmpty(body.fluids_in),
      urine_output_ml: num(body.urine_output_ml),
      specimens,
      implants,
      drains_placed: strArr(body.drains_placed),
      complications: strOrEmpty(body.complications),
      counts_correct: boolOrNull(body.counts_correct),
      antibiotic_given: strOrEmpty(body.antibiotic_given),
      disposition: strOrEmpty(body.disposition),
    };
  } else {
    note = {
      chief_complaint: strOrEmpty(body.chief_complaint),
      history_present_illness: strOrEmpty(body.history_present_illness),
      past_medical_history: strArr(body.past_medical_history),
      current_medications: strArr(body.current_medications),
      allergies: strArr(body.allergies),
      examination: strOrEmpty(body.examination),
      assessment: strOrEmpty(body.assessment),
      plan: {
        investigations: strArr(plan.investigations),
        treatment: strArr(plan.treatment),
        follow_up: strOrEmpty(plan.follow_up),
      },
    };
  }

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
