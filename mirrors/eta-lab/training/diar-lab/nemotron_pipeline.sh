#!/bin/bash
# Nemotron fine-tune, unattended: (nightly export + verified merge + rebuild proof are done by nightly_pipeline.sh / first_real_run.sh up to the dataset).
# usage: nemotron_pipeline.sh <dataset_id> [max_steps] [lr] ; run on the box. Progress -> gcp-l4 ~/eta-lab-night/logs/diar-lab.log
# Steps: sync -> train on gcp-l4 under gpu.lock -> fetch run record -> second copy on the box (+sha256 in record) -> eval best .nemo on V5 + bench20
#        -> score vs base Nemotron / stock 3.1 / pyannote.ai -> commit. GATE: do not run before the refuter has passed the Nemotron build (ruling 24e).
set -u
ID=$1; STEPS=${2:-300}; LR=${3:-1e-5}   # env: EXTRA_FLAGS (trainer variant flags), COUNT_EVERY, COUNT_PATIENCE
LAB=~/dev/eta-lab; ROOT=$LAB/training/diar-lab; G="ssh gcp-l4"; M=$LAB/datasets/$ID.json
NV=/home/vinay_bhardwaj/eta-lab-night/nemotron/venv-nemo-main   # gcp-l4 path (absolute: a local ~ would expand to the box home)
log() { $G "echo \"\$(date -Iseconds) [nemotron-pipe] $*\" >> ~/eta-lab-night/logs/diar-lab.log"; echo "$(date -Iseconds) $*"; }
SHA=$(cd $LAB && git rev-parse HEAD)
$ROOT/prep_val16k.sh $M || { log "FAILED val 16k prep"; exit 1; }
rsync -az $ROOT/ gcp-l4:~/eta-lab-night/diar-lab/code/training/diar-lab/ && rsync -az $M gcp-l4:~/eta-train/datasets/ \
  && rsync -az ~/eta-data/diar-train/ gcp-l4:~/eta-train/real-export/ || { log "FAILED sync"; exit 1; }
log "train start ($ID steps=$STEPS lr=$LR seed=42)"
$G "touch ~/eta-train/.nemo-pipe-start"
$G "cd ~/eta-lab-night/diar-lab/code/training/diar-lab && source $NV/bin/activate && export DIARLAB_GIT_SHA=$SHA && rm -rf ~/eta-train/runs/$ID-nemotron && \
  flock ~/gpu.lock python train_nemotron.py --manifest ~/eta-train/datasets/$ID.json --data-dir ~/eta-train/real-export \
  --out-dir ~/eta-train/runs/$ID-nemotron --max-steps $STEPS --lr $LR --seed 42 --val-audio-16k-dir ~/eta-train/val-16k --v5-audio-dir ~/eta-lab-night/nemotron/audio/v5 --count-every ${COUNT_EVERY:-50} --count-target 0.2 --count-patience ${COUNT_PATIENCE:-4} ${EXTRA_FLAGS:-} >> ~/eta-lab-night/logs/diar-lab.log 2>&1"
REC=$($G "find ~/eta-lab-night/diar-lab/code/runs -name 'run-*nemotron*.json' -newer ~/eta-train/.nemo-pipe-start | sort | tail -1")
[ -n "$REC" ] || { log "FAILED: training wrote no new run record (see gcp-l4 log)"; exit 1; }
RID=$(basename $REC .json)
scp -q gcp-l4:$REC $LAB/runs/ || { log "FAILED fetch run record"; exit 1; }
STATUS=$(python3 -c "import json;print(json.load(open('$LAB/runs/$RID.json'))['status'])"); log "train end: $RID status=$STATUS stop=$(python3 -c "import json;d=json.load(open('$LAB/runs/$RID.json'));print(d.get('stop_reason'),'best_step',d.get('best_step'))")"
[ "$STATUS" = "OK" ] || { log "training failed, see run record"; (cd $LAB && git add runs/$RID.json && git commit -q -m "diar-lab: failed nemotron run record $RID" && git pull -q --no-rebase --no-edit origin main && git push -q origin main); exit 1; }
mkdir -p /home/eta/eta-train/runs/$RID && rsync -az gcp-l4:~/eta-train/runs/$ID-nemotron/ /home/eta/eta-train/runs/$RID/
python3 $ROOT/record_copies.py $LAB/runs/$RID.json $RID; log "second copy recorded rc=$?"
NEMO=$(python3 -c "import json;d=json.load(open('$LAB/runs/$RID.json'));print(d.get('best_nemo_path') or d['last_nemo_path'])")
log "eval start with $(basename $NEMO)"
for pair in "v5:audio/v5" "bake20:audio/bake20"; do
  n=${pair%%:*}; d=${pair#*:}
  $G "cd ~/eta-lab-night/nemotron && source $NV/bin/activate && flock ~/gpu.lock python nemo_run.py --audio-dir $d --nemo-path $NEMO --out ~/eta-train/runs/$ID-nemotron/ft_${n}.json --device cuda >> ~/eta-lab-night/logs/diar-lab.log 2>&1"
done
STUDY=$LAB/studies/2026-09-24-nemotron-bakeoff; TAG=ft-$RID
scp -q gcp-l4:~/eta-train/runs/$ID-nemotron/ft_v5.json $STUDY/${TAG}_v5.json && scp -q gcp-l4:~/eta-train/runs/$ID-nemotron/ft_bake20.json $STUDY/${TAG}_bake20.json || { log "FAILED fetch eval"; exit 1; }
~/lab/venv/bin/python $ROOT/score_nemotron.py $STUDY $TAG > $STUDY/${TAG}_scores.txt 2>&1; log "eval scored rc=$?"
(cd $LAB && git add studies/2026-09-24-nemotron-bakeoff runs/$RID.json && git commit -q -m "diar-lab: Nemotron fine-tune $RID (V5 + bench20 vs pyannote.ai)" && git pull -q --no-rebase --no-edit origin main && git push -q origin main)
log "ALL DONE $RID"
