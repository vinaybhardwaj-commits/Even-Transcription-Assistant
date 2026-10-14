#!/bin/zsh
# J-E winner: primary gemini-2.5-flash, fallback llama-4-scout (different vendor). Applied between windows.
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
U=$(id -u); LOG=~/dev/_fable/scratch/cutover-0922.log
P=$(ls ~/Library/LaunchAgents/*eta-router*.plist | head -1)
cp $P ~/dev/_fable/scratch/eta-router.plist.bak-0922-flash
plutil -replace EnvironmentVariables.ETA_TRANSLATE_ENGINE -string "openrouter:google/gemini-2.5-flash" $P
plutil -replace EnvironmentVariables.ETA_TRANSLATE_FALLBACK -string "openrouter:meta-llama/llama-4-scout" $P
for i in {1..3600}; do
  LAST=$(tail -1 ~/overnight-translate/overnight-translate.log | grep -o '"event":"[a-z_]*"')
  case "$LAST" in *window_done*|*gate_hold*|*window_failed*) ;; *) sleep 1; continue;; esac
  launchctl bootout gui/$U $P 2>/dev/null; sleep 1; launchctl bootstrap gui/$U $P; sleep 6
  H=$(curl -s -m 5 -o /dev/null -w "%{http_code}" localhost:8083/healthz)
  echo "$(date -u +%FT%TZ) router engine -> gemini-2.5-flash, fallback llama-4-scout (J-E winner), healthz $H" >> $LOG
  exit 0
done
