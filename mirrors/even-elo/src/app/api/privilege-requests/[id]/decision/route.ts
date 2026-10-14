import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_DECISIONS = new Set(["approve", "deny", "withdraw"]);

/**
 * POST /api/privilege-requests/[id]/decision
 *
 * Body: { decision: 'approve'|'deny'|'withdraw', rationale: string,
 *         expires_at?: 'YYYY-MM-DD' (default NOW+1yr on approve) }
 *
 * Permission per credentialing PRD §C.12:
 *   - approve/deny: super_admin OR site_medical_head at the request's hospital
 *   - withdraw: requester only (or super_admin)
 *
 * Effects:
 *   - approve: requires the linked FPPE prescreen (if any) to be in
 *              stage='onboarded' (i.e. FPPE satisfactory). INSERTs a
 *              privileges row with is_core=false + expires_at. Status='approved'.
 *   - deny:    status='denied', captures rationale.
 *   - withdraw: status='withdrawn'. Captures rationale.
 *
 * One-shot: refuses if the request is already in a final state.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const { decision, rationale, expires_at } = body ?? {};
  if (!decision || !ALLOWED_DECISIONS.has(decision)) {
    return NextResponse.json({ ok: false, error: "decision must be approve|deny|withdraw" }, { status: 400, headers: NO_STORE });
  }
  if (!rationale || typeof rationale !== "string" || !rationale.trim()) {
    return NextResponse.json({ ok: false, error: "rationale required (audited)" }, { status: 400, headers: NO_STORE });
  }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // Load request
  const reqRows = (await sql`
    SELECT
      r.id::text AS id,
      r.physician_id::text AS physician_id,
      p.full_name AS physician_name,
      r.hospital_id::text AS hospital_id,
      h.code AS hospital_code,
      r.specialty,
      r.scope_text,
      r.status,
      r.requested_by::text AS requested_by
    FROM privilege_requests r
    JOIN physicians p ON p.id = r.physician_id
    JOIN hospitals  h ON h.id = r.hospital_id
    WHERE r.id = ${id}::uuid
  `) as Array<{ id: string; physician_id: string; physician_name: string; hospital_id: string; hospital_code: string; specialty: string | null; scope_text: string; status: string; requested_by: string }>;
  if (reqRows.length === 0) return NextResponse.json({ ok: false, error: "privilege request not found" }, { status: 404, headers: NO_STORE });
  const r = reqRows[0];

  if (["approved", "denied", "withdrawn"].includes(r.status)) {
    return NextResponse.json({ ok: false, error: `Request already in final state '${r.status}'` }, { status: 409, headers: NO_STORE });
  }

  // Permission gate
  const me = (await sql`
    SELECT
      p.is_super_admin,
      EXISTS (SELECT 1 FROM profile_hospital_roles ph WHERE ph.profile_id = p.id AND ph.hospital_id = ${r.hospital_id}::uuid AND ph.role = 'site_medical_head') AS smh_here
    FROM profiles p WHERE p.id = ${actor.profileId}::uuid
  `) as Array<{ is_super_admin: boolean; smh_here: boolean }>;
  if (me.length === 0) return NextResponse.json({ ok: false, error: "no profile" }, { status: 401, headers: NO_STORE });
  const isSuper = me[0].is_super_admin;
  const isSmhHere = me[0].smh_here;

  if (decision === "withdraw") {
    if (!isSuper && r.requested_by !== actor.profileId) {
      return NextResponse.json({ ok: false, error: "Only the requester or a super_admin can withdraw a request" }, { status: 403, headers: NO_STORE });
    }
  } else {
    // approve / deny
    if (!isSuper && !isSmhHere) {
      return NextResponse.json({ ok: false, error: "Requires super_admin or site_medical_head at the request's hospital" }, { status: 403, headers: NO_STORE });
    }
  }

  let newPrivilegeId: string | null = null;

  if (decision === "approve") {
    // If there's a linked FPPE prescreen, require it to be onboarded.
    const linked = (await sql`
      SELECT v.id::text AS id, v.stage
      FROM vc_prescreens v
      WHERE v.physician_id = ${r.physician_id}::uuid
        AND v.hospital_id = ${r.hospital_id}::uuid
        AND (v.commitments_acknowledged ->> 'source_privilege_request_id') = ${id}
      LIMIT 1
    `) as Array<{ id: string; stage: string }>;
    if (linked.length > 0 && linked[0].stage !== "onboarded") {
      return NextResponse.json(
        {
          ok: false,
          error: `Linked FPPE (prescreen ${linked[0].id}) is in stage '${linked[0].stage}' — close it as Satisfactory before approving the privilege request.`,
        },
        { status: 409, headers: NO_STORE },
      );
    }

    // Insert the privileges row. Default expires_at = NOW + 1yr if not specified.
    const finalExpiry =
      typeof expires_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(expires_at)
        ? expires_at
        : ((): string => {
            const d = new Date();
            d.setFullYear(d.getFullYear() + 1);
            return d.toISOString().slice(0, 10);
          })();

    const ins = (await sql`
      INSERT INTO privileges (
        physician_id, hospital_id, procedure_or_specialty, granted_date, granted_by,
        basis, is_core, expires_at
      ) VALUES (
        ${r.physician_id}::uuid, ${r.hospital_id}::uuid, ${r.scope_text}, CURRENT_DATE,
        ${actor.profileId}::uuid, 'case_review', false, ${finalExpiry}::date
      )
      RETURNING id::text AS id
    `) as Array<{ id: string }>;
    newPrivilegeId = ins[0].id;

    await sql`
      UPDATE privilege_requests SET
        status = 'approved',
        reviewed_by = ${actor.profileId}::uuid,
        decision_rationale = ${rationale.trim()},
        decided_at = NOW()
      WHERE id = ${id}::uuid
    `;
  } else if (decision === "deny") {
    await sql`
      UPDATE privilege_requests SET
        status = 'denied',
        reviewed_by = ${actor.profileId}::uuid,
        decision_rationale = ${rationale.trim()},
        decided_at = NOW()
      WHERE id = ${id}::uuid
    `;
  } else if (decision === "withdraw") {
    await sql`
      UPDATE privilege_requests SET
        status = 'withdrawn',
        decision_rationale = ${rationale.trim()},
        decided_at = NOW()
      WHERE id = ${id}::uuid
    `;
  }

  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (
      ${actor.profileId}::uuid,
      ${`privilege_request_${decision}`},
      'privilege_request',
      ${id},
      ${JSON.stringify({
        physician_id: r.physician_id,
        physician_name: r.physician_name,
        hospital_code: r.hospital_code,
        decision,
        rationale: rationale.trim(),
        new_privilege_id: newPrivilegeId,
      })}::jsonb
    )
  `;

  return NextResponse.json(
    { ok: true, decision, new_privilege_id: newPrivilegeId },
    { headers: NO_STORE },
  );
}
