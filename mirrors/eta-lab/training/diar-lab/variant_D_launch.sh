#!/usr/bin/env bash
# The EXACT launch of the ONE pre-registered variant D run (PREREG-D.md e1edcca; ruling 210; refuter #894 condition (a)). Run on the box:  training/diar-lab/variant_D_launch.sh
# Fixed: manifest c4585089 (adopted production-matched val), B2 sampler (crops of >8-speaker windows, production-target balance [no-op], 300 s sessions, nspk_bias 4, batch 2),
# full fine-tune lr 1e-5 warmup 20 seed 42 bf16, max 300 steps, checkpoint scored every 25, patience 6 on val DER, MinorWeightedBCE gamma .5 cap 4, GRACEFUL 3 h cap (Lightning max_time).
# nemotron_pipeline.sh then evaluates the val-DER-selected checkpoint ONCE on V5 + bench20 and scores it. No second try, no post-hoc changes.
set -eu
cd "$(dirname "$0")/../.."
ID=diar-train-clean-2026-09-24-c4585089
EXTRA_FLAGS="--crop-over8 --balance-hist ~/eta-train/datasets/production-count-hist-2026-09-24.json --session-len-sec 300 --batch-size 2 --subsegment-nspk-bias 4 \
--minor-weighted-bce --minor-weight-gamma 0.5 --minor-weight-cap 4.0 --select-metric der --max-time 00:03:00:00" \
COUNT_EVERY=25 COUNT_PATIENCE=6 exec training/diar-lab/nemotron_pipeline.sh "$ID" 300 1e-5
