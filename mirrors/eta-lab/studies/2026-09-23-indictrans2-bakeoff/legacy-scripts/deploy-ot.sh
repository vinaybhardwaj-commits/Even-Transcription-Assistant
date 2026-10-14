#!/bin/zsh
# Swap the overnight driver bundle to a3f25ec (join deferral + gate re-check + j0-abstain english.ts) between windows.
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
U=$(id -u); LOG=~/dev/_fable/scratch/cutover-0922.log; OT=~/overnight-translate
cp $OT/overnight-translate.mjs ~/dev/_fable/scratch/overnight-translate.live-bak-0922.mjs
for i in {1..3600}; do
  LAST=$(tail -1 $OT/overnight-translate.log | grep -o '"event":"[a-z_]*"')
  case "$LAST" in *window_done*|*gate_hold*|*window_failed*|*window_deferred*) ;; *) sleep 1; continue;; esac
  cp ~/dev/_fable/scratch/overnight-translate.staged.mjs $OT/overnight-translate.mjs
  launchctl kickstart -k gui/$U/com.vinaybhardwaj.eta-overnight-translate 2>>$LOG
  sleep 20
  PID=$(launchctl list | awk '/eta-overnight-translate/{print $1}')
  echo "$(date -u +%FT%TZ) overnight driver -> a3f25ec bundle (after $LAST), pid $PID, last: $(tail -1 $OT/overnight-translate.log | cut -c1-120)" >> $LOG
  exit 0
done
