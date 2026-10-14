import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// CR.2: triggers permitted from the physician-profile "Trigger FPPE" CTA.
// VC trigger is excluded — that flow starts at /onboarding/new with a prospective
// invite, not from the existing physician's profile.
const PROFILE_TRIGGERS = new Set([
  "new_employed_provisional",
  "special_privilege_request",
  "concern_raised",
]);

/**
 * POST /api/physicians/[id]/fppe
 *
 * Trigger a Focused Professional Practice Evaluation on an EXISTING physician.
 * Creates a vc_prescreens row pre-populated from the physician, with stage
 * already at 'observation' (skips the prescreen-invite stage entirely because
 * this isn't an outside hire). The first vc_observation_cases row written
 * against this prescreen will adopt the trigger from request body.
 *
 * Permission: super_admin, OR site_medical_head at the chosen hospital, OR
 * hr at the chosen hospital (HR can file FPPE per PRD §C.12).
 *
 * Body: {
 *   trigger:      'new_employed_provisional' | 'special_privilege_request' | 'concern_raised'
 *   hospital_code: must match one of physician's engaged hospitals
 *   notes:         optional free-text (stored in vc_prescreens.red_flags for now)
 * }
 *
 * Returns: { ok, prescreen_id, trigger, cases_required }
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const { trigger, hospital_code, notes } = body ?? {};

  if (!trigger || typeof trigger !== "string" || !PROFILE_TRIGGERS.has(trigger)) {
    return NextResponse.json(
      { ok: false, error: "trigger must be new_employed_provisional | special_privilege_request | concern_raised" },
      { status: 400, headers: NO_STORE },
    );
  }
  if (!hospital_code || typeof hospital_code !== "string") {
    return NextResponse.json({ ok: false, error: "hospital_code required" }, { status: 400, headers: NO_STORE });
  }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // Load physician
  const physRows = (await sql`
    SELECT id::text AS id, full_name, primary_specialty, email
    FROM physicians WHERE id = ${id}::uuid
  `) as Array<{ id: string; full_name: string; primary_specialty: string | null; email: string | null }>;
  if (physRows.length === 0) return NextResponse.json({ ok: false, error: "physician not found" }, { status: 404, headers: NO_STORE });
  const phys = physRows[0];

  // Resolve hospital + verify physician is engaged there
  const hospRows = (await sql`
    SELECT id::text AS id, code FROM hospitals WHERE code = ${hospital_code.toUpperCase()} AND is_active = true LIMIT 1
  `) as Array<{ id: string; code: string }>;
  if (hospRows.length === 0) {
    return NextResponse.json({ ok: false, error: `hospital ${hospital_code} not active` }, { status: 400, headers: NO_STORE });
  }
  const hosp = hospRows[0];

  const engOk = (await sql`
    SELECT 1 FROM physician_engagements
    WHERE physician_id = ${id}::uuid AND hospital_id = ${hosp.id}::uuid
    LIMIT 1
  `) as Array<unknown>;
  if (engOk.length === 0) {
    return NextResponse.json(
      { ok: false, error: `physician has no engagement at ${hosp.code} — pick a hospital where they're already engaged` },
      { status: 400, headers: NO_STORE },
    );
  }

  // Permission: super_admin OR site_medical_head/hr at hosp
  const me = (await sql`
    SELECT
      p.is_super_admin,
      EXISTS (SELECT 1 FROM profile_hospital_roles r WHERE r.profile_id = p.id AND r.hospital_id = ${hosp.id}::uuid AND r.role = 'site_medical_head') AS smh_here,
      EXISTS (SELECT 1 FROM profile_hospital_roles r WHERE r.profile_id = p.id AND r.hospital_id = ${hosp.id}::uuid AND r.role = 'hr') AS hr_here
    FROM profiles p WHERE p.id = ${actor.profileId}::uuid
  `) as Array<{ is_super_admin: boolean; smh_here: boolean; hr_here: boolean }>;
  if (me.length === 0 || !(me[0].is_super_admin || me[0].smh_here || me[0].hr_here)) {
    return NextResponse.json(
      { ok: false, error: "Requires super_admin, site_medical_head, or HR at the chosen hospital" },
      { status: 403, headers: NO_STORE },
    );
  }

  // Quick guard: don't allow stacking another FPPE while one is already open
  // at the same physician+hospital+trigger. (Concern_raised after a prior
  // resolution is fine — only block if there's an OPEN one with the same
  // trigger.)
  const openExists = (await sql`
    SELECT v.id::text AS id FROM vc_prescreens v
    WHERE v.physician_id = ${id}::uuid
      AND v.hospital_id = ${hosp.id}::uuid
      AND v.stage IN ('observation','decision')
      AND EXISTS (
        SELECT 1 FROM vc_observation_cases c
        WHERE c.prescreen_id = v.id AND c.trigger = ${trigger}
      )
    LIMIT 1
  `) as Array<{ id: string }>;
  if (openExists.length > 0) {
    return NextResponse.json(
      { ok: false, error: `An FPPE with trigger '${trigger}' is already open for this physician at ${hosp.code}.`, existing_prescreen_id: openExists[0].id },
      { status: 409, headers: NO_STORE },
    );
  }

  // Create the prescreen row at stage='observation' (skip the prescreen-invite step)
  const newRows = (await sql`
    INSERT INTO vc_prescreens (
      prospective_email, prospective_full_name, prospective_specialty,
      hospital_id, decision, stage, prescreened_by, physician_id,
      red_flags, commitments_acknowledged
    ) VALUES (
      ${(phys.email ?? "fppe-internal@even.in").toLowerCase()},
      ${phys.full_name},
      ${phys.primary_specialty},
      ${hosp.id}::uuid,
      'invite',
      'observation',
      ${actor.profileId}::uuid,
      ${id}::uuid,
      ${typeof notes === "string" && notes.trim() ? notes.trim() : null},
      ${JSON.stringify({ fppe_from_profile: true, trigger })}::jsonb
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const prescreenId = newRows[0].id;

  // Write the single-hospital prescreen_hospitals row so the observation POST
  // validation (which checks vc_prescreen_hospitals) passes.
  await sql`
    INSERT INTO vc_prescreen_hospitals (prescreen_id, hospital_id)
    VALUES (${prescreenId}::uuid, ${hosp.id}::uuid)
    ON CONFLICT DO NOTHING
  `;

  // Audit
  const CASES_REQUIRED: Record<string, number> = {
    new_employed_provisional: 5,
    special_privilege_request: 3,
    concern_raised: 5,
  };
  const minRequired = CASES_REQUIRED[trigger] ?? 3;
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (
      ${actor.profileId}::uuid,
      'fppe_trigger',
      'vc_prescreen',
      ${prescreenId},
      ${JSON.stringify({
        physician_id: id,
        physician_name: phys.full_name,
        hospital_code: hosp.code,
        trigger,
        cases_required: minRequired,
        notes: typeof notes === "string" ? notes : null,
        seeded_via: "POST /api/physicians/[id]/fppe",
      })}::jsonb
    )
  `;

  return NextResponse.json(
    { ok: true, prescreen_id: prescreenId, trigger, cases_required: minRequired, hospital_code: hosp.code },
    { headers: NO_STORE },
  );
}
