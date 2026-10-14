#!/bin/bash
# run_lane3.sh — HF-3/3c: run lane 3 on HF-1 under nohup, resumable (the job skips finished windows). HF-3c: the job runs entirely from LOCAL disk (L3_LOCAL, default /tmp/lane3-local, built by stage_local.sh);
# /data/lane3 (hf-mount FUSE) is only where finished out/<family>/<win>.json are mirrored (atomic, never overwritten) and logs are copied. Refuses unless the local READY marker matches this job sha16.
#   bash /data/lane3/bin/run_lane3.sh <indic|sravaani|all> <windows.json> [--limit N]      <windows.json> = the copy staged in $L/bin (basename is used). logs: local $L/work/job-<family>-<ts>.log, mirrored to /data/lane3/work ; pid + PAUSE/STOP: /data/lane3/work
set -euo pipefail
P=${L3_PERSIST:-/data/lane3}; L=${L3_LOCAL:-/tmp/lane3-local}; JOB="$L/bin/lane3_cpu_job.py"
want=ab5cef4fd47825e9; have=$(sha256sum "$JOB" | cut -c1-16); [ "$have" = "$want" ] || { echo "REFUSED: job sha16 $have != pinned $want"; exit 3; }
python3 "$L/bin/stage_local.py" marker-check --root "$L" --want-job "$want" || { echo "run stage_local.sh first"; exit 3; }
SELF=$(readlink -f "$0"); mkdir -p "$P/work" "$P/out"
if [ "${1:-}" != "--inner" ]; then
  fam=${1:?family}; win=${2:?windows.json}; [ -e "$P/work/PAUSE" ] && { echo "PAUSE file present, not starting"; exit 0; }
  setsid nohup bash "$SELF" --inner "$@" > /dev/null 2>&1 < /dev/null &
  echo $! > "$P/work/run.pid"; echo "started pid $(cat "$P/work/run.pid"); logs $L/work/job-<family>-<ts>.log (mirrored to $P/work); touch $P/work/STOP to stop after the current family"; exit 0
fi
shift; fam=$1; win=$2; shift 2; [ -f "$win" ] || win="$L/bin/$(basename "$win")"
export L3_ROOT="$L" EXPECT_SCRIPT_SHA16=$want HELDOUT_SHA16=f672c1ef046089dd EXPECT_BLIND_SHA16=56f5999c3c5ed1a0 HF_HUB_CACHE="$L/hf_home/hub" HF_HOME="$L/hf_home" OMP_NUM_THREADS=${L3_THREADS:-8}
SN=$L/hf_home/hub
if [ -d "$SN/models--ai4bharat--indic-conformer-600m-multilingual/snapshots/e9b71b369c048e2c6b634d4c131061c34e441179" ] && [ -d "$SN/models--ARTPARK-IISc--SraVaani-1.0/snapshots/f5dd5358325a5208775b91dad98918e079ea2b27" ]; then
  export HF_HUB_OFFLINE=1 L3_OFFLINE=1        # HF-3b: staged pinned snapshots => fully offline, the token file is neither read nor needed
else
  [ -s "$L/.hf_ro_token" ] && [ "$(stat -c %a "$L/.hf_ro_token")" = "600" ] && export HF_TOKEN="$(cat "$L/.hf_ro_token")"      # fallback only
fi
fams=$fam; [ "$fam" = all ] && fams="indic sravaani"
ts=$(date +%Y%m%d-%H%M%S)
mirror() { python3 "$L/bin/stage_local.py" mirror --src "$L/out" --dst "$P/out" --logs "$L/work" --logs-dst "$P/work" >> "$L/work/mirror-$ts.log" 2>&1 || echo "mirror failed (will retry)" >> "$L/work/mirror-$ts.log"; }
for f in $fams; do
  [ -e "$P/work/STOP" ] && break
  v=venv-indic; [ "$f" = sravaani ] && v=venv-sra
  ( nice -n 5 "$L/$v/bin/python" "$JOB" --family "$f" --windows "$win" "$@" > "$L/work/job-$f-$ts.log" 2>&1 || echo "family $f exited non-zero (traceback above)" >> "$L/work/job-$f-$ts.log" ) &
  jp=$!
  while kill -0 "$jp" 2>/dev/null; do sleep 20; mirror; done            # after each finished window (<=20 s later): copy to /data
  wait "$jp" || true; mirror                                              # final pass incl. the log with any traceback
done
