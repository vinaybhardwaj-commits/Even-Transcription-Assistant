import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_DECISIONS = new Set(["confirm_privileges", "extend_observation", "terminate"]);

/**
 * POST /api/vc-onboarding/prescreens/[id]/decision
 *
 * Body: { decision: 'confirm_privileges'|'extend_observation'|'terminate', rationale }
 *
 * Gated to super_admin OR is_site_medical_head.
 *
 * Effects per decision:
 *   confirm_privileges  → creates physicians + physician_engagements (visiting_consultant,
 *                          status='active', start_date=today). Links prescreen.physician_id.
 *                          Sets stage='onboarded'. Audit row.
 *   extend_observation  → stage back to 'observation' (cap stays at 5 cases). Audit row.
 *   terminate           → stage='terminated'. Audit row.
 *
 * One-shot: refuses if stage already 'onboarded' or 'terminated'.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const { decision, rationale } = body ?? {};
  if (!decision || !ALLOWED_DECISIONS.has(decision)) {
    return NextResponse.json({ ok: false, error: "decision must be confirm_privileges | extend_observation | terminate" }, { status: 400, headers: NO_STORE });
  }
  if (!rationale || !String(rationale).trim()) {
    return NextResponse.json({ ok: false, error: "rationale required" }, { status: 400, headers: NO_STORE });
  }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // Role gate per PRD §C.12: super_admin OR site_medical_head at the
  // prescreen's hospital (or any of its multi-site hospitals for v3.0e
  // multi-site VC prescreens). NOT a network-wide SMH check.
  const me = (await sql`
    SELECT
      p.is_super_admin,
      EXISTS (
        SELECT 1 FROM profile_hospital_roles ph
        JOIN vc_prescreens v ON v.id = ${id}::uuid
        WHERE ph.profile_id = p.id
          AND ph.role = 'site_medical_head'
          AND (
            ph.hospital_id = v.hospital_id
            OR ph.hospital_id IN (SELECT hospital_id FROM vc_prescreen_hospitals WHERE prescreen_id = ${id}::uuid)
          )
      ) AS smh_at_prescreen_hospital
    FROM profiles p WHERE p.id = ${actor.profileId}::uuid
  `) as Array<{ is_super_admin: boolean; smh_at_prescreen_hospital: boolean }>;
  if (me.length === 0 || !(me[0].is_super_admin || me[0].smh_at_prescreen_hospital)) {
    return NextResponse.json({ ok: false, error: "Decision requires super_admin or Site Medical Head at the prescreen's hospital(s)" }, { status: 403, headers: NO_STORE });
  }

  // Load the prescreen
  const psRows = (await sql`
    SELECT id::text AS id, prospective_email, prospective_full_name, prospective_specialty,
           hospital_id::text AS hospital_id, stage, physician_id::text AS physician_id
    FROM vc_prescreens WHERE id = ${id}::uuid
  `) as Array<{ id: string; prospective_email: string; prospective_full_name: string; prospective_specialty: string | null; hospital_id: string; stage: string; physician_id: string | null }>;
  if (psRows.length === 0) return NextResponse.json({ ok: false, error: "prescreen not found" }, { status: 404, headers: NO_STORE });
  const ps = psRows[0];

  // Final stages are one-shot
  if (ps.stage === "onboarded" || ps.stage === "terminated") {
    return NextResponse.json({ ok: false, error: `Cannot override stage '${ps.stage}'` }, { status: 409, headers: NO_STORE });
  }
  // Decision must come from observation or decision stage
  if (!["observation", "decision"].includes(ps.stage)) {
    return NextResponse.json({ ok: false, error: `Decision not allowed in stage '${ps.stage}'` }, { status: 409, headers: NO_STORE });
  }

  let newStage: string = ps.stage;
  let physicianId: string | null = ps.physician_id;
  let engagementId: string | null = null;

  if (decision === "confirm_privileges") {
    // CR.2: if the prescreen is a profile-triggered FPPE (physician_id already
    // set), 'Confirm privileges' means 'FPPE Satisfactory'. Don't create a new
    // engagement — physician + engagement already exist. Just advance and audit.
    if (ps.physician_id) {
      physicianId = ps.physician_id;
      await sql`
        UPDATE vc_prescreens SET stage='onboarded', decided_at=NOW(), updated_at=NOW()
        WHERE id = ${id}::uuid
      `;
      newStage = "onboarded";
    } else {
      // Original VC-onboarding path: create physician (or reuse if email maps
      // to one — defensive), then engagements at all hospitals on prescreen.
      const existing = (await sql`SELECT id::text AS id FROM physicians WHERE lower(email) = ${ps.prospective_email.toLowerCase()} LIMIT 1`) as Array<{ id: string }>;
      if (existing.length > 0) {
        physicianId = existing[0].id;
      } else {
        const newPhys = (await sql`
          INSERT INTO physicians (full_name, primary_specialty, email, date_joined_network, current_status)
          VALUES (${ps.prospective_full_name}, ${ps.prospective_specialty}, ${ps.prospective_email}, CURRENT_DATE, 'active')
          RETURNING id::text AS id
        `) as Array<{ id: string }>;
        physicianId = newPhys[0].id;
      }

      // v3.0e: create engagements at ALL hospitals on the prescreen (multi-site).
      const sites = (await sql`
        SELECT vph.hospital_id::text AS hospital_id, h.code AS hospital_code
        FROM vc_prescreen_hospitals vph
        JOIN hospitals h ON h.id = vph.hospital_id
        WHERE vph.prescreen_id = ${id}::uuid
        ORDER BY h.code
      `) as Array<{ hospital_id: string; hospital_code: string }>;
      const targetSites = sites.length > 0 ? sites : [{ hospital_id: ps.hospital_id as string, hospital_code: "" }];
      const createdEngagements: string[] = [];
      for (const site of targetSites) {
        const exists = (await sql`
          SELECT 1 FROM physician_engagements
          WHERE physician_id = ${physicianId}::uuid AND hospital_id = ${site.hospital_id}::uuid AND status = 'active'
          LIMIT 1
        `) as Array<unknown>;
        if (exists.length > 0) continue;
        const eng = (await sql`
          INSERT INTO physician_engagements (
            physician_id, hospital_id, category, start_date, specialty, status
          ) VALUES (
            ${physicianId}::uuid, ${site.hospital_id}::uuid, 'visiting_consultant',
            CURRENT_DATE, ${ps.prospective_specialty}, 'active'
          )
          RETURNING id::text AS id
        `) as Array<{ id: string }>;
        createdEngagements.push(eng[0].id);
        if (!engagementId) engagementId = eng[0].id;
      }

      await sql`
        UPDATE vc_prescreens SET stage='onboarded', physician_id=${physicianId}::uuid, decided_at=NOW(), updated_at=NOW()
        WHERE id = ${id}::uuid
      `;
      newStage = "onboarded";
    }
  } else if (decision === "extend_observation") {
    await sql`UPDATE vc_prescreens SET stage='observation', updated_at=NOW() WHERE id = ${id}::uuid`;
    newStage = "observation";
  } else if (decision === "terminate") {
    await sql`UPDATE vc_prescreens SET stage='terminated', decided_at=NOW(), updated_at=NOW() WHERE id = ${id}::uuid`;
    newStage = "terminated";
  }

  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, before_json, after_json)
    VALUES (
      ${actor.profileId}::uuid,
      ${`decision_${decision}`},
      'vc_prescreen',
      ${id},
      ${JSON.stringify({ stage: ps.stage, physician_id: ps.physician_id })}::jsonb,
      ${JSON.stringify({
        stage: newStage,
        physician_id: physicianId,
        engagement_id: engagementId,
        rationale: String(rationale).trim(),
      })}::jsonb
    )
  `;

  return NextResponse.json(
    { ok: true, decision, stage: newStage, physician_id: physicianId, engagement_id: engagementId },
    { headers: NO_STORE },
  );
}
