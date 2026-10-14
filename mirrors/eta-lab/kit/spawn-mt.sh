#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
O=/Users/vinaybhardwaj/dev/_fable/scratch/spawn-mt.out
: > $O
R=$(herdr workspace create --label indic-mt --cwd /Users/vinaybhardwaj/dev/_fable --no-focus 2>&1)
P=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['root_pane']['pane_id'])" 2>>$O)
echo "pane=$P" >> $O
sleep 2
herdr agent start indic-mt --kind claude --pane "$P" --timeout 120000 -- --model sonnet --dangerously-skip-permissions -n indic-mt >> $O 2>&1
echo "start rc=$?" >> $O
sleep 2
herdr agent get indic-mt | grep -o '"agent_status":"[a-z]*"' >> $O
