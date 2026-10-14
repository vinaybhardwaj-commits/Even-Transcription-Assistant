#!/usr/bin/env bash
# Repeatability proof for train_nemotron.py: two identical short runs (same clean manifest, seed, config, incl. mid-training count scoring)
# must give identical last/best weights_sha256 AND identical count curves. usage (GPU box, NeMo venv active): repeat_proof_nemotron.sh <git_sha> [manifest_id]
set -uo pipefail
SHA=$1; MID=${2:-diar-train-clean-2026-09-24-13537f4e}; export DIARLAB_GIT_SHA=$SHA; cd "$(dirname "$0")"
for i in 1 2; do
  flock $HOME/gpu.lock python train_nemotron.py --manifest ~/eta-train/datasets/$MID.json --data-dir ~/eta-train/real-export --out-dir ~/eta-train/runs/nemotron-proof-clean$i \
     --max-steps 30 --warmup-steps 2 --batch-size 8 --val-audio-16k-dir ~/eta-train/val-16k --v5-audio-dir ~/eta-lab-night/nemotron/audio/v5 \
     --count-every 10 --count-target 0.0 --count-patience 99 > ~/eta-train/nemotron-proof-clean$i.log 2>&1
  rc=$?
  echo "$(date -Iseconds) [nemotron-train] cproof$i rc=$rc" >> ~/eta-lab-night/logs/diar-lab.log
  sleep 2
done
echo "$(date -Iseconds) [nemotron-train] cproof DONE" >> ~/eta-lab-night/logs/diar-lab.log
