#!/usr/bin/env bash
# run_e2e_lane1.sh — HF-4: start/stop/pause/inspect the per-GPU workers ON THE NODE.   NODE_ROOT=/srv/e2e-lane1 NODE=<name> bash run_e2e_lane1.sh start [N_GPUS] | status | pause | resume | stop
#   start: one nohup worker per GPU (CUDA_VISIBLE_DEVICES=i), per-worker log run/logs/gpuI.log; refuses to start a GPU whose worker is already alive. PAUSE/STOP are files in run/ (only workers look at them).
#   status: ONE progress line  done=.. failed=.. to_go=.. total=.. rate_last60m=../h rate_overall=../h workers_alive=..
set -euo pipefail
NODE_ROOT="${NODE_ROOT:-/srv/e2e-lane1}"; RUN="$NODE_ROOT/run"; CODE="$NODE_ROOT/code"; PY="$NODE_ROOT/venv/bin/python"
cmd="${1:-status}"; NODE="${NODE:-$(hostname | tr 'A-Z_.' 'a-z--' | tr -cd 'a-z0-9-')}"
case "$cmd" in
  start)
    N="${2:-$(nvidia-smi --query-gpu=index --format=csv,noheader | wc -l)}"; [ -f "$RUN/worklist.jsonl" ] || { echo "no $RUN/worklist.jsonl"; exit 2; }
    rm -f "$RUN/STOP"; TOTAL=$(grep -c . "$RUN/worklist.jsonl"); [ -s "$RUN/started_at" ] || date +%s > "$RUN/started_at"
    for ((i=0;i<N;i++)); do
      if [ -f "$RUN/gpu$i.pid" ] && kill -0 "$(cat "$RUN/gpu$i.pid")" 2>/dev/null; then echo "gpu$i already running"; continue; fi
      CUDA_VISIBLE_DEVICES=$i HF_HOME="$NODE_ROOT/hf" HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 TOKENIZERS_PARALLELISM=false nohup "$PY" "$CODE/e2e_worker.py" --worklist "$RUN/worklist.jsonl" \
        --audio "$NODE_ROOT/audio" --out "$NODE_ROOT/out" --claims "$NODE_ROOT/claims" --run-dir "$RUN" --node "$NODE" --gpu "$i" --gpu-index-offset $((i * TOTAL / N)) >> "$RUN/logs/gpu$i.log" 2>&1 < /dev/null &
      echo $! > "$RUN/gpu$i.pid"; echo "started gpu$i pid $!"
    done ;;
  pause) touch "$RUN/PAUSE"; echo paused ;;
  resume) rm -f "$RUN/PAUSE"; echo resumed ;;
  stop) touch "$RUN/STOP"; echo "STOP set: workers exit after the current window" ;;
  status) exec python3 "$CODE/progress.py" --node-root "$NODE_ROOT" ;;
  *) echo "usage: $0 start [N]|status|pause|resume|stop"; exit 2 ;;
esac
