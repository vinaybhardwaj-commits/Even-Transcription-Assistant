export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
L=/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/live
CP=/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/copy
H() { herdr --session refute-test "$@"; }
rm -f /tmp/rb-sess-inject
show() { H agent list | python3 -c 'import json,sys;[print("  ",a["name"],a["agent_status"],(a.get("agent_session") or {}).get("value"),(a.get("agent_session") or {}).get("source")) for a in json.load(sys.stdin)["result"]["agents"]]'; }
echo "== before"; show
echo "== any pane can re-report another pane's agent session id / state"
H pane report-agent-session w3:p1 --source refute --agent claude --agent-session-id 'x; touch /tmp/rb-sess-inject; echo ' 2>&1 | head -c 300; echo
show
H pane report-agent w3:p1 --source herdr:claude --agent claude --state idle --agent-session-id 'y; touch /tmp/rb-sess-inject; echo ' 2>&1 | head -c 300; echo
show
echo "== herdr-ctl transcript rt-b"
/bin/zsh $L/ctl.sh --session refute-test transcript rt-b 2>&1 | head -5
ls -la /tmp/rb-sess-inject 2>&1
echo "== spoof state: make rt-b working, then report idle from a foreign source"
H agent prompt rt-b "Write a numbered list 1..60, one sentence each, no tools." >/dev/null
sleep 2; show
H pane report-agent w3:p1 --source herdr:claude --agent claude --state idle 2>&1 | head -c 200; echo
show
H agent wait rt-b --timeout 90000 >/dev/null
echo "== identity: pane renamed to fable"
H agent rename rt-a fable | head -c 150; echo
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"herdr_tag","arguments":{"name":"rt-b","task":"tagged-by-renamed-worker"}}}' | \
  env -u ETA_BUS_AS HERDR_PANE_ID=w2:p1 HERDR_SESSION=refute-test /opt/homebrew/bin/node $CP/server.mjs | cut -c1-250
H agent rename fable rt-a | head -c 100; echo
