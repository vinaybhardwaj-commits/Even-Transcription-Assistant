export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
echo "== herdr version"; herdr --version 2>&1 | head -2
echo "== sessions"; herdr session list --json 2>&1 | head -40
echo "== registry"; cat /Users/vinaybhardwaj/dev/_fable/herdr-registry.json
echo "== settings model"; python3 -c 'import json;d=json.load(open("/Users/vinaybhardwaj/.claude/settings.json"));print({k:d.get(k) for k in ("model","permissions","env")})' 2>&1
echo "== claude.json eta-bus"; python3 -c '
import json;d=json.load(open("/Users/vinaybhardwaj/.claude.json"))
print(json.dumps(d.get("mcpServers",{}).get("eta-bus"),indent=1))' 2>&1
echo "== env ETA_BUS_AS in shell rc"; grep -n "ETA_BUS_AS" ~/.zshrc ~/.zprofile ~/.zshenv ~/.profile 2>/dev/null; echo "(done)"
echo "== launchctl env"; launchctl getenv ETA_BUS_AS; echo "(done)"
echo "== agent list"; herdr agent list 2>&1 | python3 -c '
import json,sys
d=json.load(sys.stdin)
for a in d["result"]["agents"]:
    print(a.get("name"), a.get("pane_id"), a.get("agent_status"), a.get("kind"), (a.get("agent_session") or {}).get("value"), a.get("cwd"))
print("KEYS", sorted(d["result"]["agents"][0].keys()))
'
