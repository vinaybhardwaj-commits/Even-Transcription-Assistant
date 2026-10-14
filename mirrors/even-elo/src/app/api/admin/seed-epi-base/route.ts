import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { requireOps } from "@/lib/ops-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/admin/seed-epi-base
 *
 * One-shot EPI.0a base seed. Idempotent (deletes + re-inserts).
 *
 * What this does:
 *   1. Wipes v1 ELO data (vcs → cascades cases/observations/snapshots) +
 *      weight_versions + audit_log + profiles/engagements/privileges/
 *      physicians/hospitals/positions.
 *   2. Inserts EHRC hospital row.
 *   3. Inserts 14 EPI positions, all scoped to EHRC (lock-down decision #17).
 *   4. Inserts pilot weight_version 33/34/33 so v1 ELO recompute logic still works.
 *   5. Inserts V (Vinay Bhardwaj) as a physician + engagement + profile.
 *      PIN=1981 (bcrypt hash precomputed; EPI.0b's auth route will verify).
 *
 * URL-gated. v1 pattern.
 */

const V_PIN_HASH =
  "$2b$10$eniUoGi6m9AChXKRL8kpoeg7IU52ROyVTNC.HSArfcTHSJsFt53jm";

const EHRC_POSITIONS = [
  { name: "OT Coordinator", team: "OT", desc: "Creates cases · OT discipline + return-to-OT" },
  { name: "Anesthesia Coordinator", team: "Anesthesia", desc: "PAC completion" },
  { name: "Medical Superintendent", team: "MS", desc: "Mortality, readmission, discharge summary, rounds" },
  { name: "ICN Lead", team: "ICN", desc: "Surgical site infections" },
  { name: "Clinical Pharmacologist", team: "Pharmacy", desc: "Antibiotic stewardship" },
  { name: "Customer Care Lead", team: "CC", desc: "NPS, complaints, family communication" },
  { name: "Billing Lead", team: "Billing", desc: "Insurance denials" },
  { name: "Unit Head", team: "UnitHead", desc: "Anomaly flags, behavioural patterns" },
  { name: "Committee Admin", team: "Admin", desc: "Roster, weights, stream config" },
  { name: "HR", team: "Admin", desc: "Credentialing administration, non-clinical view" },
  { name: "Site Medical Head", team: "Admin", desc: "Hospital-scoped governance, VC onboarding pipeline" },
  { name: "Hospital PM", team: "Admin", desc: "Hospital product management / GM" },
  { name: "Staff", team: "Admin", desc: "Catch-all clinical staff who can submit incidents" },
  { name: "Medical Administrator", team: "Admin", desc: "Senior medical administration / governance support" },
];

export async function POST(req: Request) {
  const denied = await requireOps(req);
  if (denied) return denied;
  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json(
      { ok: false, error: "DATABASE_URL not set" },
      { status: 500 },
    );
  }
  const sql = neon(url);

  try {
    const log: string[] = [];

    // 1. Wipe (order matters: FKs)
    await sql`TRUNCATE case_observations, surgical_cases, score_snapshots RESTART IDENTITY CASCADE`;
    await sql`TRUNCATE vcs RESTART IDENTITY CASCADE`;
    await sql`TRUNCATE weight_versions RESTART IDENTITY CASCADE`;
    await sql`TRUNCATE audit_log RESTART IDENTITY CASCADE`;
    // v3.0a: wipe join tables before parents so the migration view + FKs don't trip
    await sql`DELETE FROM profile_hospital_roles`;
    await sql`DELETE FROM vc_prescreen_hospitals`;
    await sql`DELETE FROM profiles`;
    await sql`DELETE FROM physician_engagements`;
    await sql`DELETE FROM privileges`;
    await sql`DELETE FROM qualifications`;
    await sql`DELETE FROM physicians`;
    await sql`TRUNCATE positions RESTART IDENTITY CASCADE`;
    await sql`DELETE FROM hospitals`;
    log.push("1. v1 data wiped (schema preserved)");

    // 2. Seed all 4 hospitals (PRD §A.1)
    const hospInsert = (await sql`
      INSERT INTO hospitals (code, name, is_active) VALUES
        ('EHRC', 'EHRC', true),
        ('EHBR', 'EHBR', true),
        ('EHIN', 'EHIN', true),
        ('EHBO', 'EHBO', true)
      RETURNING id::text AS id, code
    `) as Array<{ id: string; code: string }>;
    const hospByCode: Record<string, string> = {};
    for (const h of hospInsert) hospByCode[h.code] = h.id;
    const hospitalId = hospByCode["EHRC"]; // V remains EHRC-homed
    log.push(`2. 4 hospitals seeded (EHRC=${hospitalId})`);

    // 3. 14 EPI positions (shared catalogue, v3.0a — no hospital_id)
    for (const p of EHRC_POSITIONS) {
      await sql`
        INSERT INTO positions (position_name, team, description)
        VALUES (${p.name}, ${p.team}, ${p.desc})
      `;
    }
    log.push(`3. ${EHRC_POSITIONS.length} positions inserted (shared catalogue)`);

    // 4. Pilot weight_version
    await sql`
      INSERT INTO weight_versions
        (caseload_pct, outcomes_pct, adherence_pct, set_by_position, rationale, is_current)
      VALUES (33, 34, 33, 'Committee Admin', 'EPI.0a base seed — pilot weights from v1', true)
    `;
    log.push("4. Pilot weight_version 33/34/33 inserted");

    // 5. V's physician + engagement + profile
    const phys = (await sql`
      INSERT INTO physicians (
        full_name, primary_specialty, email, date_joined_network, current_status
      ) VALUES (
        'Vinay Bhardwaj', 'Neurology', 'vinay.bhardwaj@even.in', '2024-01-01', 'active'
      )
      RETURNING id::text AS id
    `) as Array<{ id: string }>;
    const vPhysicianId = phys[0].id;
    log.push(`5a. V physician_id = ${vPhysicianId}`);

    await sql`
      INSERT INTO physician_engagements (
        physician_id, hospital_id, category, start_date, specialty, status
      ) VALUES (
        ${vPhysicianId}::uuid, ${hospitalId}::uuid, 'active', '2024-01-01', 'Neurology', 'active'
      )
    `;
    log.push("5b. V engagement (EHRC, category=active, Neurology) inserted");

    const msPos = (await sql`
      SELECT id::text AS id FROM positions
      WHERE position_name = 'Medical Superintendent'
      LIMIT 1
    `) as Array<{ id: string }>;
    const msPositionId = msPos[0].id;

    await sql`
      INSERT INTO profiles (
        email, full_name, password_hash, position_id, hospital_id,
        status, is_super_admin
      ) VALUES (
        'vinay.bhardwaj@even.in', 'Vinay Bhardwaj', ${V_PIN_HASH},
        ${msPositionId}::uuid, ${hospitalId}::uuid,
        'active', true
      )
    `;
    log.push("5c. V profile (Medical Superintendent, super_admin, active, PIN=1981) inserted — per-site roles via profile_hospital_roles");

    // Verify
    const counts = (await sql`
      SELECT
        (SELECT count(*) FROM hospitals)             AS hospitals,
        (SELECT count(*) FROM positions)             AS positions,
        (SELECT count(*) FROM physicians)            AS physicians,
        (SELECT count(*) FROM physician_engagements) AS engagements,
        (SELECT count(*) FROM profiles)              AS profiles,
        (SELECT count(*) FROM weight_versions)       AS weight_versions,
        (SELECT count(*) FROM streams)               AS streams,
        (SELECT count(*) FROM vcs)                   AS vcs,
        (SELECT count(*) FROM surgical_cases)        AS cases
    `) as Array<Record<string, string | number>>;

    const v = (await sql`
      SELECT p.email, p.full_name, p.is_super_admin, pos.position_name, h.code AS hospital
      FROM profiles p
      JOIN positions pos ON pos.id = p.position_id
      JOIN hospitals h   ON h.id   = p.hospital_id
      WHERE p.email = 'vinay.bhardwaj@even.in'
    `) as Array<Record<string, unknown>>;

    return NextResponse.json({
      ok: true,
      log,
      counts: counts[0],
      v_profile: v[0],
    });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: err }, { status: 500 });
  }
}
