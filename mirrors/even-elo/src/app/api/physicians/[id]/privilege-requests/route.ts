import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/physicians/[id]/privilege-requests
 *
 * List privilege requests for this physician (most recent first). Surfaces
 * the linked FPPE prescreen id when there is one.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const rows = (await sql`
    SELECT
      r.id::text AS id,
      r.physician_id::text AS physician_id,
      r.hospital_id::text AS hospital_id,
      h.code AS hospital_code,
      r.specialty,
      r.scope_text,
      r.is_core,
      r.evidence_jsonb,
      r.status,
      r.requested_by::text AS requested_by,
      rb.email AS requested_by_email,
      rb.full_name AS requested_by_name,
      r.reviewed_by::text AS reviewed_by,
      rv.email AS reviewed_by_email,
      r.decision_rationale,
      r.requested_at,
      r.decided_at,
      (
        SELECT v.id::text FROM vc_prescreens v
        WHERE v.physician_id = r.physician_id
          AND v.hospital_id = r.hospital_id
          AND (v.commitments_acknowledged ->> 'source_privilege_request_id') = r.id::text
        LIMIT 1
      ) AS linked_prescreen_id
    FROM privilege_requests r
    JOIN hospitals h ON h.id = r.hospital_id
    LEFT JOIN profiles rb ON rb.id = r.requested_by
    LEFT JOIN profiles rv ON rv.id = r.reviewed_by
    WHERE r.physician_id = ${id}::uuid
    ORDER BY
      (CASE WHEN r.status IN ('requested','under_fppe') THEN 0 ELSE 1 END),
      r.requested_at DESC
  `) as Array<Record<string, unknown>>;
  return NextResponse.json({ ok: true, rows }, { headers: NO_STORE });
}

/**
 * POST /api/physicians/[id]/privilege-requests
 *
 * File a privilege request. Per credentialing PRD §C.7:
 *   - Core privileges (is_core=true) don't go through this endpoint — they're
 *     a direct grant via /api/physicians/[id]/privileges. We refuse is_core=true
 *     here so the caller intent is unambiguous.
 *   - Special privileges (is_core=false): status='requested'. If
 *     trigger_fppe=true, also create a vc_prescreens row with
 *     commitments_acknowledged.trigger='special_privilege_request' linked back
 *     to this request id (so the approval step can require the FPPE be
 *     onboarded before granting).
 *
 * Body:
 *   hospital_code:  required, must match an active engagement of the physician
 *   specialty:      optional text
 *   scope_text:     required — describes the advanced scope being requested
 *   evidence_jsonb: optional jsonb describing training/case-vol/peer-ref
 *   trigger_fppe:   boolean (default true for Special) — auto-creates the
 *                   linked FPPE prescreen so the approve step can require it
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const { hospital_code, specialty, scope_text, evidence_jsonb, trigger_fppe } = body ?? {};

  if (body?.is_core === true) {
    return NextResponse.json({ ok: false, error: "Core privileges are granted directly via /privileges; this endpoint is for Special privilege requests." }, { status: 400, headers: NO_STORE });
  }
  if (!hospital_code || typeof hospital_code !== "string") {
    return NextResponse.json({ ok: false, error: "hospital_code required" }, { status: 400, headers: NO_STORE });
  }
  if (!scope_text || typeof scope_text !== "string" || !scope_text.trim()) {
    return NextResponse.json({ ok: false, error: "scope_text required — describe the advanced scope" }, { status: 400, headers: NO_STORE });
  }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // Validate physician + hospital + engagement
  const physRows = (await sql`SELECT id::text AS id, full_name, primary_specialty, email FROM physicians WHERE id = ${id}::uuid`) as Array<{ id: string; full_name: string; primary_specialty: string | null; email: string | null }>;
  if (physRows.length === 0) return NextResponse.json({ ok: false, error: "physician not found" }, { status: 404, headers: NO_STORE });
  const phys = physRows[0];

  const hosp = (await sql`SELECT id::text AS id, code FROM hospitals WHERE code = ${hospital_code.toUpperCase()} AND is_active = true LIMIT 1`) as Array<{ id: string; code: string }>;
  if (hosp.length === 0) return NextResponse.json({ ok: false, error: `hospital ${hospital_code} not active` }, { status: 400, headers: NO_STORE });

  const engaged = (await sql`
    SELECT 1 FROM physician_engagements
    WHERE physician_id = ${id}::uuid AND hospital_id = ${hosp[0].id}::uuid AND status = 'active'
    LIMIT 1
  `) as Array<unknown>;
  if (engaged.length === 0) {
    return NextResponse.json({ ok: false, error: `Physician has no active engagement at ${hosp[0].code}` }, { status: 400, headers: NO_STORE });
  }

  // Insert the request
  const inserted = (await sql`
    INSERT INTO privilege_requests (
      physician_id, hospital_id, specialty, scope_text, is_core,
      evidence_jsonb, status, requested_by
    ) VALUES (
      ${id}::uuid, ${hosp[0].id}::uuid,
      ${typeof specialty === "string" && specialty.trim() ? specialty.trim() : null},
      ${String(scope_text).trim()},
      false,
      ${evidence_jsonb ? JSON.stringify(evidence_jsonb) : null}::jsonb,
      'requested',
      ${actor.profileId}::uuid
    )
    RETURNING id::text AS id, status, requested_at
  `) as Array<{ id: string; status: string; requested_at: string }>;
  const requestId = inserted[0].id;

  // Optionally seed the FPPE prescreen (PRD §C.7: Special requests can require
  // a special_privilege_request FPPE before approval).
  let linkedPrescreenId: string | null = null;
  const shouldTriggerFppe = trigger_fppe !== false; // default true for Special
  if (shouldTriggerFppe) {
    const psEmail = (phys.email ?? "fppe-internal@even.in").toLowerCase();
    const ps = (await sql`
      INSERT INTO vc_prescreens (
        prospective_email, prospective_full_name, prospective_specialty,
        hospital_id, decision, stage, prescreened_by, physician_id,
        red_flags, commitments_acknowledged
      ) VALUES (
        ${psEmail},
        ${phys.full_name},
        ${phys.primary_specialty},
        ${hosp[0].id}::uuid,
        'invite',
        'observation',
        ${actor.profileId}::uuid,
        ${id}::uuid,
        ${`Linked to privilege request ${requestId} — scope: ${String(scope_text).trim().slice(0, 200)}`},
        ${JSON.stringify({
          fppe_from_profile: true,
          trigger: "special_privilege_request",
          source_privilege_request_id: requestId,
        })}::jsonb
      )
      RETURNING id::text AS id
    `) as Array<{ id: string }>;
    linkedPrescreenId = ps[0].id;
    await sql`
      INSERT INTO vc_prescreen_hospitals (prescreen_id, hospital_id)
      VALUES (${linkedPrescreenId}::uuid, ${hosp[0].id}::uuid)
      ON CONFLICT DO NOTHING
    `;
    // Move request status to under_fppe to make the requirement explicit
    await sql`UPDATE privilege_requests SET status = 'under_fppe' WHERE id = ${requestId}::uuid`;
  }

  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (
      ${actor.profileId}::uuid,
      'privilege_request_create',
      'privilege_request',
      ${requestId},
      ${JSON.stringify({
        physician_id: id,
        hospital_code: hosp[0].code,
        scope_text: String(scope_text).trim(),
        is_core: false,
        trigger_fppe: shouldTriggerFppe,
        linked_prescreen_id: linkedPrescreenId,
      })}::jsonb
    )
  `;

  return NextResponse.json(
    {
      ok: true,
      privilege_request_id: requestId,
      status: shouldTriggerFppe ? "under_fppe" : "requested",
      linked_prescreen_id: linkedPrescreenId,
    },
    { headers: NO_STORE },
  );
}
