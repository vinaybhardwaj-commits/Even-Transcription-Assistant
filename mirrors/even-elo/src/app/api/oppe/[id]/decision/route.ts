import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_DECISIONS = new Set(["satisfactory", "flagged", "escalated_to_fppe"]);

/**
 * POST /api/oppe/[id]/decision
 *
 * Body: { decision: 'satisfactory'|'flagged'|'escalated_to_fppe', notes: string (required) }
 *
 * Permission: super_admin, OR site_medical_head at the OPPE's hospital.
 *
 * Effects:
 *   - satisfactory: status='satisfactory', completed_at=NOW, audit row.
 *   - flagged: status='flagged', completed_at=NOW, audit row. UI surfaces.
 *   - escalated_to_fppe: status='escalated_to_fppe', completed_at=NOW.
 *     Auto-creates a vc_prescreens row for this physician+hospital with
 *     stage='observation' + commitments_acknowledged={fppe_from_profile,
 *     trigger:'concern_raised'} so the observations endpoint correctly
 *     adopts concern_raised threshold (5 cases) per CR.2.
 *
 * One-shot: refuses if OPPE is already in a final state.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const { decision, notes } = body ?? {};
  if (!decision || !ALLOWED_DECISIONS.has(decision)) {
    return NextResponse.json({ ok: false, error: "decision must be satisfactory|flagged|escalated_to_fppe" }, { status: 400, headers: NO_STORE });
  }
  if (!notes || typeof notes !== "string" || !notes.trim()) {
    return NextResponse.json({ ok: false, error: "notes required (audited)" }, { status: 400, headers: NO_STORE });
  }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // Load OPPE
  const oppeRows = (await sql`
    SELECT
      o.id::text AS id,
      o.physician_id::text AS physician_id,
      p.full_name AS physician_name,
      p.primary_specialty,
      o.hospital_id::text AS hospital_id,
      h.code AS hospital_code,
      o.status
    FROM oppe_reviews o
    JOIN physicians p ON p.id = o.physician_id
    JOIN hospitals h  ON h.id = o.hospital_id
    WHERE o.id = ${id}::uuid
  `) as Array<{ id: string; physician_id: string; physician_name: string; primary_specialty: string | null; hospital_id: string; hospital_code: string; status: string }>;
  if (oppeRows.length === 0) return NextResponse.json({ ok: false, error: "OPPE not found" }, { status: 404, headers: NO_STORE });
  const o = oppeRows[0];

  if (["satisfactory", "flagged", "escalated_to_fppe"].includes(o.status)) {
    return NextResponse.json({ ok: false, error: `OPPE already in final state '${o.status}'` }, { status: 409, headers: NO_STORE });
  }

  // Permission gate
  const me = (await sql`
    SELECT
      p.is_super_admin,
      EXISTS (SELECT 1 FROM profile_hospital_roles r WHERE r.profile_id = p.id AND r.hospital_id = ${o.hospital_id}::uuid AND r.role = 'site_medical_head') AS smh_here
    FROM profiles p WHERE p.id = ${actor.profileId}::uuid
  `) as Array<{ is_super_admin: boolean; smh_here: boolean }>;
  if (me.length === 0 || !(me[0].is_super_admin || me[0].smh_here)) {
    return NextResponse.json(
      { ok: false, error: "Requires super_admin or site_medical_head at the OPPE's hospital" },
      { status: 403, headers: NO_STORE },
    );
  }

  // Update OPPE row
  await sql`
    UPDATE oppe_reviews SET
      status         = ${decision},
      reviewer_id    = ${actor.profileId}::uuid,
      decision_notes = ${notes.trim()},
      completed_at   = NOW()
    WHERE id = ${id}::uuid
  `;

  // Escalation branch — create a concern_raised FPPE prescreen.
  let escalatedPrescreenId: string | null = null;
  if (decision === "escalated_to_fppe") {
    const physRows = (await sql`
      SELECT email FROM physicians WHERE id = ${o.physician_id}::uuid LIMIT 1
    `) as Array<{ email: string | null }>;
    const psEmail = (physRows[0]?.email ?? "fppe-internal@even.in").toLowerCase();

    const newPs = (await sql`
      INSERT INTO vc_prescreens (
        prospective_email, prospective_full_name, prospective_specialty,
        hospital_id, decision, stage, prescreened_by, physician_id,
        red_flags, commitments_acknowledged
      ) VALUES (
        ${psEmail},
        ${o.physician_name},
        ${o.primary_specialty},
        ${o.hospital_id}::uuid,
        'invite',
        'observation',
        ${actor.profileId}::uuid,
        ${o.physician_id}::uuid,
        ${`Escalated from OPPE ${id}: ${notes.trim()}`},
        ${JSON.stringify({ fppe_from_profile: true, trigger: "concern_raised", source_oppe_id: id })}::jsonb
      )
      RETURNING id::text AS id
    `) as Array<{ id: string }>;
    escalatedPrescreenId = newPs[0].id;
    await sql`
      INSERT INTO vc_prescreen_hospitals (prescreen_id, hospital_id)
      VALUES (${escalatedPrescreenId}::uuid, ${o.hospital_id}::uuid)
      ON CONFLICT DO NOTHING
    `;
  }

  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (
      ${actor.profileId}::uuid,
      ${`oppe_decision_${decision}`},
      'oppe_review',
      ${id},
      ${JSON.stringify({
        physician_id: o.physician_id,
        hospital_code: o.hospital_code,
        decision,
        notes: notes.trim(),
        escalated_prescreen_id: escalatedPrescreenId,
      })}::jsonb
    )
  `;

  return NextResponse.json(
    { ok: true, decision, escalated_prescreen_id: escalatedPrescreenId },
    { headers: NO_STORE },
  );
}
