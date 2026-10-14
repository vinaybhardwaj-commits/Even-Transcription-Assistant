#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
U=$(id -u); LOG=~/dev/_fable/scratch/cutover-0922.log
for i in {1..3600}; do
  LAST=$(tail -1 ~/overnight-translate/overnight-translate.log | grep -o '"event":"[a-z_]*"')
  case "$LAST" in *window_done*|*gate_hold*|*window_failed*) ;; *) sleep 1; continue;; esac
  cd ~/eta-router && git merge --ff-only vinay/translate-pools >/dev/null 2>&1 || { echo "$(date -u +%FT%TZ) pools ff failed" >> $LOG; exit 1; }
  P=$(ls ~/Library/LaunchAgents/*eta-router*.plist | head -1)
  launchctl bootout gui/$U $P 2>/dev/null; sleep 1; launchctl bootstrap gui/$U $P; sleep 6
  H=$(curl -s -m 5 -o /dev/null -w "%{http_code}" localhost:8083/healthz)
  echo "$(date -u +%FT%TZ) router -> $(git log --oneline -1 | cut -c1-7) (per-engine pools), healthz $H" >> $LOG
  exit 0
done
