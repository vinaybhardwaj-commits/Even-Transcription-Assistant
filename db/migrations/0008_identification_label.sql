-- Migration 0008 — identification_label (V2.SD.6 EER harness)
-- Ground-truth labels: was a speaker's clinician auto-match correct? Used to
-- compute EER / tune the 0.70/0.78 thresholds once enough pilot labels exist.
CREATE TABLE IF NOT EXISTS identification_label (
  id                 TEXT PRIMARY KEY,                -- ilbl_<nanoid>
  encounter_id       TEXT NOT NULL REFERENCES encounter(id) ON DELETE CASCADE,
  doctor_id          TEXT REFERENCES doctor(id) ON DELETE SET NULL,
  speaker_idx        INT NOT NULL,
  is_correct         BOOLEAN NOT NULL,                -- was the clinician match correct?
  matched_confidence NUMERIC(6,4),                    -- confidence at label time (for EER)
  labeled_by         UUID,
  labeled_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (encounter_id, speaker_idx)
);
CREATE INDEX IF NOT EXISTS idx_identification_label_enc ON identification_label(encounter_id);
INSERT INTO schema_migrations (version, name) VALUES (8, '0008_identification_label') ON CONFLICT DO NOTHING;
