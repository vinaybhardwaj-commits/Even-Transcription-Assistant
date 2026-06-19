/**
 * POST /{slug}/api/encounters — creates a blank draft encounter row at
 * the moment the doctor lands on the Record screen.
 *
 * The route lives under [slug] because the doctor cookie is path-scoped
 * to /{slug}/ per PRD §4.15. Routes at /api/* never receive the cookie
 * because the browser respects cookie scope.
 *
 * Body: { patient_label?: string }
 * Returns: { ok: true, encounter: { id, status: 'draft' } }
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { newEncounterId } from "@/lib/encounter-id";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  // 1. Cookie + JWT verify
  const cookie = await readDoctorCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");

  let claims;
  try {
    claims = await verifyDoctorJwt(cookie);
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }

  // 2. URL slug must match JWT slug — defense in depth against cookie reuse
  if (claims.slug !== slug) {
    return respondError("FORBIDDEN", "Slug mismatch");
  }

  // 3. Body — patient_label + note_type optional (V2.S2)
  let patientLabel: string | null = null;
  let noteType: "clinic_encounter" | "general_medical" | "operative_procedure" | "dietetic_consult" | "physiotherapy" | "discharge_summary" | "opd_prescription" = "clinic_encounter";
  try {
    const body = (await req.json().catch(() => ({}))) as {
      patient_label?: string;
      note_type?: string;
    };
    if (typeof body.patient_label === "string") {
      const trimmed = body.patient_label.trim();
      patientLabel = trimmed.length > 0 ? trimmed.slice(0, 200) : null;
    }
    // Physician allow-list. Dietetic/physio/operative arrive with their
    // clinician types in later sprints; default to clinic_encounter otherwise.
    if (
      body.note_type === "general_medical" ||
      body.note_type === "clinic_encounter" ||
      body.note_type === "operative_procedure" ||
      body.note_type === "dietetic_consult" ||
      body.note_type === "physiotherapy" ||
      body.note_type === "discharge_summary" ||
      body.note_type === "opd_prescription"
    ) {
      noteType = body.note_type;
    }
  } catch {
    /* empty body is fine */
  }

  // 4. Insert
  const id = newEncounterId();
  try {
    await sql`
      INSERT INTO encounter (id, doctor_id, patient_label_raw, note_type, status, send_status)
      VALUES (${id}, ${claims.doctor_id}, ${patientLabel}, ${noteType}::note_type, 'draft', 'pending')
    `;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 200));
  }

  return respondOk({
    encounter: { id, status: "draft" as const },
  });
}


/**
 * GET /{slug}/api/encounters — list this doctor's encounters,
 * newest-first, last 50. Each row has the minimum fields the Library
 * card needs to render without a follow-up fetch.
 */
export async function GET(
  _req: NextRequest,
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

  type ListRow = {
    id: string;
    recorded_at: string | Date;
    duration_seconds: number | null;
    patient_label_raw: string | null;
    status: "draft" | "processing" | "complete" | "failed";
    send_status: "pending" | "sent" | "failed";
    processing_pct: number | null;
    note_type: string | null;
    chief_complaint: string | null;
    transcript_flag: string | null;
  };

  try {
    const rows = (await sql`
      SELECT id,
             recorded_at,
             duration_seconds,
             patient_label_raw,
             note_type,
             status,
             send_status,
             processing_pct,
             transcript_flag,
             COALESCE(
               (note_json_edited->>'chief_complaint'),
               (note_json->>'chief_complaint'),
               (note_json_edited->>'reason_for_visit'),
               (note_json->>'reason_for_visit')
             ) AS chief_complaint
        FROM encounter
       WHERE doctor_id = ${claims.doctor_id}
         AND deleted_at IS NULL
       ORDER BY recorded_at DESC
       LIMIT 50
    `) as ListRow[];

    return respondOk({
      encounters: rows.map((r) => ({
        id: r.id,
        recorded_at:
          r.recorded_at instanceof Date
            ? r.recorded_at.toISOString()
            : new Date(r.recorded_at).toISOString(),
        duration_seconds: r.duration_seconds,
        patient_label: r.patient_label_raw,
        status: r.status,
        send_status: r.send_status,
        processing_pct: r.processing_pct,
        note_type: r.note_type,
        chief_complaint: r.chief_complaint,
        transcript_flag: r.transcript_flag,
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
}
