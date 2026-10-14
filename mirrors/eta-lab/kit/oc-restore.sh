#!/bin/bash
# oc-restore.sh (herdr-kit, W25 / Fable r409, rename-order fix per r412.4): put OpenCode panes back into herdr from
# ~/oc/REGISTRY.tsv after a herdr server restart or a box reboot. Safe to run any time: a pane whose name is already
# a LIVE opencode agent is SKIPPED, never restarted.
#
# usage: oc-restore.sh [--dry-run] [name ...]     (no names = every row in the registry)
# For each row: (1) new TAB in the pane's old workspace (or a new workspace if it is gone), cwd from the registry;
# (2) `herdr agent start <name> --kind opencode --pane <pane> -- -s <session id> -m <model>` with OPENCODE_CONFIG set
# in that tab's environment first (herdr agent start has no --env flag, so the config path is exported into the shell
# with `export` + Enter, THEN agent start execs opencode there). agent start NAMES the pane ATOMICALLY at spawn time
# (the result comes back already carrying `name`), which is the actual fix for the rename-order bug (r412.4):
# renaming AFTER opencode has already started does NOT give it a bus identity retroactively (proven live, 25 Sep,
# on hist-miner: Fable's manual relaunch left it running and unnamed; exiting and relaunching it through `agent start`
# fixed it). The old create-tab -> send-text -> wait -> rename sequence had exactly that gap and is dropped.
# NOT `opencode -c`: -c resumes the last session of the PROJECT DIRECTORY and ~10 panes share /home/eta/dev/eta-lab, so it would
# resume ANOTHER pane's session. The sid column (written by oc-registry-snapshot.sh from herdr's agent_session) is used; a row with
# no sid starts a FRESH session, which still loads its HANDOVER.md + OC-PANE-BRIEF.md + PANE-RULES.md from the config's `instructions`.
# Config files are never read here (they hold {file:} key references only); no key is printed or passed on a command line.
# After a restore: check bus_roster lists the name (the pane's own OC-PANE-BRIEF instructs it to bus_inbox on start,
# but a RESUMED session does not re-run startup instructions, so this script sends one prompt telling it to check in).
set -u
export PATH=$HOME/.local/bin:$PATH
REG="${OC_REGISTRY:-$HOME/oc/REGISTRY.tsv}"
DRY=0; [ "${1:-}" = "--dry-run" ] && { DRY=1; shift; }
WANT=("$@")
[ -f "$REG" ] || { echo "oc-restore: no $REG"; exit 2; }
herdr integration status 2>/dev/null | grep -q '^opencode: current' || { echo "oc-restore: herdr opencode integration is not current on this machine: run 'herdr integration install opencode' first"; exit 3; }
LIVE=$(herdr agent list 2>/dev/null | python3 -c '
import json,sys
try: a=json.load(sys.stdin)["result"]["agents"]
except Exception: a=[]
print(" ".join(x.get("name") or "" for x in a if x.get("agent")=="opencode"))')
WSL=$(herdr workspace list 2>/dev/null | python3 -c '
import json,sys
try: w=json.load(sys.stdin)["result"]["workspaces"]
except Exception: w=[]
print(" ".join(x["workspace_id"] for x in w))')
hr() { herdr "$@" </dev/null; }   # herdr must never read the registry pipe (or the script) from stdin
tail -n +2 "$REG" | while IFS=$'\t' read -r NAME PANE MODEL CWD SID _rest || [ -n "$NAME" ]; do   # '|| [ -n ]': the registry's last line has no trailing newline
  [ -n "$NAME" ] || continue
  if [ ${#WANT[@]} -gt 0 ] && [[ " ${WANT[*]} " != *" $NAME "* ]]; then continue; fi
  if [[ " $LIVE " == *" $NAME "* ]]; then echo "live     $NAME"; continue; fi
  if [ -n "$CWD" ] && [ ! -d "$CWD" ]; then echo "SKIPPED  $NAME  cwd $CWD missing"; continue; fi
  if [ ! -f "$HOME/oc/$NAME/opencode.jsonc" ]; then echo "SKIPPED  $NAME  no ~/oc/$NAME/opencode.jsonc"; continue; fi
  WS=${PANE%%:*}
  if [[ " $WSL " != *" $WS "* ]]; then
    echo "$NAME: workspace $WS gone, creating one labelled $NAME"
    if [ "$DRY" = 1 ]; then echo "  DRY: hr workspace create --label $NAME --cwd ${CWD:-$HOME} --no-focus"; WS=WSDRY
    else WS=$(hr workspace create --label "$NAME" --cwd "${CWD:-$HOME}" --no-focus 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"].split(":")[0])' 2>/dev/null); fi
    [ -n "$WS" ] || { echo "FAILED   $NAME  workspace create"; continue; }
  fi
  ARG=(-m "$MODEL"); [ -n "$SID" ] && ARG=(-s "$SID" -m "$MODEL")
  CFG="$HOME/oc/$NAME/opencode.jsonc"
  if [ "$DRY" = 1 ]; then
    echo "  DRY: hr tab create --workspace $WS --cwd ${CWD:-$HOME} --label \"$NAME · OpenCode ${MODEL#opencode/}\""
    echo "  DRY: export OPENCODE_CONFIG=$CFG in the new pane's shell"
    echo "  DRY: hr agent start $NAME --kind opencode --pane <new pane> -- ${ARG[*]}   (names atomically at spawn; session: ${SID:-none: FRESH session from the handover})"
    echo "  DRY: prompt $NAME to bus_inbox and post ONLINE"
    echo "would restore $NAME"; continue
  fi
  OUT=$(hr tab create --workspace "$WS" --cwd "${CWD:-$HOME}" --label "$NAME · OpenCode ${MODEL#opencode/}" 2>&1)
  NEWP=$(echo "$OUT" | python3 -c 'import json,sys;r=json.load(sys.stdin)["result"];print((r.get("root_pane") or r.get("pane") or {}).get("pane_id") or r.get("pane_id"))' 2>/dev/null)
  if [ -z "$NEWP" ] || [ "$NEWP" = None ]; then echo "FAILED   $NAME  tab create: $OUT"; continue; fi
  sleep 1
  hr pane send-text "$NEWP" "export OPENCODE_CONFIG=$CFG" >/dev/null 2>&1
  hr pane send-keys "$NEWP" Enter >/dev/null 2>&1
  sleep 1
  START_OUT=$(hr agent start "$NAME" --kind opencode --pane "$NEWP" --timeout 60000 -- "${ARG[@]}" 2>&1)
  GOTNAME=$(echo "$START_OUT" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["result"]["agent"].get("name") or "")
except Exception: print("")' 2>/dev/null)
  if [ "$GOTNAME" != "$NAME" ]; then echo "FAILED   $NAME  agent start: $START_OUT"; continue; fi
  hr agent prompt "$NAME" "Reload / restore complete (session resumed). Please: bus_inbox, then bus_post to Fable and conductor: \"$NAME ONLINE on OpenCode (${MODEL#opencode/}), restored.\" Keep it short." >/dev/null 2>&1
  echo "restored $NAME  pane=$NEWP model=$MODEL session=${SID:-fresh}  - check-in prompt sent, verify bus_roster lists $NAME"
done
