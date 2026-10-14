export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
L=/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/live
H() { herdr --session refute-test "$@"; }
C() { /bin/zsh $L/ctl.sh --session refute-test "$@"; }
H agent prompt rt-b "Call the Agent tool exactly once with subagent_type 'general-purpose', run_in_background set to true, and prompt: 'Count slowly from 1 to 200, writing one short sentence about each number. Do not use any tools.' Do NOT use the Bash tool yourself. After launching it, end your turn immediately." --wait --timeout 150000 | python3 -c 'import json,sys;d=json.load(sys.stdin);print("prompt->",d.get("result",{}).get("type"),d.get("result",{}).get("agent",{}).get("agent_status"))'
sleep 4
H agent read rt-b --source recent-unwrapped --lines 25
C status | grep rt-b
