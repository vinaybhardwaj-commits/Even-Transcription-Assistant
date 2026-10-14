#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
O=/Users/vinaybhardwaj/dev/_fable/scratch/spawn-diar.out
: > $O
R=$(herdr workspace create --label diar-lab --cwd /Users/vinaybhardwaj/dev/_fable --no-focus 2>&1)
P=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['root_pane']['pane_id'])" 2>>$O)
echo "pane=$P" >> $O
sleep 2
herdr agent start diar-lab --kind claude --pane "$P" --timeout 120000 -- --model sonnet --dangerously-skip-permissions -n diar-lab >> $O 2>&1
echo "start rc=$?" >> $O
sleep 4
herdr agent read diar-lab --lines 15 2>/dev/null | grep -i -E 'trust|folder|yes, i trust' | head -2 >> $O
herdr agent get diar-lab | grep -o '"agent_status":"[a-z]*"' >> $O
