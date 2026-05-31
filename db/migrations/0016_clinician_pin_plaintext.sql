-- =====================================================================
-- Migration 0016 — store the current PIN in plaintext for super-admin visibility.
-- Admin requirement: super-admins distribute + view clinician PINs. 4-digit
-- demonstrator PINs (not high-security). Populated on create/reset/bootstrap
-- going forward; existing rows stay NULL until next reset (bcrypt is one-way).
-- =====================================================================
ALTER TABLE clinician ADD COLUMN IF NOT EXISTS pin_plaintext TEXT;
INSERT INTO schema_migrations (version, name) VALUES (16, '0016_clinician_pin_plaintext') ON CONFLICT DO NOTHING;
