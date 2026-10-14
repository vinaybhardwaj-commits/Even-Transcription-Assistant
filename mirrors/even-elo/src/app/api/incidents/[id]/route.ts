import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const meRows = (await sql`
    SELECT email, is_super_admin FROM profiles WHERE id = ${actor.profileId}::uuid
  `) as Array<{ email: string; is_super_admin: boolean }>;
  if (meRows.length === 0) return NextResponse.json({ ok: false, error: "no profile" }, { status: 401, headers: NO_STORE });
  const me = meRows[0];

  const rows = (await sql`
    SELECT
      i.id::text                              AS id,
      i.target_physician_id::text             AS target_physician_id,
      ph.full_name                            AS target_physician_name,
      ph.email                                AS target_physician_email,
      i.submitted_at,
      i.submitted_from_ip,
      i.anonymous_flag,
      i.submitter_user_id::text               AS submitter_user_id,
      sp.email                                AS submitter_email,
      i.submitter_position_at_time,
      sp2.full_name                           AS submitter_physician_name,
      h.code                                  AS hospital_code,
      i.category,
      i.severity,
      i.polarity,
      i.source,
      i.reporter_name,
      i.reporter_email,
      i.commendation_category,
      i.patient_rating,
      i.patient_ref,
      i.narrative,
      i.evidence_urls,
      i.status,
      i.retracted_by::text                    AS retracted_by,
      rp.email                                AS retracted_by_email,
      i.retracted_at,
      i.retraction_reason,
      i.created_at,
      i.updated_at
    FROM incidents i
    JOIN physicians ph ON ph.id = i.target_physician_id
    LEFT JOIN hospitals h  ON h.id = i.hospital_id
    LEFT JOIN profiles sp ON sp.id = i.submitter_user_id
    LEFT JOIN physicians sp2 ON sp2.id = i.submitter_physician_id
    LEFT JOIN profiles rp ON rp.id = i.retracted_by
    WHERE i.id = ${id}::uuid
  `) as Array<Record<string, unknown>>;

  if (rows.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });
  const i = rows[0];

  const isMine = i.submitter_user_id === actor.profileId;
  const isTarget = me.email.toLowerCase() === ((i.target_physician_email as string | null) ?? "").toLowerCase();
  // v3.0d: any SMH (network-wide) can READ all incidents per decision #12;
  //        only SMH at incident's hospital can WRITE (retract/reclassify).
  const anySmhRows = (await sql`
    SELECT 1 FROM profile_hospital_roles WHERE profile_id = ${actor.profileId}::uuid AND role = 'site_medical_head' LIMIT 1
  `) as Array<unknown>;
  const isAnySmh = anySmhRows.length > 0;
  const smhHereRows = i.hospital_code ? (await sql`
    SELECT 1 FROM profile_hospital_roles r JOIN hospitals h ON h.id = r.hospital_id
    WHERE r.profile_id = ${actor.profileId}::uuid AND r.role = 'site_medical_head' AND h.code = ${i.hospital_code as string} LIMIT 1
  `) as Array<unknown> : [];
  const isSmhHere = smhHereRows.length > 0;

  const canSee = me.is_super_admin || isMine || isTarget || isAnySmh;
  if (!canSee) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403, headers: NO_STORE });
  }

  const reporterName = i.source === "external_public"
    ? `${(i.reporter_name as string) || "External reporter"} · external (unverified)${i.reporter_email ? ` · ${i.reporter_email}` : ""}`
    : i.submitter_physician_name
    ? `${i.submitter_physician_name as string} (peer)`
    : `${(i.submitter_position_at_time as string) ?? ""}${i.submitter_email ? ` · ${i.submitter_email}` : ""}`;
  const submitter_label = (reporterName.trim() || "Unknown") + (i.anonymous_flag ? " · anon to peers" : "");

  // Replies have TWO author kinds: governance staff (replied_by_profile_id) and
  // the target physician replying from the Doctor Portal (replied_by_physician_id,
  // exactly-one enforced by CHECK). The old INNER JOIN on profiles silently
  // dropped every portal-authored right-of-reply (bug found by V, 2 Jul 2026).
  const replies = (await sql`
    SELECT
      r.id::text   AS id,
      r.reply_text,
      r.replied_at,
      COALESCE(p.email, ph3.email)                        AS replied_by_email,
      COALESCE(ph3.full_name, ph2.full_name, p.email)     AS replied_by_name
    FROM incident_replies r
    LEFT JOIN profiles p ON p.id = r.replied_by_profile_id
    LEFT JOIN physicians ph2 ON lower(ph2.email) = lower(p.email)
    LEFT JOIN physicians ph3 ON ph3.id = r.replied_by_physician_id
    WHERE r.incident_id = ${id}::uuid
    ORDER BY r.replied_at ASC
  `) as Array<Record<string, unknown>>;

  // v3.x: record per-user read state (V's locked decision — auto-clear-on-open + audit_log_v2 only, no UI surfacing of who-saw-what)
  await sql`
    INSERT INTO incident_views (incident_id, profile_id, via)
    VALUES (${id}::uuid, ${actor.profileId}::uuid, 'open')
    ON CONFLICT (incident_id, profile_id) DO NOTHING
  `;
  // Best-effort audit — don't 500 the read if logging fails
  try {
    await sql`
      INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
      VALUES (${actor.profileId}::uuid, 'view', 'incident', ${id}, ${JSON.stringify({ via: "open" })}::jsonb)
    `;
  } catch { /* swallow */ }

  return NextResponse.json(
    {
      ok: true,
      incident: {
        id: i.id,
        target_physician_id: i.target_physician_id,
        target_physician_name: i.target_physician_name,
        target_physician_email: i.target_physician_email,
        submitted_at: i.submitted_at,
        anonymous_flag: Boolean(i.anonymous_flag),
        submitter_label,
        hospital_code: i.hospital_code,
        category: i.category,
        severity: i.severity,
        polarity: i.polarity,
        source: i.source,
        commendation_category: i.commendation_category,
        patient_rating: i.patient_rating == null ? null : Number(i.patient_rating),
        patient_ref: i.patient_ref,
        narrative: i.narrative,
        evidence_urls: (i.evidence_urls as string[] | null) ?? [],
        status: i.status,
        retracted_by_email: i.retracted_by_email,
        retracted_at: i.retracted_at,
        retraction_reason: i.retraction_reason,
        created_at: i.created_at,
        updated_at: i.updated_at,
        // Capability flags for the client
        can_retract: (me.is_super_admin || isSmhHere) && i.status !== "retracted",
        can_reclassify: me.is_super_admin || isSmhHere,
        can_reply: isTarget,
        can_delete: me.is_super_admin,
      },
      replies,
    },
    { headers: NO_STORE },
  );
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // Only super_admin can PATCH (retract / reclassify)
  const meRows = (await sql`SELECT is_super_admin FROM profiles WHERE id = ${actor.profileId}::uuid`) as Array<{ is_super_admin: boolean }>;
  if (meRows.length === 0 || !meRows[0].is_super_admin) {
    return NextResponse.json({ ok: false, error: "Super admin only" }, { status: 403, headers: NO_STORE });
  }

  const body = await req.json();
  const before = (await sql`
    SELECT id::text AS id, target_physician_id::text AS target_physician_id, severity, status, retracted_at, retraction_reason FROM incidents WHERE id = ${id}::uuid
  `) as Array<Record<string, unknown>>;
  if (before.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });
  const b = before[0];

  // Two actions: retract (status='retracted' + retraction_reason) or reclassify severity
  let action: string | null = null;

  if (typeof body.severity === "string") {
    if (!SEVERITIES.has(body.severity)) {
      return NextResponse.json({ ok: false, error: "invalid severity" }, { status: 400, headers: NO_STORE });
    }
    await sql`UPDATE incidents SET severity = ${body.severity}, updated_at = NOW() WHERE id = ${id}::uuid`;
    action = "reclassify";
  }

  if (body.status === "retracted") {
    if (b.status === "retracted") {
      return NextResponse.json({ ok: false, error: "already retracted" }, { status: 409, headers: NO_STORE });
    }
    if (!body.retraction_reason || !String(body.retraction_reason).trim()) {
      return NextResponse.json({ ok: false, error: "retraction_reason required" }, { status: 400, headers: NO_STORE });
    }
    await sql`
      UPDATE incidents SET
        status            = 'retracted',
        retracted_by      = ${actor.profileId}::uuid,
        retracted_at      = NOW(),
        retraction_reason = ${String(body.retraction_reason).trim()},
        updated_at        = NOW()
      WHERE id = ${id}::uuid
    `;
    action = action ? "retract_and_reclassify" : "retract";
  } else if (body.status === "closed") {
    await sql`UPDATE incidents SET status='closed', updated_at = NOW() WHERE id = ${id}::uuid`;
    action = action ? `${action}_close` : "close";
  } else if (body.status === "open") {
    // Reopen
    await sql`UPDATE incidents SET status='open', updated_at = NOW() WHERE id = ${id}::uuid`;
    action = action ? `${action}_reopen` : "reopen";
  }

  if (!action) {
    return NextResponse.json({ ok: false, error: "no recognized fields to update" }, { status: 400, headers: NO_STORE });
  }

  const after = (await sql`SELECT id::text AS id, target_physician_id::text AS target_physician_id, severity, status, retracted_at, retraction_reason FROM incidents WHERE id = ${id}::uuid`) as Array<Record<string, unknown>>;
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, before_json, after_json)
    VALUES (
      ${actor.profileId}::uuid,
      ${action},
      'incident',
      ${id},
      ${JSON.stringify({ ...b, physician_id: b.target_physician_id })}::jsonb,
      ${JSON.stringify({ ...after[0], physician_id: b.target_physician_id })}::jsonb
    )
  `;
  return NextResponse.json({ ok: true, incident: after[0] }, { headers: NO_STORE });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });
  let actor;
  try { actor = await actorFromRequest(); } catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const me = (await sql`SELECT is_super_admin FROM profiles_with_roles WHERE id = ${actor.profileId}::uuid LIMIT 1`) as Array<{ is_super_admin: boolean }>;
  if (me.length === 0 || !me[0].is_super_admin) return NextResponse.json({ ok: false, error: "Super admin only" }, { status: 403, headers: NO_STORE });
  const ex = (await sql`SELECT target_physician_id::text AS t FROM incidents WHERE id = ${id}::uuid LIMIT 1`) as Array<{ t: string }>;
  if (ex.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });
  await sql`DELETE FROM incidents WHERE id = ${id}::uuid`;
  await sql`INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, before_json) VALUES (${actor.profileId}::uuid, 'delete', 'incident', ${id}, ${JSON.stringify({ physician_id: ex[0].t, hard_delete: true })}::jsonb)`;
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
