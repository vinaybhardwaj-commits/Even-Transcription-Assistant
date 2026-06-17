-- 0036: persist the Mac-Mini chunked-transcription job id on the encounter so the
-- step machine can submit once and poll across invocations (long-recording path).
ALTER TABLE encounter ADD COLUMN IF NOT EXISTS router_job_id text;
