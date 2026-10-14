export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
H() { herdr --session refute-test "$@"; }
sid() { H agent get rt-b | python3 -c 'import json,sys;a=json.load(sys.stdin)["result"]["agent"];print(a["agent_status"],a["agent_session"]["value"])'; }
H agent wait rt-b --timeout 90000 >/dev/null
echo "before: $(sid)"
H agent prompt rt-b "Write a numbered list from 1 to 100, one short sentence each, no tools." >/dev/null
sleep 3; echo "working: $(sid)"
H agent prompt rt-b "/clear" | python3 -c 'import json,sys;print("prompt /clear ->",json.load(sys.stdin).get("result",{}).get("type"))'
sleep 4; echo "after /clear: $(sid)"
H agent read rt-b --source recent-unwrapped --lines 40 | grep -v "^\s*$" | grep -E "^ *[0-9]+\.|/clear|nterrupt" | tail -4
