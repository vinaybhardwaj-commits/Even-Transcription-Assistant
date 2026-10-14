#!/usr/bin/env bash
# Repeat proof for a trainer variant: two identical short runs (same manifest, seed, flags) -> identical last/best weights hashes and count curves.
# usage (GPU box, NeMo venv active): repeat_proof_variant.sh <tag> <manifest_id> <extra trainer flags...>
set -uo pipefail
TAG=$1; MID=$2; shift 2; export DIARLAB_GIT_SHA=proof-$TAG; cd "$(dirname "$0")"
for i in 1 2; do
  flock $HOME/gpu.lock python train_nemotron.py --manifest ~/eta-train/datasets/$MID.json --data-dir ~/eta-train/real-export --out-dir ~/eta-train/runs/nemotron-proof-$TAG$i \
     --max-steps 30 --warmup-steps 2 --batch-size 8 --val-audio-16k-dir ~/eta-train/val-16k --v5-audio-dir ~/eta-lab-night/nemotron/audio/v5 \
     --count-every 10 --count-target 0.0 --count-patience 99 "$@" > ~/eta-train/nemotron-proof-$TAG$i.log 2>&1
  rc=$?; echo "$(date -Iseconds) [nemotron-train] proof-$TAG$i rc=$rc" >> ~/eta-lab-night/logs/diar-lab.log; sleep 2
done
echo "$(date -Iseconds) [nemotron-train] proof-$TAG DONE" >> ~/eta-lab-night/logs/diar-lab.log
