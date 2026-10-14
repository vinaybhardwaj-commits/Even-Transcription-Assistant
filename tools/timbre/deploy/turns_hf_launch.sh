#!/usr/bin/env bash
# Launch the turn-level benchmark on HF l4x1 (run from the repo root, on a machine that holds the keys).
#   tools/timbre/deploy/turns_hf_launch.sh PLAN.jsonl
# Ships the small set of code files and the plan as env (the branch is not pushed). Secrets are passed by
# NAME from the local environment (hf --secrets NAME), never as values. Prints the job id only.
# Pause rule: the job exits by itself; check `hf jobs inspect <id>` and record cost = hours x $0.80.
set -euo pipefail
PLAN="${1:?plan.jsonl}"
IMAGE="${TIMBRE_IMAGE:-pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime}"
FILES=$(git ls-files tools/timbre | grep -E '^tools/timbre/(__init__|audio|catalog|mem|r2audio|vad|turns|turns_bench)\.py$|^tools/timbre/extractors/|^tools/timbre/deploy/(hf_job|turns_job)\.sh$|^tools/timbre/requirements-turns\.txt$')
# Pack HEAD, never the working tree, and refuse to run on a dirty tree.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "working tree is dirty: commit first" >&2; exit 2; fi
CODE_B64=$(git archive --format=tar.gz HEAD -- $FILES | base64 -w0)
PLAN_B64=$(gzip -9 < "$PLAN" | base64 -w0)
[ "${#CODE_B64}" -lt 120000 ] && [ "${#PLAN_B64}" -lt 120000 ] || { echo "payload too large for env" >&2; exit 2; }
exec hf jobs run --detach --flavor l4x1 --timeout "${TIMBRE_JOB_TIMEOUT:-90m}" --name timbre-turns-bench \
  --secrets HF_TOKEN --secrets R2_ENDPOINT --secrets R2_ACCESS_KEY_ID --secrets R2_SECRET_ACCESS_KEY \
  -e TIMBRE_JOB=turns -e "TIMBRE_GIT_SHA=$(git rev-parse HEAD)" \
  -e "TIMBRE_TURNS_CODE_B64=$CODE_B64" -e "TIMBRE_TURNS_PLAN_B64=$PLAN_B64" \
  "$IMAGE" bash -c 'mkdir -p /app && echo "$TIMBRE_TURNS_CODE_B64" | base64 -d | tar xz -C /app && cd /app && bash tools/timbre/deploy/hf_job.sh'
