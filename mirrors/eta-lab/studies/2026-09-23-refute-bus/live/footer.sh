export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
L=/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/live
H() { herdr --session refute-test "$@"; }
C() { /bin/zsh $L/ctl.sh --session refute-test "$@"; }
step() {
  echo "######## $1"
  H agent prompt rt-a "$2" --wait --timeout 150000 | python3 -c 'import json,sys;d=json.load(sys.stdin);print("prompt->",d.get("result",{}).get("type"),d.get("result",{}).get("agent",{}).get("agent_status"))' 2>&1
  sleep 3
  H agent read rt-a --source visible --lines 6 | tail -4
  C status | grep rt-a
}
step "monitor only" "Use the Monitor tool to watch the output of the command: while true; do date; sleep 30; done. Start it and then end your turn immediately. Do not use Bash."
step "bg subagent only" "Launch ONE background subagent (Agent/Task tool with run_in_background true) whose task is: run 'sleep 400' in Bash then report done. Then end your turn immediately without waiting."
