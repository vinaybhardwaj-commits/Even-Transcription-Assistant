#!/bin/bash
# (Re)create the herdr pane "fleet-watch · OpenCode · box" on THIS box and start the wrapper in it. Idempotent: does nothing if the pane already exists.
export PATH=$HOME/.local/bin:$PATH
TITLE="fleet-watch · OpenCode · box"
if herdr tab list 2>/dev/null | grep -q "fleet-watch"; then echo "fleet-watch pane already present"; exit 0; fi
OUT=$(herdr tab create --label "$TITLE" --cwd "$HOME/fleet-watch" 2>&1) || { echo "tab create failed"; exit 1; }
PANE=$(echo "$OUT" | python3 -c "import sys,json; j=json.load(sys.stdin); r=j['result']; print((r.get('root_pane') or r.get('pane') or {}).get('pane_id') or r['pane_id'])" 2>/dev/null)
[ -n "$PANE" ] || { echo "could not read the new pane id"; exit 1; }
herdr pane rename "$PANE" "$TITLE" >/dev/null 2>&1
sleep 1; herdr pane send-text "$PANE" "bash \$HOME/fleet-watch/fleet-watch.sh" >/dev/null && herdr pane send-keys "$PANE" Enter >/dev/null
echo "started in pane $PANE"
