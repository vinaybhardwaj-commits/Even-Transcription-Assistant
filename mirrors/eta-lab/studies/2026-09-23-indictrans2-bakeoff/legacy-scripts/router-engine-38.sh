#!/bin/zsh
# V 22 Sep: router primary = google/gemini-3.8-flash; fallback llama-4-scout (non-Google). Applied between windows.
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
U=$(id -u); LOG=~/dev/_fable/scratch/cutover-0922.log
P=$(ls ~/Library/LaunchAgents/*eta-router*.plist | head -1)
cp $P ~/dev/_fable/scratch/eta-router.plist.bak-0922-38
plutil -replace EnvironmentVariables.ETA_TRANSLATE_ENGINE -string "openrouter:google/gemini-3.8-flash" $P
plutil -replace EnvironmentVariables.ETA_TRANSLATE_FALLBACK -string "openrouter:meta-llama/llama-4-scout" $P
for i in {1..3600}; do
  LAST=$(tail -1 ~/overnight-translate/overnight-translate.log | grep -o '"event":"[a-z_]*"')
  case "$LAST" in *window_done*|*gate_hold*|*window_failed*) ;; *) sleep 1; continue;; esac
  launchctl bootout gui/$U $P 2>/dev/null; sleep 1; launchctl bootstrap gui/$U $P; sleep 6
  H=$(curl -s -m 5 -o /dev/null -w "%{http_code}" localhost:8083/healthz)
  cd ~/eta-router
  CHK=$(ETA_TRANSLATE_ENGINE="openrouter:google/gemini-3.8-flash" ETA_TRANSLATE_FALLBACK="openrouter:meta-llama/llama-4-scout" ETA_OPENROUTER_KEY_FILE=$HOME/.claude/secrets/openrouter_api_key PYTHONPATH=. .venv/bin/python -c '
import router_server as rs, time
t=time.time(); r=rs.translate("आपको कितने दिन से बुखार है? दो दिन से।", "hi")
print(r.get("translate_engine"), r.get("translate_model"), "ms=%d" % ((time.time()-t)*1000), "ok" if r.get("english") else "err=%s" % r.get("translate_error"))' 2>&1 | tail -1)
  echo "$(date -u +%FT%TZ) router engine -> gemini-3.8-flash (V), fallback llama-4-scout, healthz $H, check: $CHK" >> $LOG
  exit 0
done
