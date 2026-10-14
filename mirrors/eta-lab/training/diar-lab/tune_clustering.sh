#!/usr/bin/env bash
# Phase-2 step 2: clustering-threshold re-tune for the fine-tuned segmentation, on HELD-OUT room-days only
# (val room-day + test-split windows of the dataset; never train windows, never the permanent bench/V5 set).
# usage: tune_clustering.sh <dataset_manifest> <ckpt_on_gcp-l4> <out_dir>   (run on the box)
set -uo pipefail
MAN=$1; CKPT=$2; OUT=$3; HELD=${4:-rd_yhh6kexm}
RH=$(ssh gcp-l4 'echo $HOME'); LAB=$RH/eta-lab-night/diar-lab; LOG=$RH/eta-lab-night/logs/diar-lab.log
mkdir -p "$OUT/ref" "$OUT/hyp"
python3 - "$MAN" "$HELD" "$OUT" <<'PY'
import json, sys, os, glob, subprocess
man, held, out = sys.argv[1:4]
m = json.load(open(man)); ids = []
for w in m["windows"]:
    if w["room_day_id"] == held or w["split"] == "test":
        ids.append(w["window_id"])
        rt = glob.glob(os.path.expanduser(f"~/eta-data/diar-train/*/{w['window_id']}.rttm"))[0]
        segs = [{"start": float(p[3]), "end": float(p[3]) + float(p[4]), "speaker": p[7]} for p in (l.split() for l in open(rt)) if p and p[0] == "SPEAKER"]
        json.dump({"output": {"diarization": segs}}, open(f"{out}/ref/{w['window_id']}_pyannote.json", "w"))
open(f"{out}/ids.txt", "w").write(",".join(ids)); print(len(ids), "held-out windows")
PY
IDS=$(cat "$OUT/ids.txt")
ssh gcp-l4 'mkdir -p ~/eta-lab-night/diar-lab/data/heldout && chmod 700 ~/eta-lab-night/diar-lab/data/heldout'
for id in ${IDS//,/ }; do scp -q ~/eta-data/diar-train/*/$id.wav gcp-l4:eta-lab-night/diar-lab/data/heldout/; done
scp -q "$OUT/ids.txt" gcp-l4:eta-lab-night/diar-lab/data/heldout/ids.txt
ssh gcp-l4 "bash -s" <<REMOTE
cd $LAB/code/training/diar-lab/eval && source $LAB/venv/bin/activate
export DIARLAB_DATA_DIR=$LAB/data/heldout
run() { tag=\$1; shift
  flock $RH/gpu.lock python diar_run20.py --api 3 --device cuda --out $LAB/out/heldout_\$tag.json "\$@" > $LAB/out/heldout_\$tag.log 2>&1; echo "[tune] \$tag rc=\$?" >> $LOG; }
[ -f $LAB/out/heldout_stock_default.json ] || run stock_default --model pyannote/speaker-diarization-3.1
run ft_default --segmentation-ckpt $CKPT
for t in 0.45 0.55 0.65 0.75 0.85; do run ft_t\$t --segmentation-ckpt $CKPT --min-speakers 2 --max-speakers 8 --clustering-threshold \$t; done
echo "[tune] DONE" >> $LOG
REMOTE
scp -q "gcp-l4:eta-lab-night/diar-lab/out/heldout_*.json" "$OUT/hyp/"
