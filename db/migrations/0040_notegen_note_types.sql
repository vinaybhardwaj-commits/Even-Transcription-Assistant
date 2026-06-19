-- =====================================================================
-- Migration 0040 — NoteGen note types: discharge_summary + opd_prescription.
-- Deferred from P0 until P3 (the editor + generateNote schemas + email use them).
-- ADD VALUE is allowed inside a transaction in PG12+ as long as the new value is
-- not USED in the same transaction — it is only added here (the schema_migrations
-- insert below does not reference it), so this is safe through the txn-wrapping runner.
-- =====================================================================
ALTER TYPE note_type ADD VALUE IF NOT EXISTS 'discharge_summary';
ALTER TYPE note_type ADD VALUE IF NOT EXISTS 'opd_prescription';

INSERT INTO schema_migrations (version, name)
VALUES (40, '0040_notegen_note_types')
ON CONFLICT DO NOTHING;
