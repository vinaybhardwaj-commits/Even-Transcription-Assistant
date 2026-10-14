#!/usr/bin/env bash
# Runs inside the HF Job (l4x1) for the turn-level benchmark. Started by hf_job.sh when TIMBRE_JOB=turns.
# Inputs (env): TIMBRE_TURNS_PLAN_B64 (gzip+base64 plan JSONL: times, speakers, roles; no text, no audio),
#               R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (read-only audio), HF_TOKEN.
# Output: the per-turn JSONL, printed to the job log as sha256-framed gzip+base64 lines
#         (TIMBRE_TURNS_BEGIN / PART / END). Nothing is written to R2 or any repo.
# Secrets are never echoed. The job exits when scoring is done; it does not wait for work.
set -euo pipefail
cd "$(dirname "$0")/../../.."
T0=$(date +%s)
log() { echo "[timbre-turns $(date -u +%FT%TZ) +$(( $(date +%s) - T0 ))s] $*"; }
export PYTHONPATH="$PWD" PYTHONUNBUFFERED=1 HF_HUB_DISABLE_TELEMETRY=1
if ! command -v ffmpeg >/dev/null 2>&1; then :; fi
(apt-get update -qq && apt-get install -y -qq libsndfile1 >/dev/null) 2>/dev/null || true
log "pip install"
TORCH_BEFORE=$(python -c "import torch;print(torch.__version__)")
pip install -q --no-cache-dir -r tools/timbre/requirements-turns.txt
[ "$(python -c 'import torch;print(torch.__version__)')" = "$TORCH_BEFORE" ] || { echo "torch changed by pip install: abort" >&2; exit 3; }
pip check || log "pip check reported conflicts (see above)"
python - <<'PY'
import torch, torchaudio
print("torchaudio", torchaudio.__version__)
print("torch", torch.__version__, "cuda", torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else "-")
PY
umask 077
echo "${TIMBRE_TURNS_PLAN_B64:?plan missing}" | base64 -d | gunzip > /tmp/plan.jsonl
log "plan: $(wc -l < /tmp/plan.jsonl) clips"
export TIMBRE_GIT_SHA="${TIMBRE_GIT_SHA:-unknown}"
python -m tools.timbre.turns score --plan /tmp/plan.jsonl --out /tmp/turns.jsonl --workdir /tmp/audio --device cuda
log "scored; emitting"
python -m tools.timbre.turns emit --file /tmp/turns.jsonl
log "done (job ends now)"
