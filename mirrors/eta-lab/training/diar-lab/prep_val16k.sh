#!/usr/bin/env bash
# Convert a manifest's val windows to 16 kHz mono wav (gcp-l4 has no ffmpeg) and rsync them to gcp-l4 ~/eta-train/val-16k/. Run on the box.
# usage: prep_val16k.sh <dataset_manifest.json>
set -euo pipefail
M=$1; OUT=~/eta-data/diar-train-16k-val; mkdir -p $OUT; chmod 700 $OUT
python3 - "$M" <<'PY' | while read -r ist wid; do ffmpeg -nostdin -y -loglevel error -i ~/eta-data/diar-train/"$ist"/"$wid".wav -ar 16000 -ac 1 -c:a pcm_s16le $OUT/$wid.wav; done
import json, sys
for w in json.load(open(sys.argv[1]))["windows"]:
    if w["split"] == "val": print(w["ist_date"], w["window_id"])
PY
ssh gcp-l4 'mkdir -p ~/eta-train/val-16k && chmod 700 ~/eta-train/val-16k'
rsync -az $OUT/ gcp-l4:eta-train/val-16k/
echo "val 16k windows: $(ls $OUT | wc -l)"
