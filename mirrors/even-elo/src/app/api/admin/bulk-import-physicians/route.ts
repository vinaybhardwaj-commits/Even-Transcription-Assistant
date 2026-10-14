import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { requireOps } from "@/lib/ops-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

const CATEGORIES = new Set([
  "provisional",
  "active",
  "visiting_consultant",
  "locum_tenens",
  "affiliate",
]);

interface PhysicianRow {
  full_name: string;
  primary_specialty?: string | null;
  registration_number?: string | null;
  registration_council?: string | null;
  registration_expiry?: string | null;
  indemnity_expiry?: string | null;
  email?: string | null;
  phone?: string | null;
  date_joined_network?: string | null;
  category?: string | null;
  notes?: string | null;
  external_code?: string | null; // sheet code like BA100123 — stored in notes
}

/**
 * POST /api/admin/bulk-import-physicians
 *
 * Body: { hospital_code: string, rows: PhysicianRow[] }
 * URL-gated.
 *
 * For each row:
 *   - If a physician with this email already exists, SKIP and record as
 *     'skipped_duplicate' (idempotent re-run).
 *   - Else INSERT physician + INSERT engagement at hospital_code.
 *
 * Returns: { ok, created, skipped, errors, details }
 */
export async function POST(req: NextRequest) {
  const denied = await requireOps(req);
  if (denied) return denied;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const body = await req.json();
  const { hospital_code, rows } = (body ?? {}) as { hospital_code?: string; rows?: PhysicianRow[] };

  if (!hospital_code || typeof hospital_code !== "string") {
    return NextResponse.json({ ok: false, error: "hospital_code required" }, { status: 400, headers: NO_STORE });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ ok: false, error: "rows must be a non-empty array" }, { status: 400, headers: NO_STORE });
  }

  const hosp = (await sql`SELECT id::text AS id FROM hospitals WHERE code = ${hospital_code} AND is_active = true LIMIT 1`) as Array<{ id: string }>;
  if (hosp.length === 0) {
    return NextResponse.json({ ok: false, error: `hospital ${hospital_code} not active` }, { status: 400, headers: NO_STORE });
  }
  const hospitalId = hosp[0].id;

  const created: Array<{ row_index: number; physician_id: string; full_name: string }> = [];
  const skipped: Array<{ row_index: number; full_name: string; reason: string; existing_id?: string }> = [];
  const errors: Array<{ row_index: number; full_name: string; error: string }> = [];
  const engagementsAdded: Array<{ row_index: number; physician_id: string; full_name: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.full_name || !r.full_name.trim()) {
      errors.push({ row_index: i, full_name: r.full_name ?? "(missing)", error: "full_name required" });
      continue;
    }
    const fullName = r.full_name.trim();
    const lowerEmail = (r.email ?? "").trim().toLowerCase();

    try {
      // Validate category
      const cat = (r.category ?? "active").trim();
      if (!CATEGORIES.has(cat)) {
        errors.push({ row_index: i, full_name: fullName, error: `invalid category '${cat}'` });
        continue;
      }

      const joinDate = (r.date_joined_network ?? "").trim() || new Date().toISOString().slice(0, 10);

      // Existing physician (multi-hospital) — add an engagement at this hospital instead of skipping.
      let existingId: string | null = null;
      if (lowerEmail) {
        const ex = (await sql`SELECT id::text AS id FROM physicians WHERE lower(email) = ${lowerEmail} LIMIT 1`) as Array<{ id: string }>;
        if (ex.length > 0) existingId = ex[0].id;
      } else {
        const ex = (await sql`SELECT id::text AS id FROM physicians WHERE lower(full_name) = ${fullName.toLowerCase()} LIMIT 1`) as Array<{ id: string }>;
        if (ex.length > 0) existingId = ex[0].id;
      }
      if (existingId) {
        const eng = (await sql`SELECT id FROM physician_engagements WHERE physician_id = ${existingId}::uuid AND hospital_id = ${hospitalId}::uuid LIMIT 1`) as Array<{ id: string }>;
        if (eng.length > 0) {
          skipped.push({ row_index: i, full_name: fullName, reason: "engagement_exists", existing_id: existingId });
          continue;
        }
        await sql`
          INSERT INTO physician_engagements (physician_id, hospital_id, category, start_date, specialty, status)
          VALUES (${existingId}::uuid, ${hospitalId}::uuid, ${cat}, ${joinDate}, ${(r.primary_specialty ?? null) || null}, 'active')
        `;
        await sql`
          INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json)
          VALUES ('engagement_added', 'physician', ${existingId},
            ${JSON.stringify({ row_index: i, full_name: fullName, hospital_code, category: cat, sheet_code: r.external_code ?? null, seeded_via: "bulk-import (existing->engagement)" })}::jsonb)
        `;
        engagementsAdded.push({ row_index: i, physician_id: existingId, full_name: fullName });
        continue;
      }

      const ins = (await sql`
        INSERT INTO physicians (
          full_name, primary_specialty, registration_number, registration_council,
          registration_expiry, indemnity_expiry, email, phone, date_joined_network,
          current_status, notes
        ) VALUES (
          ${fullName},
          ${(r.primary_specialty ?? null) || null},
          ${(r.registration_number ?? null) || null},
          ${(r.registration_council ?? null) || null},
          ${(r.registration_expiry ?? null) || null},
          ${(r.indemnity_expiry ?? null) || null},
          ${lowerEmail || null},
          ${(r.phone ?? null) || null},
          ${joinDate},
          'active',
          ${(r.notes ?? null) || null}
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const physId = ins[0].id;

      await sql`
        INSERT INTO physician_engagements (
          physician_id, hospital_id, category, start_date, specialty, status
        ) VALUES (
          ${physId}::uuid, ${hospitalId}::uuid, ${cat}, ${joinDate},
          ${(r.primary_specialty ?? null) || null}, 'active'
        )
      `;

      await sql`
        INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json)
        VALUES (
          'bulk_import',
          'physician',
          ${physId},
          ${JSON.stringify({
            row_index: i,
            full_name: fullName,
            hospital_code,
            category: cat,
            sheet_code: r.external_code ?? null,
            seeded_via: "POST /api/admin/bulk-import-physicians",
          })}::jsonb
        )
      `;

      created.push({ row_index: i, physician_id: physId, full_name: fullName });
    } catch (e) {
      errors.push({ row_index: i, full_name: fullName, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json(
    {
      ok: errors.length === 0,
      hospital_code,
      total_rows: rows.length,
      created_count: created.length,
      engagement_added_count: engagementsAdded.length,
      skipped_count: skipped.length,
      error_count: errors.length,
      created,
      engagementsAdded,
      skipped,
      errors,
    },
    { headers: NO_STORE },
  );
}
