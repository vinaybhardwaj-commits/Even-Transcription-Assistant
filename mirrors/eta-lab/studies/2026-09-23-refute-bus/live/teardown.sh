export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
herdr --session refute-test agent list | python3 -c 'import json,sys;print([(a["name"],a["pane_id"]) for a in json.load(sys.stdin)["result"]["agents"]])'
herdr session stop refute-test --json; sleep 2
herdr session delete refute-test --json
herdr session list --json
sleep 1
echo "leftover test procs:"; pgrep -fl "sleep 400|rt-a|rt-b|rt-c|refute-test" | grep -v pgrep; echo "(end)"
rm -f /tmp/rb-inj1.txt /tmp/rb-sess-inject
ls -la@ ~/.claude/settings.json | head -1
echo "default session agents (read-only):"
herdr agent list | python3 -c 'import json,sys;print(" ".join(f"{a.get(\"name\")}={a[\"agent_status\"]}" for a in json.load(sys.stdin)["result"]["agents"]))'
tail -3 /Users/vinaybhardwaj/dev/_fable/scratch/eta-bus.log
tail -2 /Users/vinaybhardwaj/dev/_fable/scratch/herdr-ctl.log
