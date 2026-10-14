import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";
import { getHospitalFilterId } from "@/lib/hospital-filter";
import { sendEmail, wrapHtml } from "@/lib/email";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CATEGORIES = new Set([
  "clinical", "patient_safety", "medical_error", "professionalism",
  "documentation", "etiquette", "vendor_compliance", "other",
]);
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const SOURCES = new Set(["patient", "peer", "governance"]); // governance = Site Governance Officer (Users PRD #17)
const POLARITIES = new Set(["positive", "negative"]);
const COMMENDATIONS = new Set([
  "Clinical Excellence", "Patient Experience", "Teamwork & Collaboration",
  "Teaching & Mentorship", "Going Above & Beyond",
]);

interface IncidentListRow {
  id: string;
  target_physician_id: string;
  target_physician_name: string;
  target_physician_email: string | null;
  submitted_at: string;
  // submitter exposed conditionally: shown for super_admin OR if not anonymous
  anonymous_flag: boolean;
  submitter_label: string;  // either submitter_position_at_time + email OR "Anonymous"
  hospital_code: string | null;
  category: string | null;
  severity: string | null;
  polarity: string;
  source: string;
  commendation_category: string | null;
  patient_rating: number | null;
  narrative_preview: string;
  status: string;
  retracted_at: string | null;
  retraction_reason: string | null;
  reply_count: number;
  last_reply_at: string | null;
}

/**
 * GET /api/incidents?status=&severity=&category=&physician_id=&limit=
 *
 * Returns incidents the caller is permitted to see, with submitter
 * identity masked (UI-level) when the row is anonymous and the caller
 * isn't super_admin. Submitter identity is ALWAYS preserved in
 * audit_log_v2 — this endpoint just decides what the UI displays.
 *
 * Visibility:
 *   - Super_admin sees everything
 *   - Site Medical Head sees incidents at their hospital (TODO when multi-hospital)
 *   - The target physician sees incidents about themselves (real-time)
 *   - Submitters see incidents they submitted
 *   - Others see nothing
 */
export async function GET(req: NextRequest) {
  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // Caller's flags (re-read in case JWT is stale)
  const meRows = (await sql`
    SELECT email, is_super_admin, is_site_medical_head FROM profiles_with_roles WHERE id = ${actor.profileId}::uuid
  `) as Array<{ email: string; is_super_admin: boolean; is_site_medical_head: boolean }>;
  if (meRows.length === 0) return NextResponse.json({ ok: false, error: "no profile" }, { status: 401, headers: NO_STORE });
  const me = meRows[0];

  // Map caller's email to physicians.id (if any) for self-view of incidents-about-me
  const myPhys = (await sql`SELECT id::text AS id FROM physicians WHERE lower(email) = ${me.email.toLowerCase()} LIMIT 1`) as Array<{ id: string }>;
  const myPhysicianId = myPhys[0]?.id ?? null;

  const params = req.nextUrl.searchParams;
  const status = (params.get("status") ?? "").trim();
  const severity = (params.get("severity") ?? "").trim();
  const category = (params.get("category") ?? "").trim();
  const polarity = (params.get("polarity") ?? "").trim();
  const fb_source = (params.get("source") ?? "").trim();
  const physician_id = (params.get("physician_id") ?? "").trim();
  const limit = Math.min(500, Math.max(1, parseInt(params.get("limit") ?? "100", 10) || 100));
  let hospital_id_filter = (params.get("hospital_id") ?? "").trim();
  if (!hospital_id_filter) {
    const fid = await getHospitalFilterId();
    if (fid) hospital_id_filter = fid;
  }
  const only_unviewed = (params.get("unviewed") ?? "") === "true";

  // Compose WHERE: visibility predicate + filters
  // Use a single tagged-template call. The visibility predicate is encoded as:
  //   is_super_admin OR target=me OR submitter=me
  const rows = (await sql`
    WITH incl AS (
      SELECT
        i.id::text AS id,
        i.target_physician_id::text AS target_physician_id,
        ph.full_name AS target_physician_name,
        ph.email AS target_physician_email,
        i.submitted_at,
        i.anonymous_flag,
        i.submitter_user_id::text AS submitter_user_id,
        sp.email AS submitter_email,
        i.submitter_position_at_time,
        sp2.full_name AS submitter_physician_name,
        h.code AS hospital_code,
        i.category,
        i.severity,
        i.polarity,
        i.source,
        i.reporter_name,
        i.reporter_email,
        i.commendation_category,
        i.patient_rating,
        i.narrative,
        i.status,
        i.retracted_at,
        i.retraction_reason,
        (SELECT COUNT(*)::int FROM incident_replies r WHERE r.incident_id = i.id) AS reply_count,
        (SELECT MAX(r.replied_at) FROM incident_replies r WHERE r.incident_id = i.id) AS last_reply_at
      FROM incidents i
      JOIN physicians ph ON ph.id = i.target_physician_id
      LEFT JOIN hospitals h ON h.id = i.hospital_id
      LEFT JOIN profiles sp ON sp.id = i.submitter_user_id
      LEFT JOIN physicians sp2 ON sp2.id = i.submitter_physician_id
      WHERE
        (
          ${me.is_super_admin}
          OR i.submitter_user_id = ${actor.profileId}::uuid
          OR (${myPhysicianId ?? ''} <> '' AND i.target_physician_id = ${myPhysicianId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
        )
        AND (${status} = '' OR i.status = ${status})
        AND (${severity} = '' OR i.severity = ${severity})
        AND (${category} = '' OR i.category = ${category})
        AND (${polarity} = '' OR i.polarity = ${polarity})
        AND (${fb_source} = '' OR i.source = ${fb_source})
        AND (${physician_id} = '' OR i.target_physician_id = ${physician_id || '00000000-0000-0000-0000-000000000000'}::uuid)
        AND (${hospital_id_filter} = '' OR i.hospital_id = ${hospital_id_filter || '00000000-0000-0000-0000-000000000000'}::uuid)
        AND (${only_unviewed ? 'true' : 'false'}::boolean = false OR NOT EXISTS (
          SELECT 1 FROM incident_views v WHERE v.incident_id = i.id AND v.profile_id = ${actor.profileId}::uuid
        ))
      ORDER BY i.submitted_at DESC
      LIMIT ${limit}
    )
    SELECT * FROM incl
  `) as Array<Record<string, unknown>>;

  const out: IncidentListRow[] = rows.map((r) => {
    // Admins always see the reporter (Feedback PRD #6). Physician authors resolve to their name.
    const reporterName = r.source === "external_public"
      ? `${(r.reporter_name as string) || "External reporter"} · external (unverified)${r.reporter_email ? ` · ${r.reporter_email}` : ""}`
      : r.submitter_physician_name
      ? `${r.submitter_physician_name as string} (peer)`
      : `${(r.submitter_position_at_time as string) ?? ""}${r.submitter_email ? ` · ${r.submitter_email}` : ""}`;
    return {
      id: r.id as string,
      target_physician_id: r.target_physician_id as string,
      target_physician_name: r.target_physician_name as string,
      target_physician_email: (r.target_physician_email as string | null) ?? null,
      submitted_at: r.submitted_at as string,
      anonymous_flag: Boolean(r.anonymous_flag),
      submitter_label: (reporterName.trim() || "Unknown") + (r.anonymous_flag ? " · anon to peers" : ""),
      hospital_code: (r.hospital_code as string | null) ?? null,
      category: (r.category as string | null) ?? null,
      severity: (r.severity as string | null) ?? null,
      polarity: (r.polarity as string) ?? "negative",
      source: (r.source as string) ?? "peer",
      commendation_category: (r.commendation_category as string | null) ?? null,
      patient_rating: r.patient_rating == null ? null : Number(r.patient_rating),
      narrative_preview: ((r.narrative as string) ?? "").slice(0, 240),
      status: r.status as string,
      retracted_at: (r.retracted_at as string | null) ?? null,
      retraction_reason: (r.retraction_reason as string | null) ?? null,
      reply_count: Number(r.reply_count ?? 0),
      last_reply_at: (r.last_reply_at as string | null) ?? null,
    };
  });

  // Counts for the inbox header (status × severity)
  const counts = (await sql`
    SELECT status, severity, COUNT(*)::int AS n
    FROM incidents i
    WHERE (
      ${me.is_super_admin}
      OR i.submitter_user_id = ${actor.profileId}::uuid
      OR (${myPhysicianId ?? ''} <> '' AND i.target_physician_id = ${myPhysicianId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
    )
    GROUP BY status, severity
  `) as Array<{ status: string; severity: string; n: number }>;

  return NextResponse.json({ ok: true, rows: out, counts, total: out.length }, { headers: NO_STORE });
}

/**
 * POST /api/incidents  — submit a new incident
 *
 * Body: { target_physician_id, anonymous_flag, category, severity, narrative,
 *         evidence_urls?, attestation }
 *
 * Identity is ALWAYS recorded: submitter_user_id (from JWT) + IP +
 * submitter_position_at_time (from JWT). The anonymous_flag only affects
 * UI display; audit_log_v2 always sees the real submitter.
 */
export async function POST(req: NextRequest) {
  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const {
    target_physician_id,
    anonymous_flag,
    category,
    severity,
    narrative,
    evidence_urls,
    attestation,
    hospital_id: bodyHospitalId,   // v3.0d — required from step-3 picker
    polarity: bodyPolarity,
    source: bodySource,
    commendation_category: bodyCommendation,
    patient_rating: bodyRating,
    patient_ref: bodyPatientRef,
  } = body ?? {};

  // Feedback PRD: polarity + source drive which fields are required.
  const polarity = typeof bodyPolarity === "string" && POLARITIES.has(bodyPolarity) ? bodyPolarity : "negative";
  const source = typeof bodySource === "string" && SOURCES.has(bodySource) ? bodySource : "peer";

  if (!attestation) {
    return NextResponse.json({ ok: false, error: "attestation required" }, { status: 400, headers: NO_STORE });
  }
  if (!target_physician_id || !UUID_RE.test(target_physician_id)) {
    return NextResponse.json({ ok: false, error: "valid target_physician_id required" }, { status: 400, headers: NO_STORE });
  }
  // Negative rows carry severity + category; positive rows carry a commendation category instead.
  let commendationValue: string | null = null;
  let severityValue: string | null = null;
  let categoryValue: string | null = null;
  if (polarity === "negative") {
    if (!category || !CATEGORIES.has(category)) {
      return NextResponse.json({ ok: false, error: "category must be one of the 8 allowed" }, { status: 400, headers: NO_STORE });
    }
    if (!severity || !SEVERITIES.has(severity)) {
      return NextResponse.json({ ok: false, error: "severity must be low|medium|high|critical" }, { status: 400, headers: NO_STORE });
    }
    severityValue = severity;
    categoryValue = category;
  } else {
    if (!bodyCommendation || !COMMENDATIONS.has(bodyCommendation)) {
      return NextResponse.json({ ok: false, error: "commendation_category required for positive feedback" }, { status: 400, headers: NO_STORE });
    }
    commendationValue = bodyCommendation;
  }
  let ratingValue: number | null = null;
  if (source === "patient" && bodyRating != null && bodyRating !== "") {
    const n = Number(bodyRating);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      return NextResponse.json({ ok: false, error: "patient_rating must be an integer 1-5" }, { status: 400, headers: NO_STORE });
    }
    ratingValue = n;
  }
  const patientRefValue: string | null = (source === "patient" && typeof bodyPatientRef === "string" && bodyPatientRef.trim())
    ? bodyPatientRef.trim() : null;
  if (!narrative || typeof narrative !== "string" || !narrative.trim()) {
    return NextResponse.json({ ok: false, error: "narrative required" }, { status: 400, headers: NO_STORE });
  }
  const urls: string[] = Array.isArray(evidence_urls)
    ? evidence_urls.filter((u: unknown) => typeof u === "string" && (u as string).trim().length > 0).slice(0, 10)
    : [];

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // Feedback PRD #9/#17: only admins (super_admin / SMH / HR) file from this surface.
  const callerRows = (await sql`SELECT is_super_admin, is_site_medical_head, is_hr, is_sgc_member FROM profiles_with_roles WHERE id = ${actor.profileId}::uuid LIMIT 1`) as Array<{ is_super_admin: boolean; is_site_medical_head: boolean; is_hr: boolean; is_sgc_member: boolean }>;
  const caller = callerRows[0];
  if (!caller) return NextResponse.json({ ok: false, error: "Not permitted" }, { status: 403, headers: NO_STORE });
  // Feedback PRD permission matrix: governance = SGO + super_admin; patient/peer = super_admin / SMH / HR.
  const allowedToFile = source === "governance"
    ? (caller.is_super_admin || caller.is_sgc_member)
    : (caller.is_super_admin || caller.is_site_medical_head || caller.is_hr);
  if (!allowedToFile) {
    return NextResponse.json({ ok: false, error: source === "governance" ? "Governance feedback is filed by Site Governance Officers (or super admins)." : "Not permitted to file feedback from this surface" }, { status: 403, headers: NO_STORE });
  }

  // v3.0d: hospital_id is required on submit (PRD §D.2). Resolve + validate
  // against the target physician's active engagements.
  // - If client passes hospital_id, verify physician is engaged there.
  // - If not, fall back to most-recent-active engagement (auto-derive).
  const physRows = (await sql`
    SELECT
      p.id::text AS id, p.full_name, p.email,
      COALESCE(
        (SELECT json_agg(e.hospital_id::text ORDER BY e.start_date DESC)
           FROM physician_engagements e
          WHERE e.physician_id = p.id AND e.status='active'),
        '[]'::json
      ) AS active_hospital_ids
    FROM physicians p WHERE p.id = ${target_physician_id}::uuid
  `) as Array<{ id: string; full_name: string; email: string | null; active_hospital_ids: string[] }>;
  if (physRows.length === 0) return NextResponse.json({ ok: false, error: "target_physician not found" }, { status: 404, headers: NO_STORE });
  const activeHospitalIds = Array.isArray(physRows[0].active_hospital_ids) ? physRows[0].active_hospital_ids : [];

  let resolvedHospitalId: string;
  if (bodyHospitalId && typeof bodyHospitalId === "string") {
    if (!UUID_RE.test(bodyHospitalId)) {
      return NextResponse.json({ ok: false, error: "hospital_id must be a valid uuid" }, { status: 400, headers: NO_STORE });
    }
    // Super admin can override; otherwise must match an engagement
    const meRows = (await sql`SELECT is_super_admin FROM profiles_with_roles WHERE id = ${actor.profileId}::uuid LIMIT 1`) as Array<{ is_super_admin: boolean }>;
    const isSuper = meRows.length > 0 && meRows[0].is_super_admin;
    if (!isSuper && !activeHospitalIds.includes(bodyHospitalId)) {
      return NextResponse.json({ ok: false, error: "Target physician is not engaged at that hospital. Pick one of their engaged hospitals or ask a super_admin to override." }, { status: 400, headers: NO_STORE });
    }
    resolvedHospitalId = bodyHospitalId;
  } else {
    if (activeHospitalIds.length === 0) {
      return NextResponse.json({ ok: false, error: "Target physician has no active engagements; cannot infer a hospital. Pick one explicitly." }, { status: 400, headers: NO_STORE });
    }
    resolvedHospitalId = activeHospitalIds[0]; // most recent active
  }
  const ph = [{ id: physRows[0].id, full_name: physRows[0].full_name, email: physRows[0].email, hospital_id: resolvedHospitalId }];

  // Best-effort IP from x-forwarded-for; if behind a proxy chain take the first
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const ip = xff.split(",")[0].trim() || null;

  const inserted = (await sql`
    INSERT INTO incidents (
      target_physician_id, submitted_from_ip, submitter_user_id, submitter_position_at_time,
      anonymous_flag, hospital_id, polarity, source, category, severity,
      commendation_category, patient_rating, patient_ref, narrative, evidence_urls
    ) VALUES (
      ${target_physician_id}::uuid,
      ${ip},
      ${actor.profileId}::uuid,
      ${actor.position_label},
      ${Boolean(anonymous_flag)},
      ${ph[0].hospital_id}::uuid,
      ${polarity},
      ${source},
      ${categoryValue},
      ${severityValue},
      ${commendationValue},
      ${ratingValue},
      ${patientRefValue},
      ${String(narrative).trim()},
      ${urls.length > 0 ? urls : null}
    )
    RETURNING id::text AS id, target_physician_id::text AS target_physician_id, submitted_at, anonymous_flag, polarity, source, category, severity, status
  `) as Array<Record<string, unknown>>;

  // Audit row — captures the REAL submitter identity even for anonymous incidents
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, actor_ip, action, entity_type, entity_id, after_json)
    VALUES (
      ${actor.profileId}::uuid,
      ${ip},
      'create',
      'incident',
      ${inserted[0].id as string},
      ${JSON.stringify({
        physician_id: target_physician_id,
        target_physician_name: ph[0].full_name,
        anonymous_flag: Boolean(anonymous_flag),
        polarity,
        source,
        category: categoryValue,
        severity: severityValue,
        commendation_category: commendationValue,
        submitter_email: actor.email,
        submitter_position: actor.position_label,
      })}::jsonb
    )
  `;
  // N.1 — notify the target physician. Anonymity-safe: never names the reporter or
  // includes the narrative; the doctor signs in to the portal for details. Best-effort,
  // gated by EMAIL_SENDING_ENABLED (logs while disabled). Doesn't block the response.
  if (ph[0].email) {
    const kind = polarity === "positive" ? "positive feedback" : "a report";
    void sendEmail({
      to: ph[0].email as string,
      subject: `New ${polarity === "positive" ? "feedback" : "report"} on your Even profile`,
      html: wrapHtml("New feedback recorded", `<p>${kind.charAt(0).toUpperCase() + kind.slice(1)} has been recorded on your physician profile.</p><p>Sign in to your physician portal to view the details.</p>`),
    }).catch(() => undefined);
  }

  return NextResponse.json({ ok: true, incident: inserted[0] }, { headers: NO_STORE });
}
