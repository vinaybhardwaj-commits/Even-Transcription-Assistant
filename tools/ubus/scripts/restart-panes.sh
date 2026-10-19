#!/usr/bin/env bash
# Restart every Claude Code pane on a host so it picks up the new ubus client, resuming the same conversation.
#   scripts/restart-panes.sh <ssh-host|local> [--session <herdr-session>] [--max-wait-s 600] [--only <name>] [--dry-run]
# Per herdr agent pane (all herdr sessions unless --session):
#   record name, pane, cwd, claude session id, model, permission mode  (from herdr agent list and the claude argv)
#   wait up to --max-wait-s for the pane to be idle/done
#   exit claude, then `herdr agent start <name> --kind claude --pane <pane> -- --resume <id> -n <name> --model <m> --permission-mode <p>`
#   confirm the same handle re-registered on ubus (heartbeat newer than the restart)
# Only kind=claude panes are restarted. Anything else, this script's own pane, and any pane whose flags
# cannot be read are skipped with a reason. One output line per pane. --dry-run reads (ssh, herdr agent list, ps) and sends nothing.
# shellcheck disable=SC2016,SC2029  # remote snippets are single-quoted on purpose
set -euo pipefail

HOST="${1:-}"
[ -n "$HOST" ] || { echo "usage: $0 <ssh-host|local> [--session NAME] [--max-wait-s N] [--only NAME] [--dry-run]" >&2; exit 2; }
shift
ONLY_SESSION=""; ONLY_NAME=""; MAXWAIT=600; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --session) ONLY_SESSION="${2:-}"; shift 2 ;;
    --only) ONLY_NAME="${2:-}"; shift 2 ;;
    --max-wait-s) MAXWAIT="${2:-600}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

# Hosts this tooling must never touch (same list as isDeniedMachine in src/constants.ts, plus the ssh alias icu).
deny_host() {
  local h="${1##*@}"; h="$(printf '%s' "$h" | tr '[:upper:]' '[:lower:]')"
  case "$h" in
    ehrc-*|orb2|vinay-orb2|icu) echo "refused: host '$1' is a denied machine (hospital kiosk, ICU Mac, or OT recorder). Nothing was contacted." >&2; exit 3 ;;
  esac
}
deny_host "$HOST"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8)
UBUS_URL="${UBUS_URL:-http://127.0.0.1:8790/mcp}"

# stdin is closed on every call: this runs inside a while-read loop and ssh/bash would eat the plan
remote() { if [ "$HOST" = local ]; then bash -c "$1" </dev/null; else ssh -n "${SSH_OPTS[@]}" "$HOST" "$1"; fi; }

# Locate herdr on the host
HERDR="$(remote 'command -v herdr || ls /opt/homebrew/opt/herdr/bin/herdr /opt/homebrew/bin/herdr /usr/local/bin/herdr "$HOME/.local/bin/herdr" 2>/dev/null | head -1' 2>/dev/null || true)"
if [ -z "$HERDR" ]; then echo "$HOST: no herdr on this host; no panes to restart"; exit 0; fi

# Inventory in one remote call: sessions, per-session agent list, and claude argv lines
INV="$(remote "
H='$HERDR'
echo '#SESSIONS'; \$H session list 2>/dev/null | awk 'NR>1 && \$2==\"running\" {print \$1}'
for s in \$(\$H session list 2>/dev/null | awk 'NR>1 && \$2==\"running\" {print \$1}'); do
  echo \"#AGENTS \$s\"
  \$H --session \"\$s\" agent list 2>/dev/null
  echo
done
echo '#PS'; ps -ax -o args= 2>/dev/null | grep -E '(^|/)claude( |\$)' | grep -v -- '--chrome-native-host' || true
echo '#SELF'; echo \"\${HERDR_PANE_ID:-}\"; echo \"\${HERDR_SESSION:-}\"; echo \"\${HERDR_SOCKET_PATH:-}\"
")" || { echo "$HOST: unreachable"; exit 1; }

PLAN="$(printf '%s\n' "$INV" | ONLY_SESSION="$ONLY_SESSION" ONLY_NAME="$ONLY_NAME" HOST_IS_LOCAL="$([ "$HOST" = local ] && echo 1 || echo 0)" python3 -c '
import json, os, re, sys
text = sys.stdin.read()
only = os.environ.get("ONLY_SESSION", "")
sections = re.split(r"^#(SESSIONS|AGENTS [^\n]*|PS|SELF)\n", text, flags=re.M)
agents, psl, selfpane, selfsess = [], [], "", "default"
only_name = os.environ.get("ONLY_NAME", "")
local = os.environ.get("HOST_IS_LOCAL") == "1"
for i in range(1, len(sections), 2):
    head, body = sections[i], sections[i + 1]
    if head.startswith("AGENTS "):
        sess = head.split(" ", 1)[1].strip()
        if only and sess != only: continue
        try: lst = json.loads(body.strip() or "{}").get("result", {}).get("agents", [])
        except Exception: lst = []
        for a in lst: a["_session"] = sess; agents.append(a)
    elif head == "PS": psl = [l for l in body.splitlines() if l.strip()]
    elif head == "SELF":
        parts = (body.split("\n") + ["", "", ""])[:3]
        selfpane = parts[0].strip()
        # real session of the running pane: HERDR_SESSION, else the socket path (.../sessions/<name>/herdr.sock, or the default dir)
        selfsess = parts[1].strip()
        if not selfsess and parts[2].strip():
            m = re.search(r"/sessions/([^/]+)/herdr\.sock$", parts[2].strip())
            selfsess = m.group(1) if m else "default"
        selfsess = selfsess or "default"
def flag(args, name):
    m = re.search(r"(?:^| )" + re.escape(name) + r" (\S+)", args)
    return m.group(1) if m else ""
out = []
for a in agents:
    if only_name and a.get("name") != only_name: continue
    name = a.get("name") or a.get("pane_id", "?")
    row = {"session": a["_session"], "name": name, "pane": a.get("pane_id", ""), "cwd": a.get("cwd", ""),
           "kind": a.get("agent", ""), "status": a.get("agent_status", ""),
           "claude_session": (a.get("agent_session") or {}).get("value", "")}
    argv = next((l for l in psl if re.search(r"(?:^| )-n " + re.escape(name) + r"(?: |$)", l)), "")
    row["model"] = flag(argv, "--model"); row["mode"] = flag(argv, "--permission-mode")
    if not row["claude_session"]: row["claude_session"] = flag(argv, "--resume")
    if row["kind"] != "claude": row["skip"] = "not a claude coding agent (kind=%s)" % row["kind"]
    elif local and selfpane and row["pane"] == selfpane and row["session"] == selfsess: row["skip"] = "this script is running in this pane"
    elif not row["claude_session"]: row["skip"] = "no claude session id from herdr"
    elif not argv or not row["model"] or not row["mode"]: row["skip"] = "no model/mode"
    out.append(row)
print(json.dumps(out))
')"

COUNT="$(printf '%s' "$PLAN" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')"
echo "$HOST: $COUNT herdr agent pane(s), max-wait ${MAXWAIT}s, dry-run $DRY"
[ "$COUNT" -gt 0 ] || exit 0

hcmd() { # herdr command on host in a session: hcmd <session> <args...>
  local s="$1"; shift
  local q; q="$(printf ' %q' "$@")"
  remote "'$HERDR' --session '$s'$q"
}

ubus_beat() { # last heartbeat of a handle, via the ubus HTTP door on this machine; empty if unknown
  curl -s -m 8 -X POST "$UBUS_URL" -H 'content-type: application/json' -H 'accept: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ubus_directory","arguments":{"q":sys.argv[1],"presence":"all"}}}))' "$1")" 2>/dev/null |
  python3 -c 'import json,sys
n=sys.argv[1]
try:
  t=json.loads(json.load(sys.stdin)["result"]["content"][0]["text"])
  for a in t["agents"]:
    if a["handle"]==n: print(a.get("last_heartbeat_at") or "", a.get("presence",""), a.get("client_version") or "-")
except Exception: pass' "$1"
}

fails=0
while IFS=$'\x1f' read -r session name pane cwd cid model mode status skip; do
  tag="$session/$name"
  detail="pane=$pane cwd=$cwd claude=${cid:-?} model=${model:-?} mode=${mode:-?} status=$status"
  if [ -n "$skip" ]; then echo "SKIP    $tag  $skip  ($detail)"; continue; fi
  if [ "$DRY" = 1 ]; then
    echo "DRY-RUN $tag  would wait <=${MAXWAIT}s for idle, then: exit claude; herdr agent start $name --kind claude --pane $pane -- --resume $cid -n $name --model $model --permission-mode $mode; then confirm ubus handle $name  ($detail)"
    continue
  fi
  if ! hcmd "$session" agent wait "$name" --until idle --until "done" --timeout "$((MAXWAIT * 1000))" >/dev/null 2>&1; then
    echo "BUSY    $tag  not idle after ${MAXWAIT}s; left running  ($detail)"; continue
  fi
  before="$(ubus_beat "$name" || true)"
  hcmd "$session" agent send-keys "$name" "C-c" >/dev/null 2>&1 || true
  sleep 1
  hcmd "$session" agent prompt "$name" "/exit" >/dev/null 2>&1 || hcmd "$session" agent send-keys "$name" "/exit" "Enter" >/dev/null 2>&1 || true
  sleep 4
  if hcmd "$session" agent start "$name" --kind claude --pane "$pane" --timeout 120000 -- --resume "$cid" -n "$name" --model "$model" --permission-mode "$mode" >/dev/null 2>&1; then
    ok=""
    for _ in $(seq 1 30); do
      after="$(ubus_beat "$name" || true)"
      if [ -n "$after" ] && [ "$after" != "$before" ]; then ok="$after"; break; fi
      sleep 2
    done
    if [ -n "$ok" ]; then echo "RESTART $tag  re-registered as $name ($ok)  ($detail)"; else echo "WARN    $tag  restarted but no new ubus heartbeat for $name in 60s  ($detail)"; fails=$((fails+1)); fi
  else
    echo "FAIL    $tag  herdr agent start failed; pane may be at a shell prompt  ($detail)"; fails=$((fails+1))
  fi
done < <(printf '%s' "$PLAN" | python3 -c '
import json,sys
for r in json.load(sys.stdin):
    print("\x1f".join([r["session"], r["name"], r["pane"], r["cwd"], r["claude_session"], r["model"], r["mode"], r["status"], r.get("skip","")]))')
[ "$fails" = 0 ]
