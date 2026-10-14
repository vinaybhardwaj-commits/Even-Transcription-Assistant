#!/bin/bash
# First real segmentation fine-tune, unattended (orders/queue/eta-lab-t4:diar-lab/001-diar-lab-2.md).
# usage: first_real_run.sh [HH:MM IST] [epochs] ; run on the box (eta-lab-t4). Progress -> gcp-l4 ~/eta-lab-night/logs/diar-lab.log
set -u
TARGET=${1:-04:00}; EPOCHS=${2:-8}
LAB=~/dev/eta-lab; ROOT=$LAB/training/diar-lab; BOXLAB=~/eta-data/diar-lab
G="ssh gcp-l4"
log() { $G "echo \"\$(date -Iseconds) [first-real] $*\" >> ~/eta-lab-night/logs/diar-lab.log"; echo "$(date -Iseconds) $*"; }
now=$(TZ=Asia/Kolkata date +%s); tgt=$(TZ=Asia/Kolkata date -d "today $TARGET" +%s)
[ "$tgt" -le "$now" ] || sleep $((tgt-now))
source ~/lab/venv/bin/activate
log "start: export + verified merge"
(cd $ROOT && python3 nightly_export.py) 2>&1 | tail -2
M=$(cd $ROOT && python3 merge_manifests.py) || { log "FAILED merge"; exit 1; }
ID=$(basename $M .json); N=$(python3 -c "import json;print(len(json.load(open('$M'))['windows']))")
log "dataset $ID: $N verified windows"
(cd $LAB && git add datasets/$ID.json && git commit -q -m "diar-lab: first-real-run dataset manifest $ID ($N windows)" && git pull -q --no-rebase --no-edit origin main && git push -q origin main) 2>&1 | tail -1
SHA=$(cd $LAB && git rev-parse HEAD)

log "rebuild proof: re-fetching all $N windows from Scribe into a clean dir"
rm -rf ~/eta-data/diar-train-rebuild-$ID
(cd $ROOT && python3 build_dataset.py $M --out-dir ~/eta-data/diar-train-rebuild-$ID) > /tmp/rebuild-$ID.log 2>&1; PRC=$?
PROOF=$(tail -1 /tmp/rebuild-$ID.log); log "rebuild proof rc=$PRC :: $PROOF"

rsync -az $ROOT/ gcp-l4:~/eta-lab-night/diar-lab/code/training/diar-lab/ && rsync -az $M gcp-l4:~/eta-train/datasets/ \
  && rsync -az ~/eta-data/diar-train/ gcp-l4:~/eta-train/real-export/ || { log "FAILED sync"; exit 1; }
log "train start (epochs=$EPOCHS lr=5e-5 seed=42)"
$G "cd ~/eta-lab-night/diar-lab/code/training/diar-lab && source ~/eta-lab-night/diar-lab/venv/bin/activate && \
  export CUBLAS_WORKSPACE_CONFIG=:4096:8 DIARLAB_GIT_SHA=$SHA && rm -rf ~/eta-train/runs/$ID && \
  flock ~/gpu.lock python train_segmentation.py --manifest ~/eta-train/datasets/$ID.json --data-dir ~/eta-train/real-export \
  --out-dir ~/eta-train/runs/$ID --max-epochs $EPOCHS --lr 5e-5 --seed 42 --num-workers 0 --device cuda >> ~/eta-lab-night/logs/diar-lab.log 2>&1"
REC=$($G "ls -t ~/eta-lab-night/diar-lab/code/runs/run-*.json | head -1"); RID=$(basename $REC .json)
scp -q gcp-l4:$REC $LAB/runs/ || { log "FAILED fetch run record"; exit 1; }
STATUS=$(python3 -c "import json;print(json.load(open('$LAB/runs/$RID.json'))['status'])"); log "train end: $RID status=$STATUS"
[ "$STATUS" = "SMOKE_OK" ] || [ "$STATUS" = "OK" ] || { log "training failed, see run record"; (cd $LAB && git add runs/$RID.json && git commit -q -m "diar-lab: failed run record $RID" && git pull -q --no-rebase --no-edit origin main && git push -q origin main); exit 1; }

# second copy on the box + both paths/sha256 in the run record
mkdir -p /home/eta/eta-train/runs/$RID && rsync -az gcp-l4:~/eta-train/runs/$ID/ /home/eta/eta-train/runs/$RID/
python3 $ROOT/record_copies.py $LAB/runs/$RID.json $RID; log "second copy recorded rc=$?"

# evaluate: fine-tuned segmentation swapped into the stock 3.1 pipeline, on V's 5 + the 20 bench windows
CK=$($G "python3 -c \"import json;d=json.load(open('$REC'));print(d.get('best_val_checkpoint_path') or d['checkpoint_path'])\"")
log "eval start with $(basename $CK)"
$G "cd ~/eta-lab-night/diar-lab/code/training/diar-lab/eval && source ~/eta-lab-night/diar-lab/venv/bin/activate && \
  DIARLAB_DATA_DIR=~/eta-lab-night/diar-lab/data flock ~/gpu.lock python diar_run.py --model pyannote/speaker-diarization-3.1 --segmentation-ckpt $CK --out ~/eta-train/runs/$ID/eval_v5.json --device cuda >> ~/eta-lab-night/logs/diar-lab.log 2>&1 && \
  DIARLAB_DATA_DIR=~/eta-lab-night/diar-lab/data/bake20 flock ~/gpu.lock python diar_run20.py --model pyannote/speaker-diarization-3.1 --api 3 --segmentation-ckpt $CK --out ~/eta-train/runs/$ID/eval_bake20.json --device cuda >> ~/eta-lab-night/logs/diar-lab.log 2>&1"
STUDY=$LAB/studies/2026-09-24-diar-finetune; mkdir -p $STUDY
scp -q gcp-l4:~/eta-train/runs/$ID/eval_v5.json gcp-l4:~/eta-train/runs/$ID/eval_bake20.json $STUDY/ || { log "FAILED fetch eval"; exit 1; }
rsync -az gcp-l4:~/eta-train/runs/$ID/ /home/eta/eta-train/runs/$RID/
python3 $ROOT/summarize_eval.py $STUDY $STUDY/eval_v5.json $STUDY/eval_bake20.json $RID > /tmp/summ-$ID.txt 2>&1; log "eval summarized rc=$?"
(cd $LAB && git add studies/2026-09-24-diar-finetune runs/$RID.json && git commit -q -m "diar-lab: first real segmentation fine-tune $RID vs stock 3.1 (V's 5 + bench20, scored against pyannote.ai)" && git pull -q --no-rebase --no-edit origin main && git push -q origin main) 2>&1 | tail -1
log "ALL DONE $RID"
