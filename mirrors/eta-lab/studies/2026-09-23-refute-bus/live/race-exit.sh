export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
H() { herdr --session refute-test "$@"; }
st() { H agent list | python3 -c 'import json,sys;print(" ".join(a["name"]+"="+a["agent_status"] for a in json.load(sys.stdin)["result"]["agents"]))'; }
fg() { H pane process-info --pane w3:p1 | python3 -c 'import json,sys;d=json.load(sys.stdin)["result"]["process_info"];print("fg:",[p.get("cmdline") or p.get("argv0") for p in d["foreground_processes"]][-1:])'; }
H agent send-keys rt-a esc >/dev/null   # cancel the exit dialog left by the previous test
echo "== rt-b becomes working (simulates a bus nudge landing just after the idle check)"
H agent prompt rt-b "Write a numbered list from 1 to 120, one short sentence per number, no tools." | head -c 120; echo
sleep 2; st
echo "== restart's post-gate step: agent prompt /exit to a WORKING agent"
H agent prompt rt-b "/exit" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("prompt ->",d.get("result",{}).get("type"), d.get("error"))' 2>&1
for t in 2 4 6 8 10 12 14 16 18 20; do sleep 2; printf "t=%ss " $t; st; done
fg
H pane read w3:p1 --source visible --lines 8 | tail -8
echo "== restart fallback: ctrl+c, 1s, ctrl+c"
H pane send-keys w3:p1 ctrl+c >/dev/null; sleep 1; H pane send-keys w3:p1 ctrl+c >/dev/null
sleep 5; st; fg
H pane read w3:p1 --source recent-unwrapped --lines 20 | tail -20
