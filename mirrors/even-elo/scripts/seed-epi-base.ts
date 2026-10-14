/**
 * EPI.0a — base seed script.
 *
 * Idempotent. Run after migration v7 (007_epi_schema) is applied.
 *
 * What this does:
 *   1. Truncate v1 ELO data tables (vcs cascades to surgical_cases, case_observations, score_snapshots)
 *      + weight_versions + audit_log + positions. Schemas preserved.
 *   2. Insert EHRC hospital row (code=EHRC).
 *   3. Insert 13 EPI positions (all scoped to EHRC) per lock-down decision #17.
 *   4. Insert pilot weight_version (33/34/33) so v1 ELO recompute logic still works on empty data.
 *   5. Insert V's physician row + engagement + profile (super_admin, active, PIN=1981).
 *
 * Streams catalogue (18 rows from migration 002) is NOT touched — those rows survive.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." npx tsx scripts/seed-epi-base.ts
 */

import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const sql = neon(url);

// V's PIN is 1981 — bcrypt hash precomputed offline (no bcryptjs dependency in EPI.0a).
// EPI.0b will install bcryptjs and the live login route will verify against this hash.
const V_PIN_HASH = '$2b$10$eniUoGi6m9AChXKRL8kpoeg7IU52ROyVTNC.HSArfcTHSJsFt53jm';

// ─── 13-position catalogue at EHRC (lock-down decision #17) ──────────────────
const EHRC_POSITIONS = [
  // v1's original 9
  { name: 'OT Coordinator',          team: 'OT',         desc: 'Creates cases · OT discipline + return-to-OT' },
  { name: 'Anesthesia Coordinator',  team: 'Anesthesia', desc: 'PAC completion' },
  { name: 'Medical Superintendent',  team: 'MS',         desc: 'Mortality, readmission, discharge summary, rounds' },
  { name: 'ICN Lead',                team: 'ICN',        desc: 'Surgical site infections' },
  { name: 'Clinical Pharmacologist', team: 'Pharmacy',   desc: 'Antibiotic stewardship' },
  { name: 'Customer Care Lead',      team: 'CC',         desc: 'NPS, complaints, family communication' },
  { name: 'Billing Lead',            team: 'Billing',    desc: 'Insurance denials' },
  { name: 'Unit Head',               team: 'UnitHead',   desc: 'Anomaly flags, behavioural patterns' },
  { name: 'Committee Admin',         team: 'Admin',      desc: 'Roster, weights, stream config' },
  // v2 additions
  { name: 'HR',                      team: 'Admin',      desc: 'Credentialing administration, non-clinical view' },
  { name: 'Site Medical Head',       team: 'Admin',      desc: 'Hospital-scoped governance, VC onboarding pipeline' },
  { name: 'Hospital PM',             team: 'Admin',      desc: 'Hospital product management / GM' },
  { name: 'Staff',                   team: 'Admin',      desc: 'Catch-all clinical staff who can submit incidents' },
];

async function main() {
  console.log('🩺 EPI.0a base seed — starting');
  console.log('────────────────────────────────────────');

  // 1. Truncate v1 ELO data (schema preserved)
  console.log('1. Truncating v1 ELO data + positions + weight_versions + audit_log…');
  await sql`TRUNCATE case_observations, surgical_cases, score_snapshots RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE vcs RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE weight_versions RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE audit_log RESTART IDENTITY CASCADE`;
  // positions: truncate so the EPI 13-position catalogue replaces v1's 9
  await sql`DELETE FROM profiles`;       // profiles FK to positions; clear first
  await sql`DELETE FROM physician_engagements`;
  await sql`DELETE FROM privileges`;
  await sql`DELETE FROM physicians`;
  await sql`DELETE FROM hospitals`;
  await sql`TRUNCATE positions RESTART IDENTITY CASCADE`;
  console.log('   ✔ v1 data wiped (schema preserved)');

  // 2. Insert EHRC hospital
  console.log('2. Inserting EHRC hospital row…');
  const hospitalRows = await sql`
    INSERT INTO hospitals (code, name, is_active)
    VALUES ('EHRC', 'Even Hospital Race Course Road', true)
    RETURNING id::text AS id, code, name
  `;
  const hospitalId = (hospitalRows[0] as { id: string }).id;
  console.log(`   ✔ EHRC hospital_id = ${hospitalId}`);

  // 3. Insert 13 EPI positions, all scoped to EHRC
  console.log('3. Inserting 13 EPI positions at EHRC…');
  for (const p of EHRC_POSITIONS) {
    await sql`
      INSERT INTO positions (position_name, team, description, hospital_id)
      VALUES (${p.name}, ${p.team}, ${p.desc}, ${hospitalId}::uuid)
    `;
  }
  const positionRows = await sql`SELECT id::text AS id, position_name FROM positions ORDER BY position_name`;
  console.log(`   ✔ ${positionRows.length} positions inserted`);

  // 4. Pilot weight_version (33/34/33) — keeps v1 ELO recompute logic functional
  console.log('4. Inserting pilot weight_version 33/34/33…');
  await sql`
    INSERT INTO weight_versions
      (caseload_pct, outcomes_pct, adherence_pct, set_by_position, rationale, is_current)
    VALUES (33, 34, 33, 'Committee Admin', 'EPI.0a base seed — pilot pilot weights from v1', true)
  `;
  console.log('   ✔ weight_version pilot row inserted');

  // 5. V's physician row
  console.log('5. Inserting V (Vinay Bhardwaj) as a physician + engagement + profile…');
  const physicianRows = await sql`
    INSERT INTO physicians (
      full_name, primary_specialty, registration_number, registration_council,
      email, date_joined_network, current_status
    ) VALUES (
      'Vinay Bhardwaj', 'Neurology', NULL, NULL,
      'vinay.bhardwaj@even.in', '2024-01-01', 'active'
    )
    RETURNING id::text AS id
  `;
  const vPhysicianId = (physicianRows[0] as { id: string }).id;
  console.log(`   ✔ V physician_id = ${vPhysicianId}`);

  // V's engagement at EHRC
  await sql`
    INSERT INTO physician_engagements (
      physician_id, hospital_id, category, start_date, specialty, status
    ) VALUES (
      ${vPhysicianId}::uuid, ${hospitalId}::uuid, 'active', '2024-01-01', 'Neurology', 'active'
    )
  `;
  console.log('   ✔ V engagement (EHRC, category=active, Neurology) inserted');

  // V's profile — Medical Superintendent position, super_admin, active
  const msPositionRows = await sql`
    SELECT id::text AS id FROM positions WHERE position_name = 'Medical Superintendent' AND hospital_id = ${hospitalId}::uuid LIMIT 1
  `;
  const msPositionId = (msPositionRows[0] as { id: string }).id;
  await sql`
    INSERT INTO profiles (
      email, full_name, password_hash, position_id, hospital_id,
      status, is_super_admin, is_sgc_member, is_hr, is_site_medical_head
    ) VALUES (
      'vinay.bhardwaj@even.in', 'Vinay Bhardwaj', ${V_PIN_HASH},
      ${msPositionId}::uuid, ${hospitalId}::uuid,
      'active', true, false, false, false
    )
  `;
  console.log('   ✔ V profile (Medical Superintendent, super_admin, active, PIN=1981) inserted');

  // ─── Verification ────────────────────────────────────────────────────────────
  console.log('────────────────────────────────────────');
  console.log('Verification:');
  const counts = await sql`
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
  `;
  console.table(counts[0]);

  const v = await sql`
    SELECT p.email, p.full_name, p.is_super_admin, pos.position_name, h.code AS hospital
    FROM profiles p
    JOIN positions pos ON pos.id = p.position_id
    JOIN hospitals h   ON h.id   = p.hospital_id
    WHERE p.email = 'vinay.bhardwaj@even.in'
  `;
  console.log("V's profile:", v[0]);

  console.log('🩺 EPI.0a base seed — done');
}

main().catch(e => {
  console.error('Seed failed:', e);
  process.exit(1);
});
