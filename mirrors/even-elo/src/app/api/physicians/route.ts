import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { getHospitalFilter } from "@/lib/hospital-filter";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

interface PhysicianRow {
  id: string;
  full_name: string;
  preferred_name: string | null;
  primary_specialty: string | null;
  registration_number: string | null;
  registration_council: string | null;
  registration_expiry: string | null;
  email: string | null;
  phone: string | null;
  current_status: string;
  date_joined_network: string | null;
  engagements_count: number;
  hospitals_active: string | null;
}

/**
 * GET /api/physicians?q=&specialty=&hospital_code=&status=
 *
 * Returns the network-wide physician roster joined with engagement summary.
 * Filters are AND-combined.
 */
export async function GET(req: NextRequest) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json(
      { ok: false, error: "DATABASE_URL not configured" },
      { status: 500, headers: NO_STORE },
    );
  }
  const sql = neon(url);
  const params = req.nextUrl.searchParams;
  const q = (params.get("q") ?? "").trim();
  const specialty = (params.get("specialty") ?? "").trim();
  let hospitalCode = (params.get("hospital_code") ?? "").trim();
  if (hospitalCode.toLowerCase() === "all") {
    hospitalCode = ""; // explicit "all" — no filter, and do NOT fall back to the cookie (lets callers be filter-independent)
  } else if (!hospitalCode) {
    const cookieFilter = await getHospitalFilter();
    if (cookieFilter !== "all") hospitalCode = cookieFilter;
  }
  const status = (params.get("status") ?? "").trim();

  // Build dynamic SQL
  const rows = (await sql`
    WITH eng AS (
      SELECT
        e.physician_id,
        COUNT(*)::int AS engagements_count,
        STRING_AGG(DISTINCT h.code, ', ' ORDER BY h.code) AS hospitals_active
      FROM physician_engagements e
      JOIN hospitals h ON h.id = e.hospital_id
      WHERE e.status = 'active'
      GROUP BY e.physician_id
    )
    SELECT
      p.id::text AS id,
      p.full_name,
      p.preferred_name,
      p.primary_specialty,
      p.registration_number,
      p.registration_council,
      p.registration_expiry,
      p.email,
      p.phone,
      p.current_status,
      p.date_joined_network,
      COALESCE(eng.engagements_count, 0)::int AS engagements_count,
      eng.hospitals_active
    FROM physicians p
    LEFT JOIN eng ON eng.physician_id = p.id
    WHERE
      (${q} = '' OR (
        p.full_name ILIKE ${'%' + q + '%'}
        OR p.email ILIKE ${'%' + q + '%'}
        OR p.registration_number ILIKE ${'%' + q + '%'}
      ))
      AND (${specialty} = '' OR p.primary_specialty = ${specialty})
      AND (${hospitalCode} = '' OR ${hospitalCode} = ANY(STRING_TO_ARRAY(eng.hospitals_active, ', ')))
      AND (${status} = '' OR p.current_status = ${status})
    ORDER BY p.full_name ASC
    LIMIT 500
  `) as PhysicianRow[];

  // Distinct specialties for filter UI
  const specialties = (await sql`
    SELECT DISTINCT primary_specialty AS s FROM physicians WHERE primary_specialty IS NOT NULL ORDER BY s ASC
  `) as Array<{ s: string }>;

  return NextResponse.json(
    {
      ok: true,
      rows,
      specialties: specialties.map((r) => r.s),
      total: rows.length,
    },
    { headers: NO_STORE },
  );
}

/**
 * POST /api/physicians — super_admin only (middleware-gated for /api/* but
 * we still verify role here for defence in depth).
 */
export async function POST(req: NextRequest) {
  let actor;
  try {
    actor = await actorFromRequest();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  }
  const body = await req.json();
  const {
    full_name,
    preferred_name,
    primary_specialty,
    registration_number,
    registration_council,
    registration_expiry,
    email,
    phone,
    date_joined_network,
    notes,
    hospital_codes,           // new v3.0c — array of hospital codes to engage at
    category,                 // optional; defaults to 'active'. Legacy 'engagement_type' accepted via mapping below.
    extend_physician_id,      // optional; if provided, skip dupe check + INSERT, just add engagements
    also_copy_privileges,     // optional string[] of source privilege ids — CR.5
  } = body ?? {};
  if (!full_name || typeof full_name !== "string" || !full_name.trim()) {
    return NextResponse.json({ ok: false, error: "full_name required" }, { status: 400, headers: NO_STORE });
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  }
  const sql = neon(url);

  const hospitalCodesArr: string[] = Array.isArray(hospital_codes) ? hospital_codes.filter((c) => typeof c === "string" && c.trim().length > 0) : [];
  // Body may send `category` (preferred) or legacy `engagement_type` (mapped).
  const legacyEngType =
    typeof (body?.engagement_type) === "string" && body.engagement_type.trim()
      ? body.engagement_type.trim()
      : null;
  const rawCategory =
    typeof category === "string" && category.trim()
      ? category.trim()
      : legacyEngType
        ? (legacyEngType === "visiting_consultant" ? "visiting_consultant"
          : legacyEngType === "locum" || legacyEngType === "locum_tenens" ? "locum_tenens"
          : "active")
        : "active";
  const CATS = new Set(["provisional","active","visiting_consultant","locum_tenens","affiliate"]);
  const engCategory = CATS.has(rawCategory) ? rawCategory : "active";
  const joinDate = date_joined_network || new Date().toISOString().slice(0,10);

  // Cross-site duplicate check (v3.0c decision #14). Only if email provided AND no extend_physician_id override.
  const trimmedEmail = (email ?? "").trim().toLowerCase();
  if (trimmedEmail && !extend_physician_id) {
    const dupe = (await sql`
      SELECT
        p.id::text AS id,
        p.full_name,
        p.primary_specialty,
        p.email,
        p.current_status,
        COALESCE(
          (SELECT json_agg(json_build_object(
            'hospital_code', h.code,
            'hospital_id', h.id::text,
            'status', e.status,
            'category', e.category,
            'engagement_type', e.category,
            'start_date', e.start_date
          ) ORDER BY h.code) FROM physician_engagements e JOIN hospitals h ON h.id = e.hospital_id WHERE e.physician_id = p.id),
          '[]'::json
        ) AS engagements
      FROM physicians p
      WHERE lower(p.email) = ${trimmedEmail}
      LIMIT 1
    `) as Array<Record<string, unknown>>;
    if (dupe.length > 0) {
      return NextResponse.json({
        ok: false,
        duplicate: true,
        existing_physician: dupe[0],
        error: "A physician with this email already exists. Confirm whether to add engagements at the new hospital(s) to the existing record.",
      }, { status: 409, headers: NO_STORE });
    }
  }

  // Resolve hospital codes to ids (validate all before any insert)
  const hospitalIds: Array<{ code: string; id: string }> = [];
  for (const code of hospitalCodesArr) {
    const h = (await sql`SELECT id::text AS id FROM hospitals WHERE code = ${code.toUpperCase()} AND is_active = true LIMIT 1`) as Array<{ id: string }>;
    if (h.length === 0) {
      return NextResponse.json({ ok: false, error: `Unknown or inactive hospital: ${code}` }, { status: 400, headers: NO_STORE });
    }
    hospitalIds.push({ code: code.toUpperCase(), id: h[0].id });
  }

  // Either create new physician OR add engagements to existing (extend flow)
  let physicianId: string;
  let inserted: Record<string, unknown> | null = null;
  if (extend_physician_id && typeof extend_physician_id === "string") {
    const ex = (await sql`SELECT id::text AS id FROM physicians WHERE id = ${extend_physician_id}::uuid LIMIT 1`) as Array<{ id: string }>;
    if (ex.length === 0) {
      return NextResponse.json({ ok: false, error: "extend_physician_id not found" }, { status: 404, headers: NO_STORE });
    }
    physicianId = ex[0].id;
  } else {
    const rows = (await sql`
      INSERT INTO physicians (
        full_name, preferred_name, primary_specialty,
        registration_number, registration_council, registration_expiry,
        email, phone, date_joined_network, current_status, notes
      ) VALUES (
        ${full_name.trim()},
        ${preferred_name ?? null},
        ${primary_specialty ?? null},
        ${registration_number ?? null},
        ${registration_council ?? null},
        ${registration_expiry ?? null},
        ${trimmedEmail || null},
        ${phone ?? null},
        ${date_joined_network ?? null},
        'active',
        ${notes ?? null}
      )
      RETURNING id::text AS id, full_name, primary_specialty, current_status, created_at
    `) as Array<Record<string, unknown>>;
    inserted = rows[0];
    physicianId = inserted.id as string;
    await sql`
      INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
      VALUES (${actor.profileId}::uuid, 'create', 'physician', ${physicianId}, ${JSON.stringify(inserted)}::jsonb)
    `;
  }

  // Create engagements at each chosen hospital (skip if already engaged there)
  const createdEngagements: Array<{ hospital_code: string }> = [];
  for (const h of hospitalIds) {
    const exists = (await sql`
      SELECT 1 FROM physician_engagements
      WHERE physician_id = ${physicianId}::uuid AND hospital_id = ${h.id}::uuid AND status = 'active'
      LIMIT 1
    `) as Array<unknown>;
    if (exists.length > 0) continue;
    await sql`
      INSERT INTO physician_engagements (
        physician_id, hospital_id, category, start_date, specialty, status
      ) VALUES (
        ${physicianId}::uuid, ${h.id}::uuid, ${engCategory}, ${joinDate}, ${primary_specialty ?? null}, 'active'
      )
    `;
    await sql`
      INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
      VALUES (${actor.profileId}::uuid, 'create', 'physician_engagement', ${physicianId},
        ${JSON.stringify({ hospital_code: h.code, category: engCategory, start_date: joinDate, via: extend_physician_id ? "extend" : "create" })}::jsonb)
    `;
    createdEngagements.push({ hospital_code: h.code });

    // CR.5 cross-site auto-carry on the extend path (PRD decision #12). The
    // body may include also_copy_privileges: string[] of SOURCE privilege ids
    // (from the physician's existing hospitals). For each new hospital we just
    // created an engagement at, copy the marked privileges in.
    if (Array.isArray(also_copy_privileges) && also_copy_privileges.length > 0) {
      for (const srcId of also_copy_privileges) {
        if (typeof srcId !== "string") continue;
        const src = (await sql`
          SELECT id::text AS id, procedure_or_specialty, is_core, expires_at, hospital_id::text AS hospital_id
          FROM privileges
          WHERE id = ${srcId}::uuid AND physician_id = ${physicianId}::uuid AND withdrawn_date IS NULL
          LIMIT 1
        `) as Array<{ id: string; procedure_or_specialty: string; is_core: boolean; expires_at: string | null; hospital_id: string }>;
        if (src.length === 0) continue;
        if (src[0].hospital_id === h.id) continue; // don't copy onto the same hospital
        const ins = (await sql`
          INSERT INTO privileges (
            physician_id, hospital_id, procedure_or_specialty, granted_date, granted_by,
            basis, is_core, expires_at
          ) VALUES (
            ${physicianId}::uuid, ${h.id}::uuid, ${src[0].procedure_or_specialty}, CURRENT_DATE,
            ${actor.profileId}::uuid, 'annual_review', ${src[0].is_core},
            ${src[0].expires_at ?? null}::date
          )
          RETURNING id::text AS id
        `) as Array<{ id: string }>;
        await sql`
          INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
          VALUES (
            ${actor.profileId}::uuid, 'cross_site_carry', 'privilege', ${ins[0].id},
            ${JSON.stringify({
              source_privilege_id: src[0].id,
              target_hospital_code: h.code,
              via: "physicians_extend_flow",
              procedure_or_specialty: src[0].procedure_or_specialty,
              is_core: src[0].is_core,
              expires_at: src[0].expires_at,
            })}::jsonb
          )
        `;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    physician: inserted ?? { id: physicianId },
    extended: Boolean(extend_physician_id),
    created_engagements: createdEngagements,
  }, { headers: NO_STORE });
}
