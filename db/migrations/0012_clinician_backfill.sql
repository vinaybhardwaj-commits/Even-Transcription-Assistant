-- =====================================================================
-- Migration 0012 — V2.S6 Phase-C backfill: refresh clinician from doctor
--
-- Run BEFORE the app switches its read/auth path from doctor to clinician
-- (this migration ships in the same deploy as that switch). S1 dual-write
-- already mirrors admin mutations, but lockout counters (failed_pin_count,
-- locked_until) + last_active_at are written by the login flow straight to
-- doctor and are NOT synced per-event — so refresh every clinician row from
-- the current doctor state here. Idempotent. clinician_type is preserved
-- (NOT overwritten) so dietitian/physiotherapist types set at create survive.
-- =====================================================================

INSERT INTO clinician (
  id, legacy_doctor_id, clinician_type, full_name, email, phone,
  email_show_conversation_with, url_slug, url_token, pin_hash, pin_set_at,
  failed_pin_count, locked_until, status, last_active_at, joined_at,
  created_by, deleted_at, created_at, updated_at
)
SELECT
  id, id, 'physician'::clinician_type, full_name, email, phone,
  email_show_conversation_with, url_slug, url_token, pin_hash, pin_set_at,
  failed_pin_count, locked_until, status, last_active_at, joined_at,
  created_by, deleted_at, created_at, updated_at
FROM doctor
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
  updated_at                   = EXCLUDED.updated_at;
-- clinician_type intentionally NOT in the DO UPDATE set (preserve per-clinician type).

INSERT INTO schema_migrations (version, name)
VALUES (12, '0012_clinician_backfill')
ON CONFLICT DO NOTHING;
