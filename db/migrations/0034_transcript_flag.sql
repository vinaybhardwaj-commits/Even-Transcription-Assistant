-- Patient-safety guardrail: flag encounters whose transcription looks empty /
-- too-short-for-duration / degraded, so the UI warns the clinician instead of
-- silently presenting an incomplete note (the Poornima failure class).
ALTER TABLE encounter ADD COLUMN IF NOT EXISTS transcript_flag text;        -- null | 'empty' | 'short' | 'low_quality'
ALTER TABLE encounter ADD COLUMN IF NOT EXISTS transcript_flag_reason text; -- human-readable explanation
