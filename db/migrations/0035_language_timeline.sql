-- Per-segment language map from the eta-router transcription service
-- ([{start_s,end_s,lang,engine,chars}]). Null until an Indic/code-mixed
-- encounter is transcribed via route.llmvinayminihome.uk.
ALTER TABLE encounter ADD COLUMN IF NOT EXISTS language_timeline jsonb;
