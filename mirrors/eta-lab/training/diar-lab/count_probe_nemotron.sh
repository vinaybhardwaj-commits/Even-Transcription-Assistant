#!/usr/bin/env bash
# Count-drift probe on the CLEAN split (run 2 showed the count collapsing within 50 steps at lr 1e-5). Full count curve, never early-stops.
# usage (GPU box, NeMo venv active): count_probe_nemotron.sh <git_sha>
set -uo pipefail
export DIARLAB_GIT_SHA=$1; cd "$(dirname "$0")"; MID=diar-train-clean-2026-09-24-13537f4e
run() { tag=$1; shift
  flock $HOME/gpu.lock python train_nemotron.py --manifest ~/eta-train/datasets/$MID.json --data-dir ~/eta-train/real-export --out-dir ~/eta-train/runs/nemotron-probe-$tag \
     --val-audio-16k-dir ~/eta-train/val-16k --v5-audio-dir ~/eta-lab-night/nemotron/audio/v5 --count-every 25 --count-target 0.0 --count-patience 99 --seed 42 "$@" > ~/eta-train/nemotron-probe-$tag.log 2>&1
  rc=$?; echo "$(date -Iseconds) [nemotron-probe] $tag rc=$rc" >> ~/eta-lab-night/logs/diar-lab.log; }
run p1 --max-steps 300 --lr 2e-6 --warmup-steps 20 --batch-size 8 --session-len-sec 105
run p2 --max-steps 300 --lr 2e-6 --warmup-steps 20 --batch-size 4 --session-len-sec 300
echo "$(date -Iseconds) [nemotron-probe] DONE" >> ~/eta-lab-night/logs/diar-lab.log
