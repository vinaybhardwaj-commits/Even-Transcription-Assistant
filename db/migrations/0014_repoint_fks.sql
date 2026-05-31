-- =====================================================================
-- Migration 0014 — V2.S8b: repoint FKs doctor -> clinician (REVERSIBLE).
-- No DROP yet. clinician.id == doctor.id so all FK values stay valid.
-- The DROP TABLE doctor is a separate migration (0015) run after this is verified.
-- =====================================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname, cl.relname AS tbl
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_class rf ON rf.oid = con.confrelid
     WHERE con.contype = 'f' AND rf.relname = 'doctor'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE encounter            ADD CONSTRAINT encounter_clinician_fkey            FOREIGN KEY (doctor_id) REFERENCES clinician(id);
ALTER TABLE voice_print          ADD CONSTRAINT voice_print_clinician_fkey          FOREIGN KEY (doctor_id) REFERENCES clinician(id) ON DELETE CASCADE;
ALTER TABLE recipient_per_doctor ADD CONSTRAINT recipient_per_doctor_clinician_fkey FOREIGN KEY (doctor_id) REFERENCES clinician(id) ON DELETE CASCADE;
ALTER TABLE pin_attempt          ADD CONSTRAINT pin_attempt_clinician_fkey          FOREIGN KEY (doctor_id) REFERENCES clinician(id) ON DELETE CASCADE;

INSERT INTO schema_migrations (version, name) VALUES (14, '0014_repoint_fks') ON CONFLICT DO NOTHING;
