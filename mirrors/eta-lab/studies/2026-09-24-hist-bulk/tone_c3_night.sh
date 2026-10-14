#!/bin/bash
# tone_c3_night.sh — T-BACKFILL-2 tone lane on the c3 twins (Fable 8315 ruling 19, 30 Sep).
# Window: OFF-HOURS ONLY — starts at/after 20:45 IST, hard stop 07:55 IST (the loop self-checks both).
# Priority: BELOW LID E4/E2 and the CI gate — before each window the worker probes the c3 CI lock
# (/tmp/eta-ci-c3-ci.lock) non-blocking over ssh; if held (CI or LID working), it waits 60 s. Same
# contract as the STT c3 helper (herdr-kit #3350).
# Transport: ssh -L tunnel to the c3 twins (diarize 8001, emotion 8086, both cpu on c3); audio stays
# box-side until posted to the tunnel; c3 holds no copies after the request returns.
# Resume-safe: global O_EXCL claims + existing records, unchanged from the PASSed tone_backfill.
# Blind: heldout.py filter is MANDATORY (ruling 19) — added in tone_backfill (see the diff).
# Stops on: ~/eta-data/hist/tone/TONE_C3_STOP, or the 07:55 hard stop.
set -u
HD=~/eta-data/hist
LOG=$HD/tone/tone_c3_night.log
PY=~/.venv-r2/bin/python
D=~/dev/eta-lab/studies/2026-09-24-hist-bulk
log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') tone_c3[$$] $*" >> "$LOG"; }
stopped() { [ -e $HD/tone/TONE_C3_STOP ]; }
in_window() {
  local h m now
  h=$(date +%H); m=$(date +%M); now=$((10#$h * 60 + 10#$m))
  # window = 20:45 (1245) .. 07:55 (475), crossing midnight
  [ "$now" -ge 1245 ] || [ "$now" -le 475 ]
}
PIDF=$HD/tone/tone_c3.pid
if [ -f "$PIDF" ] && kill -0 "$(cat $PIDF)" 2>/dev/null; then log "already running pid $(cat $PIDF), refusing"; exit 1; fi
echo $$ > $HD/tone/tone_c3.pid
log "START pid=$$ (c3 tunnel lane; window 20:45-07:55; CI-lock respected)"
cleanup() {
  for P in $(pgrep -f "[t]one_backfill.py --run-id hist-bulk-tone-c3"); do kill "$P" 2>/dev/null; done
  for P in $(pgrep -f "ssh -f -N -L 18001"); do kill "$P" 2>/dev/null; done
  rm -f $HD/tone/tone_c3.pid
  log "EXIT: workers + tunnel stopped, PID file removed"
}
trap cleanup EXIT
# wait for the window to open (no-op if already inside)
while ! in_window; do
  stopped && { log "STOP before window"; exit 0; }
  log "waiting for the 20:45 window (now outside 20:45-07:55)"
  sleep 600
done
# tunnel
ssh -f -N -L 18001:127.0.0.1:8001 -L 18086:127.0.0.1:8086 -o ExitOnForwardFailure=yes e2e-ci
log "tunnel up (18001->c3:8001, 18086->c3:8086)"
while ! stopped; do
  if ! in_window; then log "07:55 hard stop reached"; break; fi
  # CI/LID priority: probe the c3 CI lock non-blocking (fail-closed: held = wait)
  if ssh -o BatchMode=yes -o ConnectTimeout=15 e2e-ci "flock -n /tmp/eta-ci-c3-ci.lock true" 2>/dev/null; then
    LOCK=free
  else
    LOCK=held
  fi
  if [ "$LOCK" = "held" ]; then
    log "c3 CI lock held (CI/LID working): tone waits 60 s"
    sleep 60; continue
  fi
  C3SHA=$(ssh -o BatchMode=yes -o ConnectTimeout=15 e2e-ci "sha256sum /home/eta/services/eta-diarize/server.py /home/eta/eta-emotion/app.py 2>/dev/null" | awk '{print $1}' | tr '\n' ' ')
  [ -z "$C3SHA" ] && C3SHA="unfetched"
  export TONE_C3_SERVER_SHAS="$C3SHA"
  RUN_ID="hist-bulk-tone-c3-$(date +%Y%m%d)"
  TONE_DIARIZE_URL=http://127.0.0.1:18001/diarize \
  TONE_EMOTION_URL=http://127.0.0.1:18086/inference/wavlm \
  nice -n 10 $PY $D/tone_backfill.py --run-id $RUN_ID --shard 0/2 \
    > $HD/tone/c3-$(date +%Y%m%d)-s0.log 2>&1 &
  W1=$!
  TONE_DIARIZE_URL=http://127.0.0.1:18001/diarize \
  TONE_EMOTION_URL=http://127.0.0.1:18086/inference/wavlm \
  nice -n 10 $PY $D/tone_backfill.py --run-id $RUN_ID --shard 1/2 \
    > $HD/tone/c3-$(date +%Y%m%d)-s1.log 2>&1 &
  W2=$!
  log "launched 2 workers ($RUN_ID) pids $W1 $W2"
  # monitor loop: enforce the 07:55 hard stop and CI/LID priority DURING the cycle (r3 8093/8346 B2)
  while kill -0 $W1 2>/dev/null || kill -0 $W2 2>/dev/null; do
    stopped && { log "STOP seen: killing workers"; kill $W1 $W2 2>/dev/null; break; }
    if ! in_window; then log "07:55 hard stop reached: killing workers"; kill $W1 $W2 2>/dev/null; break; fi
    if ! curl -s -m 8 http://127.0.0.1:18001/health > /dev/null 2>&1; then
      log "tunnel DOWN: killing workers; relaunch after rebuild"
      kill $W1 $W2 2>/dev/null; TUN_DOWN=1; break
    fi
    if ssh -o BatchMode=yes -o ConnectTimeout=15 e2e-ci "flock -n /tmp/eta-ci-c3-ci.lock true" 2>/dev/null; then :; else
      log "c3 CI lock held (CI/LID working): killing workers until it frees"
      kill $W1 $W2 2>/dev/null; LOCK_WAIT=1; break
    fi
    sleep 60
  done
  wait $W1 2>/dev/null; R1=$?
  wait $W2 2>/dev/null; R2=$?
  log "worker cycle ended rc=$((R1 | R2))"
  if [ "${TUN_DOWN:-0}" = "1" ]; then TUN_DOWN=0
    ssh -f -N -L 18001:127.0.0.1:8001 -L 18086:127.0.0.1:8086 -o ExitOnForwardFailure=yes e2e-ci
    log "tunnel rebuilt"; sleep 30; continue
  fi
  [ "${LOCK_WAIT:-0}" = "1" ] && { LOCK_WAIT=0; sleep 60; continue; }
  sleep 30
done
log "END (window closed or STOP)"
