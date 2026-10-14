#!/bin/zsh
# herdr-ctl.sh — control script for managing Claude Code agents running inside herdr.
# usage: /bin/zsh herdr-ctl.sh [--session NAME] [--dry-run] <subcommand> ...
#
# Subcommands: status | send NAME MSG | tag NAME TASK | compact NAME | clear NAME --ledger-ok
#              | model NAME MODEL | restart NAME | transcript NAME [--tail N]
#              | spawn NAME CWD MODEL [--skip-permissions]
#
# See herdr-ctl.README.md for full documentation of refusal rules and examples.

export PATH=/opt/homebrew/bin:/usr/bin:/bin

HERDR=herdr
SCRIPT_DIR="/Users/vinaybhardwaj/dev/_fable"
SCRATCH="/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/live/scratch"
LOG="$SCRATCH/herdr-ctl.log"
REG="/Users/vinaybhardwaj/dev/_fable/scratch/refute-bus/live/reg.json"
STATUS_JSON="$SCRATCH/herdr-status.json"
TRANSCRIPT_DIR="$SCRATCH/transcripts"

mkdir -p "$SCRATCH" "$TRANSCRIPT_DIR"

SESSION=""
DRY_RUN=0

while true; do
  case "$1" in
    --session) SESSION="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    *) break;;
  esac
done

SUB="$1"
if [ -n "$SUB" ]; then shift; fi

HFLAGS=()
[ -n "$SESSION" ] && HFLAGS=(--session "$SESSION")

hcli() { $HERDR "${HFLAGS[@]}" "$@"; }

log() { # $1=subcommand $2=target $3=result
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  echo "$ts | sess=${SESSION:-default} | $1 | $2 | $3" >> "$LOG"
}

# ---------- agent list / field lookup ----------

fetch_agents() {
  hcli agent list > "$SCRATCH/agent_list.json" 2>/dev/null
}

agent_field() { # $1=name $2=field
  python3 -c '
import json,sys
name=sys.argv[1]; field=sys.argv[2]
try:
    d=json.load(open(sys.argv[3]))
except Exception:
    print("__NOTFOUND__"); sys.exit(0)
for a in d.get("result",{}).get("agents",[]):
    if a.get("name")==name:
        if field=="session_id":
            print(a.get("agent_session",{}).get("value",""))
        else:
            print(a.get(field,""))
        sys.exit(0)
print("__NOTFOUND__")
' "$1" "$2" "$SCRATCH/agent_list.json"
}

require_agent_ok() { # $1=name -> sets AG_STATE AG_PANE AG_SESSION AG_CWD
  local name="$1"
  fetch_agents
  AG_STATE=$(agent_field "$name" agent_status)
  if [ "$AG_STATE" = "__NOTFOUND__" ] || [ -z "$AG_STATE" ]; then
    echo "unknown agent: $name" >&2
    log "$SUB" "$name" "unknown-agent"
    exit 4
  fi
  AG_PANE=$(agent_field "$name" pane_id)
  AG_SESSION=$(agent_field "$name" session_id)
  AG_CWD=$(agent_field "$name" cwd)
}

# ---------- pane footer parsing (busy / update / context hint) ----------

pane_flags() { # $1=pane_id -> sets BUSY UPDATE CTX
  local pane="$1" tmp out
  tmp=$(mktemp)
  hcli pane read "$pane" --source recent-unwrapped --lines 50 > "$tmp" 2>/dev/null
  out=$(python3 -c '
import re,sys
txt=open(sys.argv[1],encoding="utf-8",errors="replace").read()
busy=0
for m in re.finditer(r"(\d+)\s+(shells?|monitors?)", txt):
    if int(m.group(1))>0:
        busy=1
upd = 1 if "Restart to update" in txt else 0
ctx=""
cm=re.findall(r"/clear to save (\d+)k tokens", txt)
if cm: ctx=cm[-1]+"k"
print("BUSY=%d" % busy)
print("UPDATE=%d" % upd)
print("CTX=%s" % ctx)
' "$tmp")
  rm -f "$tmp"
  eval "$out"
}

# ---------- registry (per-session agent metadata) ----------

registry_get() { # $1=name $2=field
  local sess="${SESSION:-default}"
  python3 -c '
import json,sys,os
path=sys.argv[1]; sess=sys.argv[2]; name=sys.argv[3]; field=sys.argv[4]
if not os.path.exists(path):
    print(""); sys.exit(0)
try:
    d=json.load(open(path))
except Exception:
    print(""); sys.exit(0)
print(d.get(sess,{}).get(name,{}).get(field,""))
' "$REG" "$sess" "$1" "$2"
}

registry_set() { # $1=name $2=field $3=value
  local sess="${SESSION:-default}"
  python3 -c '
import json,sys,os
path=sys.argv[1]; sess=sys.argv[2]; name=sys.argv[3]; field=sys.argv[4]; val=sys.argv[5]
d={}
if os.path.exists(path):
    try: d=json.load(open(path))
    except Exception: d={}
d.setdefault(sess,{}).setdefault(name,{})[field]=val
json.dump(d, open(path,"w"), indent=2)
' "$REG" "$sess" "$1" "$2" "$3"
}

# ---------- refusal gate shared by compact/clear/model/restart ----------

check_mutation_allowed() { # $1=name
  local name="$1"
  require_agent_ok "$name"
  if [ "$AG_STATE" != "idle" ] && [ "$AG_STATE" != "done" ]; then
    echo "refuse: $name is '$AG_STATE' (must be idle or done; not blocked/working/unknown)" >&2
    log "$SUB" "$name" "refused-state-$AG_STATE"
    exit 3
  fi
  pane_flags "$AG_PANE"
  if [ "$BUSY" = "1" ]; then
    echo "refuse: $name is BUSY (background shells or monitors still running in its pane)" >&2
    log "$SUB" "$name" "refused-busy"
    exit 3
  fi
}

foreground_is_claude() { # $1=pane_id -> return 0 if claude still foreground, 1 otherwise
  hcli pane process-info --pane "$1" 2>/dev/null | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(1)
pi=d.get("result",{}).get("process_info",{})
fgid=pi.get("foreground_process_group_id")
fps=pi.get("foreground_processes",[])
leader=None
for p in fps:
    if p.get("pid")==fgid:
        leader=p; break
if leader is None and fps:
    leader=fps[-1]
cmd=""
if leader:
    cmd=leader.get("cmdline") or leader.get("argv0") or ""
sys.exit(0 if "claude" in cmd else 1)
'
}

# ---------- subcommands ----------

cmd_status() {
  fetch_agents
  local names_file
  names_file=$(mktemp)
  python3 -c '
import json
d=json.load(open("'"$SCRATCH"'/agent_list.json"))
for a in d.get("result",{}).get("agents",[]):
    n=a.get("name")
    if n:
        print(n)
' > "$names_file"
  printf "%-16s %-8s %-8s %-5s %-7s %-7s %-7s %s\n" "NAME" "PANE" "STATE" "BUSY" "CTX" "UPDATE" "MODEL" "TASK"
  echo "[]" > "$STATUS_JSON"
  local st pane sess cwd model task
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    st=$(agent_field "$name" agent_status)
    pane=$(agent_field "$name" pane_id)
    sess=$(agent_field "$name" session_id)
    cwd=$(agent_field "$name" cwd)
    pane_flags "$pane"
    model=$(registry_get "$name" model)
    task=$(registry_get "$name" task)
    [ -z "$model" ] && model="?"
    registry_set "$name" pane_id "$pane"
    registry_set "$name" cwd "$cwd"
    registry_set "$name" session_id "$sess"
    printf "%-16s %-8s %-8s %-5s %-7s %-7s %-7s %s\n" \
      "$name" "$pane" "$st" "$([ "$BUSY" = 1 ] && echo YES || echo -)" "${CTX:--}" \
      "$([ "$UPDATE" = 1 ] && echo YES || echo -)" "$model" "${task:--}"
    python3 -c '
import json,sys
p=sys.argv[1]
d=json.load(open(p))
d.append({
  "name":sys.argv[2],"pane":sys.argv[3],"state":sys.argv[4],
  "busy":sys.argv[5]=="1","ctx":sys.argv[6],"update":sys.argv[7]=="1",
  "model":sys.argv[8],"task":sys.argv[9],"session_id":sys.argv[10],"cwd":sys.argv[11]
})
json.dump(d, open(p,"w"), indent=2)
' "$STATUS_JSON" "$name" "$pane" "$st" "$BUSY" "$CTX" "$UPDATE" "$model" "$task" "$sess" "$cwd"
  done < "$names_file"
  rm -f "$names_file"
}

cmd_send() {
  local name="$1" msg="$2"
  require_agent_ok "$name"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would send to $name: $msg"
    log send "$name" "dry-run"
    return 0
  fi
  local out tc
  out=$(hcli agent prompt "$name" "$msg" 2>&1)
  tc=$(echo "$out" | grep -o -E '"(type|code)":"[a-z_]*"' | tr '\n' ' ')
  echo "$out"
  log send "$name" "$tc"
}

cmd_tag() {
  local name="$1" task="$2"
  require_agent_ok "$name"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would tag $name (pane $AG_PANE) with task: $task"
    log tag "$name" "dry-run"
    return 0
  fi
  local out
  out=$(hcli pane report-metadata "$AG_PANE" --source herdr-ctl --title "$task" 2>&1)
  registry_set "$name" task "$task"
  echo "$out"
  log tag "$name" "title-set:$task"
}

cmd_compact() {
  local name="$1"
  check_mutation_allowed "$name"
  local ctx_before="${CTX:-none}"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would /compact $name (context before: $ctx_before)"
    log compact "$name" "dry-run"
    return 0
  fi
  hcli agent prompt "$name" "/compact" >/dev/null 2>&1
  hcli agent wait "$name" --timeout 600000 >/dev/null 2>&1
  pane_flags "$AG_PANE"
  local ctx_after="${CTX:-none}"
  echo "compact $name: context before=$ctx_before after=$ctx_after"
  log compact "$name" "before=$ctx_before after=$ctx_after"
}

cmd_clear() {
  local name="$1"; shift
  local ledger_ok=0 a
  for a in "$@"; do [ "$a" = "--ledger-ok" ] && ledger_ok=1; done
  check_mutation_allowed "$name"
  if [ "$ledger_ok" != "1" ]; then
    echo "refuse: clear $name requires --ledger-ok (confirm a ledger entry has been made first)" >&2
    log clear "$name" "refused-no-ledger-ok"
    exit 3
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would /clear $name"
    log clear "$name" "dry-run"
    return 0
  fi
  hcli agent prompt "$name" "/clear" >/dev/null 2>&1
  echo "cleared $name"
  log clear "$name" "sent"
}

cmd_model() {
  local name="$1" model="$2"
  case "$model" in
    sonnet|opus|haiku) ;;
    *) echo "invalid model: '$model' (expected sonnet|opus|haiku)" >&2; exit 2;;
  esac
  check_mutation_allowed "$name"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would set $name model to $model"
    log model "$name" "dry-run"
    return 0
  fi
  hcli agent prompt "$name" "/model $model" >/dev/null 2>&1
  sleep 2
  local shown
  shown=$(hcli pane read "$AG_PANE" --source recent-unwrapped --lines 15 2>&1)
  echo "$shown"
  registry_set "$name" model "$model"
  log model "$name" "set-$model"
}

cmd_restart() {
  local name="$1"
  check_mutation_allowed "$name"
  local pane="$AG_PANE" sess="$AG_SESSION" cwd="$AG_CWD" model
  model=$(registry_get "$name" model)
  local pinfo skip=0
  pinfo=$(hcli pane process-info --pane "$pane" 2>&1)
  echo "$pinfo" | grep -q 'dangerously-skip-permissions' && skip=1
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would restart $name: pane=$pane session=$sess model=${model:-?} skip_permissions=$skip"
    log restart "$name" "dry-run"
    return 0
  fi
  hcli agent prompt "$name" "/exit" >/dev/null 2>&1
  local waited=0 shellready=0
  while [ $waited -lt 20 ]; do
    sleep 2; waited=$((waited+2))
    if ! foreground_is_claude "$pane"; then shellready=1; break; fi
  done
  if [ "$shellready" != "1" ]; then
    hcli pane send-keys "$pane" ctrl+c >/dev/null 2>&1
    sleep 1
    hcli pane send-keys "$pane" ctrl+c >/dev/null 2>&1
    waited=0
    while [ $waited -lt 10 ]; do
      sleep 2; waited=$((waited+2))
      if ! foreground_is_claude "$pane"; then shellready=1; break; fi
    done
  fi
  if [ "$shellready" != "1" ]; then
    echo "restart FAILED for $name: pane $pane is still not at a shell prompt." >&2
    echo "--- pane process-info ---" >&2
    hcli pane process-info --pane "$pane" >&2
    echo "--- pane read (recent-unwrapped) ---" >&2
    hcli pane read "$pane" --source recent-unwrapped --lines 20 >&2
    log restart "$name" "failed-no-shell"
    exit 1
  fi
  local extra=()
  [ -n "$model" ] && [ "$model" != "?" ] && extra+=(--model "$model")
  [ "$skip" = "1" ] && extra+=(--dangerously-skip-permissions)
  local startout
  startout=$(hcli agent start "$name" --kind claude --pane "$pane" --timeout 120000 -- --resume "$sess" -n "$name" "${extra[@]}" 2>&1)
  echo "$startout"
  fetch_agents
  local newstate newsess
  newstate=$(agent_field "$name" agent_status)
  newsess=$(agent_field "$name" session_id)
  if { [ "$newstate" = "idle" ] || [ "$newstate" = "done" ]; } && [ "$newsess" = "$sess" ]; then
    echo "restart OK for $name (session $sess preserved, state=$newstate)"
    registry_set "$name" pane_id "$pane"
    registry_set "$name" session_id "$sess"
    log restart "$name" "ok-session=$sess-state=$newstate"
  else
    echo "restart FAILED/UNCONFIRMED for $name: post-start state='$newstate' session='$newsess' (expected idle/done, session $sess)" >&2
    log restart "$name" "failed-state=$newstate-session=$newsess"
    exit 1
  fi
}

cmd_transcript() {
  local name="$1"; shift
  local tail_n=40
  while [ $# -gt 0 ]; do
    case "$1" in
      --tail) tail_n="$2"; shift 2;;
      *) shift;;
    esac
  done
  require_agent_ok "$name"
  local sess="$AG_SESSION"
  if [ -z "$sess" ]; then
    echo "no session id on record for $name" >&2
    log transcript "$name" "no-session-id"
    exit 1
  fi
  local file
  file=$(zsh -c 'setopt nullglob; for f in ~/.claude/projects/*/'"$sess"'.jsonl; do print -r -- $f; done' | head -1)
  if [ -z "$file" ]; then
    echo "transcript file not found for session $sess" >&2
    log transcript "$name" "file-not-found"
    exit 1
  fi
  local ts out
  ts=$(date '+%Y%m%dT%H%M%S')
  out="$TRANSCRIPT_DIR/${name}-${ts}.md"
  local count
  count=$(python3 -c '
import json,sys
path, n, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
turns=[]
with open(path, encoding="utf-8", errors="replace") as f:
    for line in f:
        line=line.strip()
        if not line: continue
        try: obj=json.loads(line)
        except Exception: continue
        t=obj.get("type")
        if t not in ("user","assistant"): continue
        msg=obj.get("message") or {}
        content=msg.get("content")
        parts=[]
        if isinstance(content, str):
            if content.strip(): parts.append(("text", content))
        elif isinstance(content, list):
            for c in content:
                if not isinstance(c, dict): continue
                ctype=c.get("type")
                if ctype=="text":
                    if c.get("text","").strip(): parts.append(("text", c.get("text","")))
                elif ctype=="tool_use":
                    parts.append(("tool", c.get("name","?")))
                elif ctype=="tool_result":
                    parts.append(("tool_result", None))
        if parts:
            turns.append((t, parts))
sel = turns[-n:]
lines=[]
for role, parts in sel:
    lines.append("## " + role)
    for kind, val in parts:
        if kind=="text":
            lines.append(val.strip())
        elif kind=="tool":
            lines.append("[tool: " + val + "]")
        elif kind=="tool_result":
            lines.append("[tool result omitted]")
    lines.append("")
with open(out, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
print(len(sel))
' "$file" "$tail_n" "$out")
  local size
  size=$(stat -f%z "$out" 2>/dev/null || wc -c < "$out")
  echo "$out"
  echo "messages: $count"
  echo "size: $size bytes"
  log transcript "$name" "file=$out count=$count size=$size"
}

cmd_spawn() {
  local name="$1" cwd="$2" model="$3"; shift 3
  local skip=0 a
  for a in "$@"; do [ "$a" = "--skip-permissions" ] && skip=1; done
  case "$model" in
    sonnet|opus|haiku) ;;
    *) echo "invalid model: '$model' (expected sonnet|opus|haiku)" >&2; exit 2;;
  esac
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would spawn $name in $cwd model=$model skip_permissions=$skip"
    log spawn "$name" "dry-run"
    return 0
  fi
  local wsout pane
  wsout=$(hcli workspace create --label "$name" --cwd "$cwd" --no-focus 2>&1)
  pane=$(echo "$wsout" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    print(d["result"]["root_pane"]["pane_id"])
except Exception:
    print("")
')
  if [ -z "$pane" ]; then
    echo "spawn FAILED: workspace create did not return a pane. output: $wsout" >&2
    log spawn "$name" "failed-workspace"
    exit 1
  fi
  sleep 2
  local extra=()
  [ "$skip" = "1" ] && extra+=(--dangerously-skip-permissions)
  local startout
  startout=$(hcli agent start "$name" --kind claude --pane "$pane" -- --model "$model" -n "$name" "${extra[@]}" 2>&1)
  echo "$startout"
  fetch_agents
  local newstate sess
  newstate=$(agent_field "$name" agent_status)
  sess=$(agent_field "$name" session_id)
  if [ "$newstate" = "__NOTFOUND__" ] || [ -z "$newstate" ]; then
    echo "spawn WARNING: $name not visible via 'agent list' yet (may still be at a startup dialog, e.g. workspace-trust)." >&2
    echo "check with: herdr --session ${SESSION:-default} agent get $name" >&2
    log spawn "$name" "warn-not-visible pane=$pane"
    exit 1
  fi
  registry_set "$name" pane_id "$pane"
  registry_set "$name" cwd "$cwd"
  registry_set "$name" session_id "$sess"
  registry_set "$name" model "$model"
  registry_set "$name" task ""
  echo "spawn OK for $name (pane=$pane session=$sess state=$newstate)"
  log spawn "$name" "pane=$pane-session=$sess-state=$newstate"
}

# ---------- dispatch ----------

case "$SUB" in
  status) cmd_status ;;
  send) cmd_send "$@" ;;
  tag) cmd_tag "$@" ;;
  compact) cmd_compact "$@" ;;
  clear) cmd_clear "$@" ;;
  model) cmd_model "$@" ;;
  restart) cmd_restart "$@" ;;
  transcript) cmd_transcript "$@" ;;
  spawn) cmd_spawn "$@" ;;
  *)
    echo "usage: herdr-ctl.sh [--session NAME] [--dry-run] <status|send|tag|compact|clear|model|restart|transcript|spawn> ..." >&2
    exit 2
    ;;
esac
