export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
H() { herdr --session refute-test "$@"; }
# replicate herdr-ctl restart's fallback exactly: ctrl+c, sleep 1, ctrl+c, then poll
H pane send-keys w2:p1 ctrl+c >/dev/null 2>&1; sleep 1; H pane send-keys w2:p1 ctrl+c >/dev/null 2>&1
sleep 4
H pane read w2:p1 --source visible --lines 12 | tail -12
H pane process-info --pane w2:p1 | python3 -c 'import json,sys;d=json.load(sys.stdin)["result"]["process_info"];print("fg:",[p.get("cmdline") for p in d["foreground_processes"]][-1:])'
echo "sleep 400 alive?"; pgrep -fl "sleep 400" | head -2; echo "(end)"
H agent list | python3 -c 'import json,sys;[print(a["name"],a["agent_status"]) for a in json.load(sys.stdin)["result"]["agents"]]'
