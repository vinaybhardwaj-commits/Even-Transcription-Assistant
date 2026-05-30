-- V2.SD note speaker-tagging: store the reconciled speaker-tagged English
-- conversation (Sarvam diarized entries mapped onto pyannote-named speakers).
ALTER TABLE encounter ADD COLUMN IF NOT EXISTS tagged_transcript jsonb;

INSERT INTO schema_migrations (version, name)
VALUES ('0009', 'tagged_transcript')
ON CONFLICT (version) DO NOTHING;
