-- Per-encounter step lock for the background step-machine. Ensures only ONE
-- pipeline step runs at a time per encounter, so the self-chain and the resume
-- cron can't double-run qwen/llama on the same encounter (which thrashes the
-- Mac Mini and times both jobs out). Lock auto-releases after 5 min if a worker
-- dies mid-step.
ALTER TABLE encounter ADD COLUMN IF NOT EXISTS processing_step_at timestamptz;
