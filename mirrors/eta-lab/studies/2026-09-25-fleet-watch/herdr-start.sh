#!/bin/bash
# (Re)create the herdr WORKSPACE "fleet-watch" on THIS box, with its own pane running pane-run.sh (tails the logs if the loop already runs, otherwise starts it). Idempotent.
# It always creates its OWN workspace: never a tab in whichever workspace happens to be focused (that hid the first version inside another pane's workspace).
export PATH=$HOME/.local/bin:$PATH
LABEL="${FLEET_WATCH_WORKSPACE:-fleet-watch}"
WS=$(herdr workspace list 2>/dev/null | python3 -c "
import sys, json
for w in json.load(sys.stdin)['result'].get('workspaces', []):
    if w.get('label') == '$LABEL': print(w['workspace_id']); break")
if [ -n "$WS" ]; then echo "workspace '$LABEL' already exists ($WS): nothing to do"; exit 0; fi
OUT=$(herdr workspace create --label "$LABEL" --cwd "$HOME/fleet-watch" 2>&1) || { echo "workspace create failed: $OUT" | cut -c1-200; exit 1; }
PANE=$(echo "$OUT" | python3 -c "
import sys, json
def find(o):
    if isinstance(o, dict):
        if isinstance(o.get('pane_id'), str): return o['pane_id']
        for v in o.values():
            r = find(v)
            if r: return r
    if isinstance(o, list):
        for v in o:
            r = find(v)
            if r: return r
print(find(json.load(sys.stdin)) or '')")
[ -n "$PANE" ] || { echo "could not read the new pane id"; exit 1; }
sleep 1; herdr pane send-text "$PANE" "bash \$HOME/fleet-watch/pane-run.sh" >/dev/null && herdr pane send-keys "$PANE" Enter >/dev/null
echo "workspace '$LABEL' created, pane $PANE started"
