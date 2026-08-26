-- =====================================================================
-- Migration 0070 — clear legacy phantom-spare listener levels after ingestion is gated.
--
-- 0069 cleared these values once, but the still-open browser kiosk could write its automatically
-- selected backup input again before the corrective server code was live. That code now persists
-- spare levels only after a second device was explicitly reported. Repeat the idempotent cleanup
-- after that gate is deployed so a future native-device report cannot expose a stale phantom pair.
-- Listener vitals only: no session, window, chunk, R2 object, cue, or transcription is touched.
-- =====================================================================

UPDATE bench_listener
   SET spare_peak = NULL,
       spare_avg = NULL
 WHERE spare_device IS DISTINCT FROM TRUE
   AND (spare_peak IS NOT NULL OR spare_avg IS NOT NULL);

INSERT INTO schema_migrations (version, name)
VALUES (70, '0070_clear_unreported_spare_levels')
ON CONFLICT DO NOTHING;
