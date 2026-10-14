import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { sendEmail, wrapHtml } from "@/lib/email";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CATEGORIES = new Set([
  "clinical", "patient_safety", "medical_error", "professionalism",
  "documentation", "etiquette", "vendor_compliance", "other",
]);

/**
 * POST /api/public/incidents  — UNAUTHENTICATED external incident intake.
 *
 * Lets a member of the public (patient / family / external party) file a
 * concern about a doctor WITHOUT a governance login. The row lands in the
 * normal incidents stream stamped source='external_public' with the reporter's
 * self-entered name + email, NO profile/physician author, and the originating
 * IP — so a reviewer can instantly tell it from a vetted internal report and
 * the existing retract / reclassify / mark-frivolous tools can act on it.
 *
 * Must be allowlisted in middleware PUBLIC_API_ROUTES. No auth gate by design.
 *
 * Body: { target_physician_id, reporter_name, reporter_email, narrative,
 *         category?, hospital_code?, attestation }
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400, headers: NO_STORE }); }

  const target_physician_id = String(body.target_physician_id ?? "").trim();
  const reporter_name = String(body.reporter_name ?? "").trim();
  const reporter_email = String(body.reporter_email ?? "").trim();
  const narrative = String(body.narrative ?? "").trim();
  const rawCategory = String(body.category ?? "").trim();
  const hospitalCode = String(body.hospital_code ?? "").trim().toUpperCase();
  const attestation = body.attestation === true;

  if (!attestation) {
    return NextResponse.json({ ok: false, error: "Please confirm the attestation before submitting." }, { status: 400, headers: NO_STORE });
  }
  if (!target_physician_id || !UUID_RE.test(target_physician_id)) {
    return NextResponse.json({ ok: false, error: "Please select the doctor your report is about." }, { status: 400, headers: NO_STORE });
  }
  if (!reporter_name || reporter_name.length < 2 || reporter_name.length > 120) {
    return NextResponse.json({ ok: false, error: "Please enter your name." }, { status: 400, headers: NO_STORE });
  }
  if (!reporter_email || !EMAIL_RE.test(reporter_email) || reporter_email.length > 200) {
    return NextResponse.json({ ok: false, error: "Please enter a valid email address." }, { status: 400, headers: NO_STORE });
  }
  if (!narrative || narrative.length < 10) {
    return NextResponse.json({ ok: false, error: "Please describe what happened (at least a sentence)." }, { status: 400, headers: NO_STORE });
  }
  if (narrative.length > 8000) {
    return NextResponse.json({ ok: false, error: "Your description is too long (8000 character limit)." }, { status: 400, headers: NO_STORE });
  }
  const categoryValue: string | null = CATEGORIES.has(rawCategory) ? rawCategory : null;

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // Resolve the target physician + their active hospitals (only active physicians are reportable).
  const physRows = (await sql`
    SELECT
      p.id::text AS id, p.full_name, p.email, p.current_status,
      COALESCE(
        (SELECT json_agg(json_build_object('hospital_id', e.hospital_id::text, 'code', h.code) ORDER BY e.start_date DESC)
           FROM physician_engagements e JOIN hospitals h ON h.id = e.hospital_id
          WHERE e.physician_id = p.id AND e.status = 'active'),
        '[]'::json
      ) AS active_hospitals
    FROM physicians p WHERE p.id = ${target_physician_id}::uuid
  `) as Array<{ id: string; full_name: string; email: string | null; current_status: string; active_hospitals: Array<{ hospital_id: string; code: string }> }>;

  if (physRows.length === 0 || physRows[0].current_status !== "active") {
    return NextResponse.json({ ok: false, error: "That doctor could not be found." }, { status: 404, headers: NO_STORE });
  }
  const activeHospitals = Array.isArray(physRows[0].active_hospitals) ? physRows[0].active_hospitals : [];
  if (activeHospitals.length === 0) {
    return NextResponse.json({ ok: false, error: "That doctor is not currently active at a hospital." }, { status: 400, headers: NO_STORE });
  }
  // Pick the hospital: requested code if the doctor is engaged there, else most-recent active.
  let resolvedHospitalId = activeHospitals[0].hospital_id;
  if (hospitalCode) {
    const match = activeHospitals.find((h) => h.code === hospitalCode);
    if (match) resolvedHospitalId = match.hospital_id;
  }

  const xff = req.headers.get("x-forwarded-for") ?? "";
  const ip = xff.split(",")[0].trim() || null;

  const inserted = (await sql`
    INSERT INTO incidents (
      target_physician_id, submitted_from_ip, submitter_user_id, submitter_physician_id,
      submitter_position_at_time, anonymous_flag, hospital_id, polarity, source,
      category, severity, narrative, reporter_name, reporter_email
    ) VALUES (
      ${target_physician_id}::uuid,
      ${ip},
      NULL,
      NULL,
      'external_public',
      false,
      ${resolvedHospitalId}::uuid,
      'negative',
      'external_public',
      ${categoryValue},
      NULL,
      ${narrative},
      ${reporter_name},
      ${reporter_email}
    )
    RETURNING id::text AS id, submitted_at
  `) as Array<{ id: string; submitted_at: string }>;

  // Audit — actor is NULL (no internal profile); reporter identity + IP preserved.
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, actor_ip, action, entity_type, entity_id, after_json)
    VALUES (
      NULL, ${ip}, 'create', 'incident', ${inserted[0].id},
      ${JSON.stringify({
        source: "external_public",
        target_physician_id,
        target_physician_name: physRows[0].full_name,
        reporter_name,
        reporter_email,
        category: categoryValue,
      })}::jsonb
    )
  `;

  // Best-effort notify the target physician (anonymity-safe; gated by EMAIL_SENDING_ENABLED).
  const targetEmail = physRows[0].email;
  if (targetEmail) {
    void sendEmail({
      to: targetEmail,
      subject: "A new report has been recorded on your Even profile",
      html: wrapHtml("New report recorded", "<p>A report has been recorded on your physician profile via the public reporting channel.</p><p>Sign in to your physician portal to view the details.</p>"),
    }).catch(() => undefined);
  }

  return NextResponse.json({ ok: true, id: inserted[0].id, submitted_at: inserted[0].submitted_at }, { headers: NO_STORE });
}
