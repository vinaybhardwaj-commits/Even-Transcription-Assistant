#!/bin/zsh
echo "=== any drain process running? ==="
ps -axo pid,etime,command | grep -i -E 'drain|diariz' | grep -v grep | head -10
echo "(empty above = NOTHING RUNNING)"
echo
echo "=== watchdog last line ==="
tail -1 /Users/vinaybhardwaj/dev/mini-pressure.jsonl 2>/dev/null | head -c 400
echo
echo
echo "=== diarized window count, right now, vs earlier 148 ==="
curl -s -m 20 "https://www.evenscribe.app/api/run-migrations" >/dev/null 2>&1 && echo "prod reachable"
echo
echo "=== router ==="
curl -s -m 5 http://127.0.0.1:8083/healthz | head -c 200
echo
echo
echo "=== live recording rooms (engines busy?) ==="
ps -axo pid,pcpu,command | grep -i -E 'whisper|indic|sravaani|router_server' | grep -v grep | awk '{print $1, $2, $3}' | head -8
