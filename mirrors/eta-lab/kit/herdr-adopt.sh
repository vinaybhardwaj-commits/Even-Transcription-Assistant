#!/bin/zsh
# usage: herdr-adopt.sh <name> <cwd> <session-id> [pid-to-stop-first ...]
export PATH=/opt/homebrew/bin:$PATH
N=$1; C=$2; S=$3; shift 3
O=/Users/vinaybhardwaj/dev/_fable/scratch/adopt-$N.out
: > $O
for p in "$@"; do kill -TERM $p 2>/dev/null && echo "stopped $p" >> $O; done
[ $# -gt 0 ] && sleep 4
R=$(herdr workspace create --label "$N" --cwd "$C" --no-focus 2>&1)
P=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['root_pane']['pane_id'])" 2>>$O)
echo "workspace pane=$P" >> $O
[ -z "$P" ] && { echo "$R" >> $O; exit 1; }
sleep 2
herdr agent start "$N" --kind claude --pane "$P" --timeout 120000 -- --resume "$S" -n "$N" >> $O 2>&1
echo "start rc=$?" >> $O
