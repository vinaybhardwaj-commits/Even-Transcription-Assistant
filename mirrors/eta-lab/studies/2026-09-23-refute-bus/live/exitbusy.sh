export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
L=/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/live
H() { herdr --session refute-test "$@"; }
C() { /bin/zsh $L/ctl.sh --session refute-test "$@"; }
echo "== gate on rt-a (expect BUSY refusal)"; C restart rt-a; echo "rc=$?"
echo "== what restart would do if BUSY were missed: /exit with 1 shell + 1 monitor running"
pgrep -fl "sleep 400" | head
H agent prompt rt-a "/exit" 2>&1 | head -c 200; echo
sleep 3
H agent read rt-a --source visible --lines 14 | tail -14
H agent list | python3 -c 'import json,sys;[print(a["name"],a["agent_status"]) for a in json.load(sys.stdin)["result"]["agents"]]'
H pane process-info --pane w2:p1 | python3 -c 'import json,sys;d=json.load(sys.stdin)["result"]["process_info"];print([p.get("cmdline") for p in d["foreground_processes"]])'
echo "sleep 400 still alive?"; pgrep -fl "sleep 400" | head
