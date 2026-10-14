-- 0031_vertex_outage_exclusions.sql — 31 Jul 2026
-- Reference audit / outage exclusion (kickoff §3).
--
-- WHY. Vertex was disabled on `clinical-infra` from 26 Jul 12:50 UTC; every Vertex call 403'd and
-- the audit fell back to qwen2.5:14b while STILL WRITING the label `gemini-2.5-pro` (register T-5,
-- the same intent-vs-served defect). Those rows are candidate-model output wearing the reference
-- model's name. Dashboards, governance signals and doctor-facing scores must stop treating them as
-- reference output — but every row is KEPT, because the determinism experiment needs them intact.
--
-- The exact reason string is load-bearing: the lab cohort query allows it explicitly, so the
-- 286-note experiment frame survives this migration. Do not change the text.
-- Verified BEFORE running: cohort query returned exactly 286.

UPDATE opd_note_audits
SET excluded_reason = 'vertex_outage_mislabel_2026_07'
WHERE model = 'gemini-2.5-pro'
  AND audited_at >= timestamptz '2026-07-26 12:50:00+00'
  AND excluded_reason IS NULL;
-- Expected: 382 rows. Covers all active mislabelled rows, including the 46 that already have a
-- newer clean audit — they are still mislabelled, so they get the same treatment.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- NOT RUN — the kickoff's second statement, deliberately omitted. Kept here as the record.
--
-- The 49 NULL-model rows from the dead window (audited_at 2026-07-30 14:34:51 → 14:45:11 UTC, all
-- of them) ALREADY carry `excluded_reason = 'llm_leg_failed'`. As written the statement matches
-- ZERO rows, because of its own `AND excluded_reason IS NULL` guard:
--
--   UPDATE opd_note_audits
--   SET excluded_reason = 'vertex_outage_unknown_model_2026_07'
--   WHERE model IS NULL
--     AND audited_at >= timestamptz '2026-07-30 14:00:00+00'
--     AND audited_at <= timestamptz '2026-07-30 15:00:00+00'
--     AND excluded_reason IS NULL;                                  -- ← matches 0, not 49
--
-- Dropping that guard to force the update would OVERWRITE 'llm_leg_failed' and destroy the record
-- that these notes' LLM leg failed (the 530/502 window) — diagnostic provenance we would not get
-- back. The migration's stated goal is already met for these rows: any non-NULL excluded_reason
-- removes them from every dashboard read (`excluded_reason IS NULL` is the filter everywhere), and
-- a NULL model matches neither arm of the cohort query, so they are outside the experiment frame
-- too. No action is needed; forcing one would only lose information.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (guardrail 5) — single statement, filtered on the reason string:
--
--   UPDATE opd_note_audits SET excluded_reason = NULL
--    WHERE excluded_reason = 'vertex_outage_mislabel_2026_07';
