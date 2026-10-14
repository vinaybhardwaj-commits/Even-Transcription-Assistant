export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
L=/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/live
H() { herdr --session refute-test "$@"; }
C() { /bin/zsh $L/ctl.sh --session refute-test "$@"; }
H agent prompt rt-c "Reply with just: hi" --wait --timeout 90000 >/dev/null
for i in 1 2 3 4 5; do
  f=$(H agent read rt-c --source visible --lines 2 | tail -1)
  echo "footer: $f"
  case "$f" in *"auto mode on"*) break;; esac
  H agent send-keys rt-c shift+tab >/dev/null; sleep 1
done
echo "== before restart:"; H agent read rt-c --source visible --lines 2 | tail -1
sid=$(H agent get rt-c | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["agent"]["agent_session"]["value"])')
f=$(ls ~/.claude/projects/*/$sid.jsonl); python3 -c 'import json,sys
ms=[json.loads(l).get("message",{}).get("model") for l in open(sys.argv[1]) if "\"assistant\"" in l]; print("model before:",[m for m in ms if m][-1:])' $f
C restart rt-c 2>&1 | tail -2
echo "== after restart:"; H agent read rt-c --source visible --lines 2 | tail -1
H pane process-info --pane w1:p1 | python3 -c 'import json,sys;d=json.load(sys.stdin)["result"]["process_info"];print("cmdline:",[p.get("cmdline") for p in d["foreground_processes"]][-1:])'
H agent prompt rt-c "Reply with just: hi again" --wait --timeout 90000 >/dev/null
sid2=$(H agent get rt-c | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["agent"]["agent_session"]["value"])')
echo "session same: $([ "$sid" = "$sid2" ] && echo yes || echo NO $sid $sid2)"
f=$(ls ~/.claude/projects/*/$sid2.jsonl); python3 -c 'import json,sys
ms=[json.loads(l).get("message",{}).get("model") for l in open(sys.argv[1]) if "\"assistant\"" in l]; print("model after:",[m for m in ms if m][-1:])' $f
