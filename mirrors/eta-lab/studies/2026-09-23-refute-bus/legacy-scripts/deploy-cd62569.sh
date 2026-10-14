#!/bin/zsh
# ff ~/eta-router main to vinay/translate-hardening (cd62569, ETA-Refuter PASS-WITH-FIXES) between windows.
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
U=$(id -u); LOG=~/dev/_fable/scratch/cutover-0922.log
cd ~/eta-router-translate-hardening && ~/eta-router/.venv/bin/python -m unittest test_translate >/tmp/cd62569-tests.txt 2>&1 || { echo "$(date -u +%FT%TZ) cd62569 tests FAILED, not deployed" >> $LOG; exit 1; }
for i in {1..3600}; do
  LAST=$(tail -1 ~/overnight-translate/overnight-translate.log | grep -o '"event":"[a-z_]*"')
  case "$LAST" in *window_done*|*gate_hold*|*window_failed*) ;; *) sleep 1; continue;; esac
  cd ~/eta-router && git merge --ff-only vinay/translate-hardening >/dev/null 2>&1 || { echo "$(date -u +%FT%TZ) cd62569 ff failed" >> $LOG; exit 1; }
  P=$(ls ~/Library/LaunchAgents/*eta-router*.plist | head -1)
  launchctl bootout gui/$U $P 2>/dev/null; sleep 1; launchctl bootstrap gui/$U $P; sleep 6
  H=$(curl -s -m 5 -o /dev/null -w "%{http_code}" localhost:8083/healthz)
  echo "$(date -u +%FT%TZ) router -> $(git log --oneline -1 | cut -c1-7) (D1/D2/D4 + allow-list), healthz $H" >> $LOG
  exit 0
done
