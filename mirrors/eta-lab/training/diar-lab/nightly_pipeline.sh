#!/bin/bash
# Unattended: (wait until HH:MM IST) -> nightly export -> merge manifests -> commit manifest ->
# rsync data to gcp-l4 -> fine-tune under gcp-l4's gpu.lock. Progress lines go to gcp-l4's
# ~/eta-lab-night/logs/diar-lab.log. Usage: nightly_pipeline.sh [HH:MM] [epochs]
set -u
TARGET=${1:-07:30}; EPOCHS=${2:-5}
LAB=~/dev/eta-lab; ROOT=$LAB/training/diar-lab
log() { ssh gcp-l4 "echo \"\$(date -Iseconds) [nightly] $*\" >> ~/eta-lab-night/logs/diar-lab.log"; echo "$(date -Iseconds) $*"; }
now=$(TZ=Asia/Kolkata date +%s); tgt=$(TZ=Asia/Kolkata date -d "today $TARGET" +%s)
[ "$tgt" -le "$now" ] || sleep $((tgt-now))
source ~/lab/venv/bin/activate
log "export start"
(cd $ROOT && python3 nightly_export.py) 2>&1 | tail -3
M=$(cd $ROOT && python3 merge_manifests.py) || { log "FAILED merge"; exit 1; }
ID=$(basename $M .json); log "merged $ID ($(python3 -c "import json;print(len(json.load(open('$M'))['windows']))") windows)"
(cd $LAB && git add "datasets/$ID.json" && git commit -q -m "diar-lab: nightly merged training dataset $ID (manifest: ids+hashes only)" \
  && git pull -q --no-rebase --no-edit origin main && git push -q origin main) 2>&1 | tail -2
SHA=$(cd $LAB && git rev-parse HEAD)
rsync -az $ROOT/ gcp-l4:~/eta-lab-night/diar-lab/code/training/diar-lab/ && rsync -az $M gcp-l4:~/eta-train/datasets/ \
  && rsync -az ~/eta-data/diar-train/ gcp-l4:~/eta-train/real-export/ || { log "FAILED sync"; exit 1; }
log "train start $ID epochs=$EPOCHS"
ssh gcp-l4 "cd ~/eta-lab-night/diar-lab/code/training/diar-lab && source ~/eta-lab-night/diar-lab/venv/bin/activate && \
  export CUBLAS_WORKSPACE_CONFIG=:4096:8 DIARLAB_GIT_SHA=$SHA && rm -rf ~/eta-train/runs/$ID && \
  flock ~/gpu.lock python train_segmentation.py --manifest ~/eta-train/datasets/$ID.json --data-dir ~/eta-train/real-export \
  --out-dir ~/eta-train/runs/$ID --max-epochs $EPOCHS --seed 42 --num-workers 0 --device cuda >> ~/eta-lab-night/logs/diar-lab.log 2>&1"
log "train end rc=$?"
