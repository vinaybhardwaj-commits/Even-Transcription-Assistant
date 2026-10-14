#!/usr/bin/env bash
# tools/timbre/deploy/hf_job.sh — the same nightly job as a scheduled Hugging Face GPU Job (compute hf_gpu, cleared by Vinay).
# Schedule (02:30 IST):  hf jobs scheduled run "0 21 * * *" --flavor l4x1 --secrets TIMBRE_INGEST_SECRET,CF_API_TOKEN,R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY \
#                          -e TIMBRE_NIGHTLY_ENABLED=1 -e TIMBRE_COMPUTE=hf_gpu -e TIMBRE_APP_URL=https://<eta-app-host> \
#                          <image with the ETA repo + tools/timbre/requirements.txt> bash tools/timbre/deploy/hf_job.sh
# Switch off: TIMBRE_NIGHTLY_ENABLED=0 on the schedule, or `hf jobs scheduled suspend <id>`.
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [ "${TIMBRE_JOB:-nightly}" = "turns" ]; then
  # Turn-level benchmark (tools/timbre/turns.py). Separate from the nightly pipeline.
  exec bash tools/timbre/deploy/turns_job.sh
fi
export TIMBRE_COMPUTE="${TIMBRE_COMPUTE:-hf_gpu}"
exec python -m tools.timbre.nightly run --config "${TIMBRE_NIGHTLY_CONFIG:-tools/timbre/deploy/nightly.example.json}"
