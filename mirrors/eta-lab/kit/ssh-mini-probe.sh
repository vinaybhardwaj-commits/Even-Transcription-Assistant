#!/bin/bash
# ssh-mini-probe.sh: passive, low-rate log of whether the Mini's sshd accepts NEW connections (herdr-kit, 24 Sep,
# for the intermittent "kex_exchange_identification: Connection closed by remote host" on box -> Mini, bus #361/#394).
# Runs on the Mini. Every INTERVAL s it writes one CSV line to $LOG:
#   ts_ist, local (the LAB sshd, 127.0.0.1:2223, from the Mini), box (box "ssh mini", which is the lab path 2224 -> 2223 since ruling 129),
#   established :22, sshd-session count, sys_local (the SYSTEM sshd 127.0.0.1:22: capped at 42 launchd instances), box_legacy (box "ssh mini-legacy", 2222 -> system sshd)
# v1 (before ruling 129) had local = system sshd and box = 2222; its log is ssh-mini-probe-v1.log.
# A probe result is "up" if sshd got as far as the host-key/auth stage, "DOWN" if it closed before the banner.
# It opens no session and runs no remote command beyond "true". Stop: touch $STOP (or kill the pid).
# Usage: nohup setsid ./kit/ssh-mini-probe.sh >/dev/null 2>&1 &
INTERVAL="${PROBE_INTERVAL:-30}"
LOG="${PROBE_LOG:-$HOME/dev/eta-lab/bus/ssh-mini-probe.log}"
STOP="${PROBE_STOP:-$HOME/dev/eta-lab/bus/ssh-mini-probe.stop}"
END_EPOCH="${PROBE_END_EPOCH:-0}"   # 0 = run until STOP
classify() { case "$1" in *kex_exchange_identification*|*"Connection closed by"*|*"Connection reset"*|*"timed out"*|*"Operation timed out"*) echo DOWN;; *) echo up;; esac; }
rm -f "$STOP"
[ -s "$LOG" ] || echo "ts_ist,local,box,established22,sshd_sessions,sys_local,box_legacy" > "$LOG"
while [ ! -e "$STOP" ]; do
  [ "$END_EPOCH" -gt 0 ] && [ "$(date +%s)" -ge "$END_EPOCH" ] && break
  ts=$(TZ=Asia/Kolkata date "+%H:%M:%S")
  l=$(timeout 12 ssh -p 2223 -o BatchMode=yes -o ConnectTimeout=6 -o ControlPath=none -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null vinaybhardwaj@127.0.0.1 true 2>&1 | head -2 | tr '\n' ' ')
  b=$(timeout 25 ssh -o BatchMode=yes -o ConnectTimeout=8 e2e-lab-ts 'timeout 12 ssh -o BatchMode=yes -o ConnectTimeout=6 mini true 2>&1 | head -2 | tr "\n" " "' 2>&1)
  sl=$(timeout 12 ssh -o BatchMode=yes -o ConnectTimeout=6 -o ControlPath=none -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null vinaybhardwaj@127.0.0.1 true 2>&1 | head -2 | tr '\n' ' ')
  bl=$(timeout 25 ssh -o BatchMode=yes -o ConnectTimeout=8 e2e-lab-ts 'timeout 12 ssh -o BatchMode=yes -o ConnectTimeout=6 mini-legacy true 2>&1 | head -2 | tr "\n" " "' 2>&1)
  est=$(lsof -nP -iTCP:22 -sTCP:ESTABLISHED 2>/dev/null | grep -c ESTAB)
  ses=$(ps -axo command | grep -c '[s]shd-session: vinay')
  echo "$ts,$(classify "$l"),$(classify "$b"),$est,$ses,$(classify "$sl"),$(classify "$bl")" >> "$LOG"
  sleep "$INTERVAL"
done
