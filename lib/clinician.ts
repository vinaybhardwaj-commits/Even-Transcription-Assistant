import { sql } from "@/lib/db";

/**
 * V2.S1 dual-write — upsert the clinician row from the canonical doctor row.
 *
 * clinician.id == doctor.id (set in V2.S0, migration 0010), so this keeps the
 * clinician table in lock-step with doctor until the V2.S6 read-switch. Called
 * after every admin-side doctor mutation (create / patch / reset-pin /
 * rotate-url). Doctor remains the source of truth; V2.S6 also runs a full
 * backfill from doctor before flipping reads, which catches any drift (e.g.
 * doctor-self-serve PIN sets, last_active_at churn) not covered here.
 *
 * Soft-fail: a clinician-sync hiccup must NEVER fail the admin action — the
 * doctor write already succeeded. clinician_type is set once on insert and is
 * deliberately NOT overwritten on update (a future v2 surface changes type).
 */
export async function syncClinicianFromDoctor(doctorId: string, clinicianType: string = "physician"): Promise<void> {
  const ct = ["physician", "dietitian", "physiotherapist"].includes(clinicianType) ? clinicianType : "physician";
  try {
    await sql`
      INSERT INTO clinician (
        id, legacy_doctor_id, clinician_type, full_name, email, phone,
        email_show_conversation_with, url_slug, url_token, pin_hash, pin_set_at,
        failed_pin_count, locked_until, status, last_active_at, joined_at,
        created_by, deleted_at, created_at, updated_at
      )
      SELECT
        id, id, ${ct}::clinician_type, full_name, email, phone,
        email_show_conversation_with, url_slug, url_token, pin_hash, pin_set_at,
        failed_pin_count, locked_until, status, last_active_at, joined_at,
        created_by, deleted_at, created_at, updated_at
      FROM doctor WHERE id = ${doctorId}
      ON CONFLICT (id) DO UPDATE SET
        full_name                    = EXCLUDED.full_name,
        email                        = EXCLUDED.email,
        phone                        = EXCLUDED.phone,
        email_show_conversation_with = EXCLUDED.email_show_conversation_with,
        url_slug                     = EXCLUDED.url_slug,
        url_token                    = EXCLUDED.url_token,
        pin_hash                     = EXCLUDED.pin_hash,
        pin_set_at                   = EXCLUDED.pin_set_at,
        failed_pin_count             = EXCLUDED.failed_pin_count,
        locked_until                 = EXCLUDED.locked_until,
        status                       = EXCLUDED.status,
        last_active_at               = EXCLUDED.last_active_at,
        deleted_at                   = EXCLUDED.deleted_at,
        updated_at                   = EXCLUDED.updated_at
    `;
  } catch (e) {
    console.warn(`[clinician-sync] failed for ${doctorId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
