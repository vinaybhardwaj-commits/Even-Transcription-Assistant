-- =====================================================================
-- Migration 0124 — eta_encounter_windows: the warehouse's doctor for each consult, and the doctor we report.
--
-- WHY. 0123's doctor_uid / display_name / attribution say who the Pulse extension saw logged in on the machine.
-- Measured 5 Oct 2026: that is wrong for 77 of 162 attributed consults (OPD 6: the extension says one doctor, Pulse's
-- own consult record says another for 43 consults), because a doctor can be logged in on a machine while a colleague's
-- consult is open under a different profile. Pulse records the consulting doctor itself: the Even warehouse
-- (Metabase database 13, table "individuals-prescriptions", consult_uid + doctor_uid, _create_time stamped at
-- startConsult). lib/encounter-windows/warehouse-attribution.ts reads it every 2 minutes and fills the columns below.
--
-- PRECEDENCE (consulting_doctor_* and attribution_source):
--   1. warehouse   a warehouse doctor was found for the consult        -> consulting_doctor = warehouse doctor
--   2. extension   the warehouse has nothing (yet), the extension did  -> consulting_doctor = doctor_uid / display_name
--   3. none        neither                                              -> consulting_doctor NULL
-- doctor_mismatch is true when BOTH sources name a doctor and they differ. The extension view (doctor_uid,
-- display_name, attribution) is NEVER overwritten: both views stay visible and the mismatch is the signal.
-- Rows the warehouse has not answered for yet read 'extension' (or 'none'): provisional until warehouse_checked_at is set.
--
-- REFRESH-SAFE. The window refresh (lib/encounter-windows/db.ts) no longer deletes rows it is about to rewrite, so
-- these columns survive it; its upsert recomputes consulting_*/attribution_source/doctor_mismatch from the stored
-- warehouse doctor and the fresh extension doctor.
--
-- RETRY CAP. warehouse_attempts counts the lookups that found NO warehouse doctor. After 12 of them the cron stops asking
-- (the consult is final-unresolved; warehouse_checked_at stays set, attribution_source stays extension/none per rule 2/3, which is
-- also what a window refresh re-derives, so the cap survives it). A consult the warehouse answered is never asked again either way.
--
-- ADDITIVE AND IDEMPOTENT. ADD COLUMN IF NOT EXISTS x9, one partial index (rows still waiting for their first
-- warehouse check), comments, the schema_migrations row. Nullable or defaulted, so old code and a half-applied
-- deploy keep working. No data is touched. APPLY BEFORE the warehouse cron deploys.
-- =====================================================================

ALTER TABLE eta_encounter_windows ADD COLUMN IF NOT EXISTS warehouse_doctor_uid       text;
ALTER TABLE eta_encounter_windows ADD COLUMN IF NOT EXISTS warehouse_doctor_name      text;
ALTER TABLE eta_encounter_windows ADD COLUMN IF NOT EXISTS warehouse_checked_at       timestamptz;
ALTER TABLE eta_encounter_windows ADD COLUMN IF NOT EXISTS warehouse_prescription_uid text;
ALTER TABLE eta_encounter_windows ADD COLUMN IF NOT EXISTS consulting_doctor_uid      text;
ALTER TABLE eta_encounter_windows ADD COLUMN IF NOT EXISTS consulting_doctor_name     text;
ALTER TABLE eta_encounter_windows ADD COLUMN IF NOT EXISTS attribution_source         text;
ALTER TABLE eta_encounter_windows ADD COLUMN IF NOT EXISTS doctor_mismatch            boolean NOT NULL DEFAULT false;
ALTER TABLE eta_encounter_windows ADD COLUMN IF NOT EXISTS warehouse_attempts         integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eta_encounter_windows_attribution_source_chk') THEN
    ALTER TABLE eta_encounter_windows
      ADD CONSTRAINT eta_encounter_windows_attribution_source_chk
      CHECK (attribution_source IS NULL OR attribution_source IN ('warehouse', 'extension', 'none'));
  END IF;
END
$$;

-- Rows still waiting for their first warehouse check: the cron's work queue, kept tiny by the partial predicate.
CREATE INDEX IF NOT EXISTS eta_encounter_windows_wh_unchecked_idx
  ON eta_encounter_windows (t_open)
  WHERE warehouse_checked_at IS NULL;

COMMENT ON COLUMN eta_encounter_windows.warehouse_doctor_uid IS
  'Pulse doctor uid on the warehouse consult record (individuals-prescriptions.doctor_uid, earliest _create_time per consult_uid). NULL = not found (yet).';
COMMENT ON COLUMN eta_encounter_windows.warehouse_doctor_name IS
  'doctors.name_with_prefix for warehouse_doctor_uid. NULL when the doctor row is missing.';
COMMENT ON COLUMN eta_encounter_windows.warehouse_checked_at IS
  'When the warehouse cron last looked this consult up. NULL = never. A consult still unresolved is looked up again after 10 minutes.';
COMMENT ON COLUMN eta_encounter_windows.warehouse_prescription_uid IS
  'individuals-prescriptions.uid of the matched row (= prescription_ref in Pulse URLs).';
COMMENT ON COLUMN eta_encounter_windows.consulting_doctor_uid IS
  'The doctor to report: the warehouse doctor when found, else the extension doctor_uid. See attribution_source.';
COMMENT ON COLUMN eta_encounter_windows.consulting_doctor_name IS
  'Display name for consulting_doctor_uid.';
COMMENT ON COLUMN eta_encounter_windows.attribution_source IS
  'warehouse | extension | none. warehouse = Pulse''s own consult record; extension = who the extension saw logged in (the warehouse had nothing); none = neither. Provisional ''extension''/''none'' until warehouse_checked_at is set.';
COMMENT ON COLUMN eta_encounter_windows.warehouse_attempts IS
  'Lookups that found no warehouse doctor. At 12 the cron stops retrying this consult.';
COMMENT ON COLUMN eta_encounter_windows.doctor_mismatch IS
  'true when warehouse_doctor_uid and doctor_uid are both known and differ. The extension view is never overwritten.';

INSERT INTO schema_migrations (version, name) VALUES (124, '0124_encounter_windows_warehouse_attribution')
ON CONFLICT (version) DO NOTHING;
