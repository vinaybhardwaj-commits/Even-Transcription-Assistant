export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
timeout 10 herdr --session rb-probe-nx agent list 2>&1 | head -c 300; echo " rc=$?"
timeout 10 herdr --session '../../rb-trav' agent list 2>&1 | head -c 300; echo " rc=$?"
herdr session list --json | python3 -c 'import json,sys;print([ (s["name"],s["running"]) for s in json.load(sys.stdin)["sessions"]])'
ls -d ~/.config/herdr/sessions/* ~/.config/rb-trav ~/rb-trav 2>&1 | head
