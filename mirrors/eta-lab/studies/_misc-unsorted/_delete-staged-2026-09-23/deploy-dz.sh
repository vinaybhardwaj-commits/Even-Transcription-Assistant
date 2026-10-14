#!/bin/zsh
# Deploy diarize MPS-leak fix (batch padding + ECAPA on CPU) between windows; guard threshold -> 10 GB.
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
U=$(id -u); LOG=~/dev/_fable/scratch/cutover-0922.log; DZ=~/eta-diarize
cp $DZ/server.py $DZ/server.py.bak-20260922-leakfix
~/eta-diarize/.venv/bin/python -m py_compile ~/dev/_fable/scratch/dz/server_fixed.py || { echo "$(date -u +%FT%TZ) dz fix compile FAILED" >> $LOG; exit 1; }
G=~/Library/LaunchAgents/com.vinaybhardwaj.eta-diarize-guard.plist
plutil -replace ProgramArguments.2 -string 10 $G
launchctl bootout gui/$U $G 2>/dev/null; sleep 1; launchctl bootstrap gui/$U $G
for i in {1..3600}; do
  LAST=$(tail -1 ~/overnight-translate/overnight-translate.log | grep -o '"event":"[a-z_]*"')
  case "$LAST" in *window_done*|*gate_hold*|*window_failed*|*window_deferred*) ;; *) sleep 1; continue;; esac
  cp ~/dev/_fable/scratch/dz/server_fixed.py $DZ/server.py
  launchctl kickstart -k gui/$U/uk.llmvinayminihome.eta-diarize
  for j in {1..30}; do sleep 3; H=$(curl -s -m 3 -o /dev/null -w "%{http_code}" localhost:8001/health); [ "$H" = 200 ] && break; done
  if [ "$H" != 200 ]; then
    cp $DZ/server.py.bak-20260922-leakfix $DZ/server.py; launchctl kickstart -k gui/$U/uk.llmvinayminihome.eta-diarize
    echo "$(date -u +%FT%TZ) dz fix: health $H after 90s -> ROLLED BACK" >> $LOG; exit 1
  fi
  echo "$(date -u +%FT%TZ) diarize -> leak fix (pad batches, ECAPA cpu), health 200, guard 10GB, after $LAST" >> $LOG
  exit 0
done
