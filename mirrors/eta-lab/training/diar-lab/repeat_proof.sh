#!/bin/bash
# Repeatability proof on gcp-l4: two identical 1-epoch fine-tunes, then compare. usage: repeat_proof.sh <git_sha>
cd ~/eta-lab-night/diar-lab/code/training/diar-lab; source ~/eta-lab-night/diar-lab/venv/bin/activate
export CUBLAS_WORKSPACE_CONFIG=:4096:8 DIARLAB_GIT_SHA=$1
for i in 1 2; do rm -rf ~/eta-train/runs/repeat-$i
  flock ~/gpu.lock python train_segmentation.py --manifest ~/eta-train/datasets/diar-train-smoke-2026-09-23.json \
    --data-dir ~/eta-train/materialized --out-dir ~/eta-train/runs/repeat-$i --max-epochs 1 --lr 5e-5 --seed 42 --num-workers 0 --device cuda \
    >> ~/eta-lab-night/logs/diar-lab.log 2>&1; done
echo "$(date -Iseconds) [repeat-proof] ALL DONE sha=$1" >> ~/eta-lab-night/logs/diar-lab.log
