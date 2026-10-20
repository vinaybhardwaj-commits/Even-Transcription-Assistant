#!/bin/bash
# ft-bench: run calibration + benchmark comparison on the FROZEN FULL model (spec s6/s7). D only.
# Usage: run_frozen.sh '<glob of frozen-model JSONs with FTR-format "oof" blocks (lab, design, oof{episode_id,y,cluster,by_model_repeat})>' [models]
# Example: run_frozen.sh "$HOME/oc/forest-lead/ft/out/ft-final/model_B_*.json" FULL,L0
set -euo pipefail
cd "$(dirname "$0")/.."; PY=$HOME/.venv-forest/bin/python; O=$HOME/oc/forest-lead/ft/out/ft-bench; G=$1; M=${2:-}
TAG=frozen-$(date +%H%M)
for f in $G; do $PY code/calib.py oof "$f" ${M:+--models $M}; done > $O/CALIB-$TAG.md
# benchmark deltas vs the frozen forest: bench_score.py reads FOREST; set FOREST_MODELS=FULL:text_audio,L0:base to map frozen model names
FOREST="$G" FOREST_MODELS=${FOREST_MODELS:-} OUT_TAG=-$TAG $PY code/bench_score.py > /dev/null
chmod 600 $O/CALIB-$TAG.md $O/BENCH-TABLES-$TAG.md
echo "wrote $O/CALIB-$TAG.md $O/BENCH-TABLES-$TAG.md"
