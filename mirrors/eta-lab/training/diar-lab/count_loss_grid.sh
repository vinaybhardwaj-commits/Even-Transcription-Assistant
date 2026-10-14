#!/usr/bin/env bash
# Val-only weight grid for variants C (soft) and C' (sharp) on the B2 setup (refuter #288/#609: choose on VAL only; V5/bench20 scored ONCE later, on the val-chosen run).
# No V5/bench evaluation here. usage (GPU box, NeMo venv active): count_loss_grid.sh <git_sha>
set -uo pipefail
export DIARLAB_GIT_SHA=$1; cd "$(dirname "$0")"; MID=diar-train-clean-2026-09-24-c4585089
B2="--crop-over8 --balance-hist $HOME/eta-train/datasets/production-count-hist-2026-09-24.json --session-len-sec 300 --batch-size 2 --subsegment-nspk-bias 4"
run() { tag=$1; shift
  flock $HOME/gpu.lock python train_nemotron.py --manifest ~/eta-train/datasets/$MID.json --data-dir ~/eta-train/real-export --out-dir ~/eta-train/runs/nemotron-grid-$tag \
     --val-audio-16k-dir ~/eta-train/val-16k --v5-audio-dir ~/eta-lab-night/nemotron/audio/v5 --count-every 25 --count-target 0.2 --count-patience 6 --seed 42 \
     --max-steps 300 --lr 1e-5 --warmup-steps 20 $B2 "$@" > ~/eta-train/nemotron-grid-$tag.log 2>&1
  rc=$?; echo "$(date -Iseconds) [nemotron-grid] $tag rc=$rc" >> ~/eta-lab-night/logs/diar-lab.log; }
run Csoft0.3 --count-loss-weight 0.3 --count-loss-kind soft
run Csoft1   --count-loss-weight 1.0 --count-loss-kind soft
run Csoft3   --count-loss-weight 3.0 --count-loss-kind soft
run Csharp1  --count-loss-weight 1.0 --count-loss-kind sharp --count-loss-tau 0.1
run Csharp3  --count-loss-weight 3.0 --count-loss-kind sharp --count-loss-tau 0.1
echo "$(date -Iseconds) [nemotron-grid] DONE" >> ~/eta-lab-night/logs/diar-lab.log
