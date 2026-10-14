#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
O=/Users/vinaybhardwaj/dev/_fable/scratch/spawn-kit.out
: > $O
R=$(herdr workspace create --label herdr-kit --cwd /Users/vinaybhardwaj/dev/_fable --no-focus 2>&1)
P=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['root_pane']['pane_id'])" 2>>$O)
echo "pane=$P" >> $O
sleep 2
herdr agent start herdr-kit --kind claude --pane "$P" --timeout 120000 -- --model sonnet --dangerously-skip-permissions -n herdr-kit >> $O 2>&1
echo "start rc=$?" >> $O
herdr agent get herdr-kit >> $O 2>&1
