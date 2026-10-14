import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 5-value category enum + 5-state status enum, per CR.1 / PRD §C.1, §C.8, §J.1.
const ENGAGEMENT_CATEGORIES = new Set([
  "provisional",
  "active",
  "visiting_consultant",
  "locum_tenens",
  "affiliate",
]);
const ENGAGEMENT_STATUSES = new Set([
  "active",
  "suspended",
  "revoked",
  "resigned",
  "lapsed",
]);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  // Accept either `category` (preferred) or legacy `engagement_type` for one
  // release of compatibility. Legacy values get mapped to the new enum.
  let category: string | undefined =
    typeof body?.category === "string" ? body.category.trim() : undefined;
  if (!category && typeof body?.engagement_type === "string") {
    const legacy = body.engagement_type.trim();
    category =
      legacy === "visiting_consultant" ? "visiting_consultant" :
      legacy === "locum" || legacy === "locum_tenens" ? "locum_tenens" :
      legacy === "employed" || legacy === "part_time" || legacy === "panel_consultant" ? "active" :
      legacy;
  }
  const { hospital_code, start_date, end_date, specialty, status, status_reason, also_copy_privileges } = body ?? {};

  if (!hospital_code) return NextResponse.json({ ok: false, error: "hospital_code required" }, { status: 400, headers: NO_STORE });
  if (!category || !ENGAGEMENT_CATEGORIES.has(category)) {
    return NextResponse.json(
      { ok: false, error: "category must be one of: provisional|active|visiting_consultant|locum_tenens|affiliate" },
      { status: 400, headers: NO_STORE },
    );
  }
  if (!start_date) return NextResponse.json({ ok: false, error: "start_date required" }, { status: 400, headers: NO_STORE });
  const finalStatus = status && ENGAGEMENT_STATUSES.has(status) ? status : "active";

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const hosp = (await sql`
    SELECT id::text AS id FROM hospitals WHERE code = ${hospital_code} AND is_active = true LIMIT 1
  `) as Array<{ id: string }>;
  if (hosp.length === 0) return NextResponse.json({ ok: false, error: `hospital ${hospital_code} not active` }, { status: 400, headers: NO_STORE });

  const inserted = (await sql`
    INSERT INTO physician_engagements (
      physician_id, hospital_id, category, start_date, end_date, specialty, status, status_reason
    ) VALUES (
      ${id}::uuid, ${hosp[0].id}::uuid, ${category}, ${start_date},
      ${end_date ?? null}, ${specialty ?? null}, ${finalStatus}, ${status_reason ?? null}
    )
    RETURNING id::text AS id, physician_id::text AS physician_id, category, start_date, end_date, specialty, status, status_reason, created_at
  `) as Array<Record<string, unknown>>;

  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (${actor.profileId}::uuid, 'create', 'engagement', ${inserted[0].id as string}, ${JSON.stringify(inserted[0])}::jsonb)
  `;

  // CR.5 cross-site auto-carry (PRD decision #12). Body may include
  // also_copy_privileges: string[] — privilege ids from a SOURCE hospital on
  // this physician. Each gets INSERTed at the NEW hospital with the same
  // procedure_or_specialty + is_core + expires_at; basis='annual_review' is
  // used as a marker for "this was a cross-site carry". Audit each copy.
  const copiedPrivileges: Array<{ source_privilege_id: string; new_privilege_id: string }> = [];
  if (Array.isArray(also_copy_privileges) && also_copy_privileges.length > 0) {
    for (const srcId of also_copy_privileges) {
      if (typeof srcId !== "string" || !UUID_RE.test(srcId)) continue;
      const src = (await sql`
        SELECT id::text AS id, procedure_or_specialty, is_core, expires_at, hospital_id::text AS hospital_id
        FROM privileges
        WHERE id = ${srcId}::uuid AND physician_id = ${id}::uuid AND withdrawn_date IS NULL
        LIMIT 1
      `) as Array<{ id: string; procedure_or_specialty: string; is_core: boolean; expires_at: string | null; hospital_id: string }>;
      if (src.length === 0) continue;
      // Don't carry to the same hospital (no-op + duplicate would just clutter)
      if (src[0].hospital_id === hosp[0].id) continue;
      const newIns = (await sql`
        INSERT INTO privileges (
          physician_id, hospital_id, procedure_or_specialty, granted_date, granted_by,
          basis, is_core, expires_at
        ) VALUES (
          ${id}::uuid, ${hosp[0].id}::uuid, ${src[0].procedure_or_specialty}, CURRENT_DATE,
          ${actor.profileId}::uuid, 'annual_review', ${src[0].is_core},
          ${src[0].expires_at ?? null}::date
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      copiedPrivileges.push({ source_privilege_id: src[0].id, new_privilege_id: newIns[0].id });
      await sql`
        INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
        VALUES (
          ${actor.profileId}::uuid, 'cross_site_carry', 'privilege', ${newIns[0].id},
          ${JSON.stringify({
            source_privilege_id: src[0].id,
            new_engagement_id: inserted[0].id,
            procedure_or_specialty: src[0].procedure_or_specialty,
            is_core: src[0].is_core,
            expires_at: src[0].expires_at,
          })}::jsonb
        )
      `;
    }
  }

  return NextResponse.json(
    { ok: true, engagement: inserted[0], copied_privileges: copiedPrivileges },
    { headers: NO_STORE },
  );
}
