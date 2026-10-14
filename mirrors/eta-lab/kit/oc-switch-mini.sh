#!/bin/zsh
# Fable r432: Mini variant of the box's oc-switch.sh. Switch one Mini Claude Code pane to OpenCode.
# usage: oc-switch-mini.sh <name> <model>
set -u
export PATH=$HOME/.opencode/bin:/opt/homebrew/bin:$PATH
NAME=$1; MODEL=$2; H=$HOME
mkdir -p $H/oc/$NAME
git -C $H/dev/eta-lab fetch -q origin
if git -C $H/dev/eta-lab show origin/main:handover/HANDOVER-$NAME.md > $H/oc/$NAME/HANDOVER.md 2>/dev/null; then HO=ok; else HO=none; printf '# No handover was committed by %s before the switch (Fable r432).\nRead your recent bus history (bus_thread / bus_inbox) and the board (board/BOARD.md) to recover your open items. Ask Fable if unsure.\n' $NAME > $H/oc/$NAME/HANDOVER.md; fi
git -C $H/dev/eta-lab show origin/main:kit/PANE-RULES.md > $H/oc/PANE-RULES.md 2>/dev/null || true
OLD=$(herdr agent list | python3 -c '
import sys,json
n=sys.argv[1]
for a in json.load(sys.stdin)["result"]["agents"]:
    if a.get("name")==n and a.get("agent")=="claude": print(a["pane_id"], a.get("cwd") or "")
' "$NAME")
[ -n "$OLD" ] || { echo "no claude pane named $NAME"; exit 1; }
OLDP=${OLD%% *}; CWD=${OLD#* }; WS=${OLDP%%:*}
python3 - "$NAME" "$MODEL" <<'PY'
import json,sys,os
n,m=sys.argv[1:3]
h=os.path.expanduser("~")
ins=[f"{h}/oc/{n}/HANDOVER.md", f"{h}/oc/OC-PANE-BRIEF.md", f"{h}/oc/PANE-RULES.md", f"{h}/oc/SECURITY-RULES.md"]
ins=[i for i in ins if os.path.exists(i)]
c={"$schema":"https://opencode.ai/config.json","model":m,
 "provider":{"opencode":{"options":{"apiKey":"{file:%s/.claude/secrets/opencode_zen_key}"%h}}},
 "instructions":ins,
 "mcp":{"eta-bus":{"type":"local","command":["/bin/sh",f"{h}/dev/eta-bus-mcp/run.sh"],"enabled":True},
        "even-jev":{"type":"local","command":[f"{h}/dev/even-jev-mcp/run.sh"],"enabled":True}},
 "permission":{"edit":"allow","webfetch":"allow",
   "external_directory":{"*":"allow",f"{h}/.claude/*":"deny",f"{h}/.ssh/*":"deny"},
   "read":{"*":"allow",f"{h}/.claude/*":"deny",f"{h}/.ssh/*":"deny","*.env":"deny","*secrets*":"deny"},
   "bash":{"*":"allow","*secrets*":"deny","*.ssh/*":"deny","*.env*":"deny","rm *":"deny","*rm -rf*":"deny","git push --force*":"deny","git push -f*":"deny","git reset --hard*":"deny","find * -delete*":"deny",
   "*.claude*":"deny","*/.ssh*":"deny","*authorized_keys*":"deny","*crontab*":"deny","*launchctl*":"deny","opencode debug*":"deny","env":"deny","env *":"deny","printenv*":"deny"}}}
json.dump(c,open(f"{h}/oc/{n}/opencode.jsonc","w"),indent=1)
PY
herdr agent rename $OLDP $NAME-cc >/dev/null || { echo "rename old failed"; exit 1; }
OUT=$(herdr tab create --workspace $WS --cwd "${CWD:-$H/dev/eta-lab}" --label "$NAME · OpenCode ${MODEL#opencode/}")
NEWP=$(echo "$OUT" | python3 -c '
import sys,json
r=json.load(sys.stdin)["result"]
print((r.get("root_pane") or r.get("pane") or {}).get("pane_id") or r.get("pane_id"))')
if [ -z "$NEWP" ] || [ "$NEWP" = "None" ]; then echo "tab create failed: $OUT"; herdr agent rename $OLDP $NAME; exit 1; fi
sleep 1
herdr pane send-text $NEWP "OPENCODE_CONFIG=$H/oc/$NAME/opencode.jsonc opencode -m $MODEL" >/dev/null
herdr pane send-keys $NEWP Enter >/dev/null
for i in $(seq 1 20); do
  sleep 2
  A=$(herdr agent get $NEWP 2>/dev/null | python3 -c '
import sys,json
r=json.load(sys.stdin)["result"]; a=r.get("agent",r)
print(a.get("agent") or "")' 2>/dev/null)
  [ "$A" = "opencode" ] && break
done
herdr agent rename $NEWP $NAME >/dev/null || echo "WARN rename new failed"
sleep 8
herdr pane send-text $NEWP "You are $NAME, now running on OpenCode ($MODEL) in place of the Claude Code pane $NAME-cc (kept as rollback). Your HANDOVER, the OC pane brief and SECURITY-RULES are loaded as instructions. Check your model line shows $MODEL (paid Zen); if not, stop. Now: (1) bus_inbox; (2) bus_post to Fable and conductor: '$NAME ONLINE on OpenCode ($MODEL), handover=$HO, N unread, next: <first item>'; (3) then do only what your handover says is next or what Fable orders." >/dev/null
sleep 1
herdr pane send-keys $NEWP Enter >/dev/null
echo "OK $NAME old=$OLDP(renamed $NAME-cc) new=$NEWP ws=$WS model=$MODEL handover=$HO"
