#!/usr/bin/env bash
# tools/nemotron-worker/nemotron-worker.sh — start | stop | status | logs for the box worker. Run ON the box.
#
#   ./nemotron-worker.sh start           # talks to https://www.evenscribe.app (the default; nothing else without an override)
#   ./nemotron-worker.sh status
#   ./nemotron-worker.sh stop
#
# Runs worker.py under nice -n 10 / ionice idle with nohup; pid, log and status file under ~/.local/state/eta-nemotron
# (0700). The token comes from NEMOTRON_TOKEN_FILE (default ~/.config/eta-nemotron/token, must be mode 0600).
# stop sends SIGTERM and waits up to STOP_WAIT_S (180 s; at least 150) for the window in hand to be posted; it never
# sends SIGKILL itself. Another base URL needs NEMOTRON_BASE_URL plus NEMOTRON_ALLOW_OTHER_BASE_URL=1 (worker.py enforces it).
# Other knobs (all optional): NEMOTRON_PYTHON, NEMOTRON_CONCURRENCY, NEMOTRON_RATE_PER_HOUR, NEMOTRON_MIN_FREE_VRAM_MIB,
# NEMOTRON_GPU_LOCK, NEMOTRON_TMP_ROOT, NEMOTRON_FINETUNE_CKPT (unset = stock model), NEMOTRON_WORKER_ID, NEMOTRON_LAB (0 = never ask the lab lane),
# NEMOTRON_MACHINE (box = default; hf = the OVERFLOW worker, claimed for by the server only above its backlog threshold and under its daily cost cap),
# NEMOTRON_TITANET_NEMO / NEMOTRON_ECAPA_DIR (local embedder files for lab jobs; unset = embedder_unavailable).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${NEMOTRON_STATE_DIR:-$HOME/.local/state/eta-nemotron}"
PY="${NEMOTRON_PYTHON:-$HOME/eta-data/nemotron/venv-nemo-main/bin/python}"
PIDFILE="$STATE_DIR/worker.pid"
STOP_WAIT_S=180
LOG="$STATE_DIR/worker.log"
export NEMOTRON_STATE_FILE="${NEMOTRON_STATE_FILE:-$STATE_DIR/status.json}"

running_pid() {
  [[ -f "$PIDFILE" ]] || return 1
  local pid; pid="$(cat "$PIDFILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && grep -q "worker.py" "/proc/$pid/cmdline" 2>/dev/null && echo "$pid"
}

case "${1:-}" in
  start)
    if pid="$(running_pid)"; then echo "already running pid=$pid"; exit 0; fi
    mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
    cd "$HERE"
    HF_HUB_OFFLINE=1 TQDM_DISABLE=1 nohup nice -n 10 ionice -c 3 "$PY" "$HERE/worker.py" >>"$LOG" 2>&1 </dev/null &
    echo $! >"$PIDFILE"
    sleep 3
    if pid="$(running_pid)"; then echo "started pid=$pid log=$LOG"; else echo "failed to start; tail of log:"; tail -n 5 "$LOG"; exit 1; fi
    ;;
  stop)
    if ! pid="$(running_pid)"; then echo "not running"; rm -f "$PIDFILE"; exit 0; fi
    kill -TERM "$pid"
    for _ in $(seq 1 "$STOP_WAIT_S"); do kill -0 "$pid" 2>/dev/null || { echo "stopped pid=$pid"; rm -f "$PIDFILE"; exit 0; }; sleep 1; done
    echo "still running after $STOP_WAIT_S s (pid=$pid): a window is mid-post; run stop again, or kill -KILL $pid to abandon it"; exit 1
    ;;
  status)
    if pid="$(running_pid)"; then echo "running pid=$pid"; else echo "not running"; fi
    [[ -f "$NEMOTRON_STATE_FILE" ]] && cat "$NEMOTRON_STATE_FILE" && echo
    nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader 2>/dev/null || true
    ;;
  logs)
    tail -n "${2:-40}" "$LOG"
    ;;
  *)
    echo "usage: $0 start|stop|status|logs [N]"; exit 2
    ;;
esac
