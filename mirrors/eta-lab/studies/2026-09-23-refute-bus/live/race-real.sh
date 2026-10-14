export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
L=/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/live
H() { herdr --session refute-test "$@"; }
for D in ${=1}; do
  echo "######## delay $D s"
  H agent wait rt-c --timeout 60000 >/dev/null 2>&1
  t0=$(python3 -c 'import time;print(time.time())')
  ( /bin/zsh $L/ctl.sh --session refute-test restart rt-c > $L/scratch/race-$D.out 2>&1; echo "restart rc=$?" >> $L/scratch/race-$D.out ) &
  sleep $D
  H agent prompt rt-c "RACE-$D: write a numbered list from 1 to 80, one short sentence each, no tools." | python3 -c 'import json,sys;d=json.load(sys.stdin);print("nudge ->",d.get("result",{}).get("type"),"state",d.get("result",{}).get("agent",{}).get("agent_status"))' 2>&1
  wait
  tail -3 $L/scratch/race-$D.out
  sid=$(H agent get rt-c | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["agent"]["agent_session"]["value"])')
  f=$(ls ~/.claude/projects/*/$sid.jsonl)
  python3 - "$f" "RACE-$D" <<'EOF'
import json,sys
lines=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
idx=[i for i,o in enumerate(lines) if o.get("type")=="user" and sys.argv[2] in json.dumps(o.get("message",{}))]
if not idx: print("race prompt NOT in transcript (landed after restart or lost)"); sys.exit()
after=lines[idx[-1]+1:]
txt=" ".join(c.get("text","") for o in after if o.get("type")=="assistant" for c in (o.get("message",{}).get("content") or []) if isinstance(c,dict))
ints=[o for o in after if "interrupt" in json.dumps(o).lower() or "/exit" in json.dumps(o)]
print("race prompt in transcript; assistant chars after it:",len(txt),"| reached '80.':", "80." in txt, "| exit/interrupt records after it:",len(ints))
EOF
done
H agent read rt-c --source recent-unwrapped --lines 30 | grep -n -E "RACE|/exit|See ya|Interrupted|^ *[0-9]+\.|resume" | tail -12
