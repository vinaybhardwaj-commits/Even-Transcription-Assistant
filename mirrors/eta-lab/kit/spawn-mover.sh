#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
O=/Users/vinaybhardwaj/dev/_fable/scratch/spawn-mover.out
: > $O
R=$(herdr workspace create --label lab-mover --cwd /Users/vinaybhardwaj/dev --no-focus 2>&1)
P=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['root_pane']['pane_id'])" 2>>$O)
echo "pane=$P" >> $O
sleep 2
herdr agent start lab-mover --kind claude --pane "$P" --timeout 120000 -- --model sonnet --dangerously-skip-permissions -n lab-mover >> $O 2>&1
echo "start rc=$?" >> $O
sleep 5
herdr agent get lab-mover | grep -o -E '"(agent_status|value)":"[a-z0-9-]*"' >> $O
