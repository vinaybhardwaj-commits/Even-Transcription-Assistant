#!/bin/zsh
# herdr-ctl.sh — control script for managing Claude Code agents running inside herdr.
# usage: /bin/zsh herdr-ctl.sh [--session NAME] [--dry-run] <subcommand> ...
#
# Subcommands: status | send NAME MSG | tag NAME TASK | compact NAME | clear NAME --ledger-ok
#              | model NAME MODEL | restart NAME | transcript NAME [--tail N]
#              | spawn NAME CWD MODEL [--skip-permissions]
#
# v2 (fix round, 2026-09-23): per-agent locking, no /model, restart reads and
# verifies model+permission mode explicitly, atomic registry writes, no
# shared scratch files across concurrent invocations, footer-only BUSY
# parsing, input-box-draft refusal, dialog-safe /exit. See
# herdr-ctl.README.md.

export PATH=/opt/homebrew/bin:/usr/bin:/bin

HERDR=herdr
# eta-lab move (2026-09-23): this script and herdr-registry.json now live
# canonically in eta-lab/kit/; scratch/, bus/ etc. stayed at the eta-lab
# repo root. A compat symlink (~/dev/_fable -> ~/dev/eta-lab) still resolves
# the old path, but these are the canonical ones — not symlink-dependent.
LAB_DIR="/Users/vinaybhardwaj/dev/eta-lab"
KIT_DIR="$LAB_DIR/kit"
SCRATCH="$LAB_DIR/scratch"
LOG="$SCRATCH/herdr-ctl.log"
REG="${HERDR_CTL_TEST_REG:-$KIT_DIR/herdr-registry.json}"  # test-only override
TRANSCRIPT_DIR="$SCRATCH/transcripts"
LOCKS_DIR="$SCRATCH/locks"
RUNDIR="$SCRATCH/run"

mkdir -p "$SCRATCH" "$TRANSCRIPT_DIR" "$LOCKS_DIR" "$RUNDIR"

# Private-per-invocation files (H6/H3 fix): never share scratch/agent_list.json
# or scratch/herdr-status.json across concurrent processes again.
AGENT_LIST_FILE=$(mktemp "$RUNDIR/agent_list.XXXXXX")
STATUS_JSON_FILE=""  # only set (and kept, not deleted) by cmd_status

SESSION=""
MACHINE=""
DRY_RUN=0

while true; do
  case "$1" in
    --session) SESSION="$2"; shift 2;;
    --machine) MACHINE="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    *) break;;
  esac
done

if [ -n "$SESSION" ] && [ -n "$MACHINE" ]; then
  echo "usage: --session and --machine are mutually exclusive (herdr itself refuses combining them: --machine uses the saved machine's own default session)" >&2
  exit 2
fi

SUB="$1"
if [ -n "$SUB" ]; then shift; fi

# PANES-TO-E2E move (23 Sep 2026): a herdr "machine" (e.g. the eta-lab-t4
# box) is a completely separate herdr server with its own pane/agent
# namespace — `herdr --machine X agent list` never overlaps with the local
# `herdr agent list`, confirmed live (a probe workspace created via
# `--machine eta-lab-t4` never appeared in the Mini's own default-session
# `workspace list`). REGISTRY_KEY namespaces the registry/log by machine
# too, so a moved agent's registry entry can never collide with a
# same-named or coincidentally-same-slot entry under the Mini's own
# "default" session key.
HFLAGS=()
if [ -n "$MACHINE" ]; then
  HFLAGS=(--machine "$MACHINE")
elif [ -n "$SESSION" ]; then
  HFLAGS=(--session "$SESSION")
fi
REGISTRY_KEY="${MACHINE:+machine:$MACHINE}"
REGISTRY_KEY="${REGISTRY_KEY:-${SESSION:-default}}"
# F1 regression fix (eta-refuter 27 Sep, report 5107): eta-bus-mcp's
# KNOWN_MACHINES now passes herdr machines BY ID (name lookups cost ~2 s,
# eta-refuter msg 5100), but the registry/log namespace is keyed
# machine:<LABEL>. Resolve a 32-hex id to its label once via the read-only
# `herdr machine list`, and key the registry under the label so existing
# registry data (machine:eta-lab-t4 etc.) keeps matching. No label match
# or listing failure: fall back to the raw id key — fail-safe, no
# behavior change for keys that were already correct.
if [[ "$MACHINE" =~ ^[0-9a-f]{32}$ ]]; then
  _MACH_LABEL=$("$HERDR" machine list 2>/dev/null \
    | python3 -c '
import sys
mid = sys.argv[1]
for line in sys.stdin:
    parts = line.rstrip("\n").split("\t")
    if len(parts) >= 2 and parts[0] == mid:
        print(parts[1]); break
' "$MACHINE")
  REGISTRY_KEY="machine:${_MACH_LABEL:-$MACHINE}"
fi

hcli() { $HERDR "${HFLAGS[@]}" "$@"; }

log() { # $1=subcommand $2=target $3=result
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  echo "$ts | sess=$REGISTRY_KEY | $1 | $2 | $3" >> "$LOG"
}

# ---------- per-agent locking (mkdir is atomic on every POSIX fs; no
# `flock` binary is installed on this Mac, so this is the portable
# equivalent — same guarantee: at most one holder at a time) ----------

typeset -a LOCKS_HELD
LOCKS_HELD=()

cleanup_locks() {
  local n
  for n in "${LOCKS_HELD[@]}"; do
    rmdir "$LOCKS_DIR/$n.lock" 2>/dev/null
  done
  rm -f "$AGENT_LIST_FILE" 2>/dev/null
}
trap cleanup_locks EXIT

acquire_lock() { # $1=name
  local name="$1"
  local dir="$LOCKS_DIR/$name.lock" waited=0 age now mtime
  while true; do
    if mkdir "$dir" 2>/dev/null; then
      LOCKS_HELD+=("$name")
      return 0
    fi
    now=$(date +%s)
    mtime=$(stat -f %m "$dir" 2>/dev/null || echo "$now")
    age=$((now - mtime))
    if [ "$age" -gt 120 ]; then
      rmdir "$dir" 2>/dev/null
      continue
    fi
    sleep 0.2
    waited=$((waited + 1))
    if [ "$waited" -gt 150 ]; then
      echo "refuse: could not acquire lock for $name within ~30s (another operation holds it)" >&2
      log "$SUB" "$name" "refused-lock-timeout"
      exit 3
    fi
  done
}

release_lock() { # $1=name
  local name="$1"
  rmdir "$LOCKS_DIR/$name.lock" 2>/dev/null
  LOCKS_HELD=("${(@)LOCKS_HELD:#$name}")
}

# ---------- agent list / field lookup (private per-invocation file) ----------

fetch_agents() {
  hcli agent list > "$AGENT_LIST_FILE" 2>/dev/null
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
' "$1" "$2" "$AGENT_LIST_FILE"
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

# ---------- footer-only parsing: BUSY / UPDATE / CTX / permission mode /
# dialog. All read a SMALL tail (the footer), never 50 lines of scrollback
# (H5's false-positive-from-old-scrollback finding). ----------

FOOTER_LINES=8

read_footer_plain() { # $1=pane -> prints text
  hcli pane read "$1" --source recent-unwrapped --lines "$FOOTER_LINES" 2>/dev/null
}

busy_wording_hit() { # $1=text -> "1" or "0"
  local text="$1" low
  low=$(print -r -- "$text" | tr '[:upper:]' '[:lower:]')
  if print -r -- "$low" | grep -Eq '[0-9]+[[:space:]]+(shells?|monitors?|tasks?|agents?)'; then
    echo 1; return
  fi
  # O3 (fix round 3): the old bare-word fallback
  # (background agent|waiting for|shells|shell|monitor|running) matched
  # those words ANYWHERE in the 8-line read, including the agent's own
  # prior reply text ("I am running the tests now", "the monitor showed 3
  # errors", "Bash(npm test) running" all read as BUSY). Anchoring to only
  # the true footer text below the last prompt marker (see
  # footer_suffix_only, called by pane_flags before this) removes the need
  # for a bare-word catch-all: "waiting for" is kept because it is the
  # literal, distinctive footer wording ("Waiting for N ... to finish") and
  # never appears in the isolated footer suffix otherwise.
  if print -r -- "$low" | grep -Eq 'waiting for'; then
    echo 1; return
  fi
  echo 0
}

# O3 (fix round 3): isolate the real footer/status text — everything AFTER
# the last prompt-marker (❯) line in a pane read — instead of scanning the
# whole multi-line read for keywords. Ruling 5 says "footer line only";
# the input box marker is the one reliable anchor herdr/Claude Code's UI
# gives us (same anchor input_box_has_draft already uses). Falls back to
# the last 2 raw lines only if no marker is found at all (fail toward
# still checking something, not toward silently never flagging BUSY).
footer_suffix_only() { # $1=raw multi-line pane text -> prints the footer-only tail
  python3 -c '
import sys
text = sys.argv[1]
lines = text.splitlines()
marker = "❯"
idx = -1
for i, line in enumerate(lines):
    if marker in line:
        idx = i
tail = lines[idx + 1:] if idx >= 0 else lines[-2:]
print("\n".join(tail))
' "$1"
}

pane_flags() { # $1=pane_id -> sets BUSY UPDATE CTX
  local pane="$1" text footer
  text=$(read_footer_plain "$pane")
  footer=$(footer_suffix_only "$text")
  BUSY=$(busy_wording_hit "$footer")
  UPDATE=0
  print -r -- "$text" | grep -q "Restart to update" && UPDATE=1
  CTX=""
  local ctxline
  ctxline=$(print -r -- "$text" | grep -o '/clear to save [0-9]*k tokens' | tail -1)
  [ -n "$ctxline" ] && CTX=$(print -r -- "$ctxline" | grep -o '[0-9]*k')
}

footer_permission_mode() { # $1=pane -> prints one of: skip auto manual plan acceptEdits bypassPermissions "" (unknown)
  local pane="$1" text low
  text=$(hcli pane read "$pane" --source recent-unwrapped --lines 10 2>/dev/null)
  low=$(print -r -- "$text" | tr '[:upper:]' '[:lower:]')
  if print -r -- "$low" | grep -q "bypass"; then echo skip; return; fi
  if print -r -- "$low" | grep -q "auto mode"; then echo auto; return; fi
  if print -r -- "$low" | grep -q "manual mode"; then echo manual; return; fi
  if print -r -- "$low" | grep -q "plan mode"; then echo plan; return; fi
  if print -r -- "$low" | grep -q "accept edits"; then echo acceptEdits; return; fi
  echo ""
}

pane_has_dialog() { # $1=pane -> "1"/"0"
  local pane="$1" text low
  text=$(hcli pane read "$pane" --source recent-unwrapped --lines 15 2>/dev/null)
  low=$(print -r -- "$text" | tr '[:upper:]' '[:lower:]')
  if print -r -- "$low" | grep -qE 'background work is running|will stop when you exit|exit and stop tasks'; then
    echo 1; return
  fi
  echo 0
}

# Input-box draft detector (H4): reads the pane in ANSI form and looks at
# the line containing the prompt marker ❯. A real typed draft is plain,
# unstyled text (no SGR codes at all — confirmed live: typing "hello" into
# an empty box renders as literally `❯ hello` with zero escape codes). A
# suggestion/placeholder — classic dim (ESC[2m) OR (fix round 6, CONFIRMED
# live) a truecolor-highlighted ghost/autocomplete row, e.g. a leftover
# "/exit" hint rendered white-on-grey via explicit 38;2;/48;2;m codes with
# a background fill padded to the line width — is always wrapped in an
# EXPLICIT color escape, never plain. So: any text under dim OR under an
# explicit foreground/background color code is styling, not a draft; only
# plain, uncolored, non-whitespace text after the marker counts as real.
DRAFT_PARSE_PY='
import re, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
lines = re.split(r"\r\n|\r|\n", text)
marker = "❯"  # ❯
for line in lines:
    if marker not in line:
        continue
    rest = line[line.index(marker) + len(marker):]
    dim = False
    styled = False
    i = 0
    seen_bright = False
    while i < len(rest):
        if rest[i] == "\x1b":
            m = re.match(r"\x1b\[[0-9;]*m", rest[i:])
            if m:
                code = m.group(0)
                if code == "\x1b[2m":
                    dim = True
                elif code == "\x1b[22m":
                    dim = False
                elif code == "\x1b[0m":
                    dim = False
                    styled = False
                elif re.match(r"\x1b\[(38|48);", code) or code in ("\x1b[39m", "\x1b[49m"):
                    styled = code not in ("\x1b[39m", "\x1b[49m")
                i += len(code)
                continue
            i += 1
            continue
        ch = rest[i]
        if not dim and not styled and not ch.isspace():
            seen_bright = True
        i += 1
    print(1 if seen_bright else 0)
    sys.exit(0)
print(0)
'

input_box_has_draft() { # $1=pane -> "1"/"0"
  local pane="$1" tmp result
  tmp=$(mktemp "$RUNDIR/ansi.XXXXXX")
  hcli pane read "$pane" --source recent-unwrapped --format ansi --lines "$FOOTER_LINES" > "$tmp" 2>/dev/null
  result=$(python3 -c "$DRAFT_PARSE_PY" "$tmp")
  rm -f "$tmp"
  echo "$result"
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

# ---------- registry (locked, atomic write; read-only from `status`) ----------

registry_get() { # $1=name $2=field
  local sess="$REGISTRY_KEY"
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

# Locked, write-to-temp, atomic-rename registry write. Only spawn/restart/
# tag write here now (H3/H6 fix) — `status` never calls this.
registry_set() { # $1=name $2=field $3=value
  local sess="$REGISTRY_KEY"
  acquire_lock "_registry"
  python3 -c '
import json,sys,os,tempfile
path=sys.argv[1]; sess=sys.argv[2]; name=sys.argv[3]; field=sys.argv[4]; val=sys.argv[5]
d={}
if os.path.exists(path):
    try: d=json.load(open(path))
    except Exception: d={}
d.setdefault(sess,{}).setdefault(name,{})[field]=val
dirn=os.path.dirname(path) or "."
fd, tmp = tempfile.mkstemp(prefix=".registry.", dir=dirn)
with os.fdopen(fd, "w") as f:
    json.dump(d, f, indent=2)
os.replace(tmp, path)
' "$REG" "$sess" "$1" "$2" "$3"
  release_lock "_registry"
}

# ---------- shared refusal guard: lock must already be held by the caller.
# Re-checks state IMMEDIATELY before typing (H2), including the input box
# (H4) and the new footer-only BUSY wording (H5). ----------

guard_before_typing() { # $1=name -> sets AG_STATE AG_PANE AG_SESSION AG_CWD; exits on refusal
  local name="$1"
  require_agent_ok "$name"
  if [ "$AG_STATE" != "idle" ] && [ "$AG_STATE" != "done" ]; then
    echo "refuse: $name is '$AG_STATE' (must be idle or done; not blocked/working/unknown)" >&2
    log "$SUB" "$name" "refused-state-$AG_STATE"
    exit 3
  fi
  pane_flags "$AG_PANE"
  if [ "$BUSY" = "1" ]; then
    echo "refuse: $name is BUSY (footer shows background shells/monitors/agents/tasks running)" >&2
    log "$SUB" "$name" "refused-busy"
    exit 3
  fi
  if [ "$(input_box_has_draft "$AG_PANE")" = "1" ]; then
    echo "refuse: $name's input box is not empty (unsent draft text) — will not clobber it" >&2
    log "$SUB" "$name" "refused-draft-in-box"
    exit 3
  fi
}

# ---------- subcommands ----------

cmd_status() {
  # opportunistic cleanup of old private status files (>1h)
  find "$RUNDIR" -name 'status.*' -mmin +60 -delete 2>/dev/null
  STATUS_JSON_FILE=$(mktemp "$RUNDIR/status.XXXXXX")
  fetch_agents
  local names_file
  names_file=$(mktemp "$RUNDIR/names.XXXXXX")
  python3 -c '
import json
d=json.load(open("'"$AGENT_LIST_FILE"'"))
for a in d.get("result",{}).get("agents",[]):
    n=a.get("name")
    if n:
        print(n)
' > "$names_file"
  echo "STATUS_JSON $STATUS_JSON_FILE"
  printf "%-16s %-8s %-8s %-5s %-7s %-7s %-7s %s\n" "NAME" "PANE" "STATE" "BUSY" "CTX" "UPDATE" "MODEL" "TASK"
  echo "[]" > "$STATUS_JSON_FILE"
  local st pane sess cwd model task
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    st=$(agent_field "$name" agent_status)
    pane=$(agent_field "$name" pane_id)
    sess=$(agent_field "$name" session_id)
    cwd=$(agent_field "$name" cwd)
    pane_flags "$pane"
    # status is READ-ONLY on the registry (H3/H6 fix): no registry_set here.
    model=$(registry_get "$name" model)
    task=$(registry_get "$name" task)
    [ -z "$model" ] && model="?"
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
' "$STATUS_JSON_FILE" "$name" "$pane" "$st" "$BUSY" "$CTX" "$UPDATE" "$model" "$task" "$sess" "$cwd"
  done < "$names_file"
  rm -f "$names_file"
}

cmd_send() {
  local name="$1" msg="$2"
  acquire_lock "$name"
  guard_before_typing "$name"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would send to $name: $msg"
    log send "$name" "dry-run"
    release_lock "$name"; return 0
  fi
  local out tc
  out=$(hcli agent prompt "$name" "$msg" 2>&1)
  tc=$(echo "$out" | grep -o -E '"(type|code)":"[a-z_]*"' | tr '\n' ' ')
  echo "$out"
  log send "$name" "$tc"
  release_lock "$name"
}

cmd_tag() {
  local name="$1" task="$2"
  acquire_lock "$name"
  require_agent_ok "$name"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would tag $name (pane $AG_PANE) with task: $task"
    log tag "$name" "dry-run"
    release_lock "$name"; return 0
  fi
  local out
  out=$(hcli pane report-metadata "$AG_PANE" --source herdr-ctl --title "$task" 2>&1)
  registry_set "$name" task "$task"
  echo "$out"
  log tag "$name" "title-set:$task"
  release_lock "$name"
}

cmd_compact() {
  local name="$1"
  acquire_lock "$name"
  guard_before_typing "$name"
  local ctx_before="${CTX:-none}"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would /compact $name (context before: $ctx_before)"
    log compact "$name" "dry-run"
    release_lock "$name"; return 0
  fi
  hcli agent prompt "$name" "/compact" >/dev/null 2>&1
  hcli agent wait "$name" --timeout 600000 >/dev/null 2>&1
  pane_flags "$AG_PANE"
  local ctx_after="${CTX:-none}"
  echo "compact $name: context before=$ctx_before after=$ctx_after"
  log compact "$name" "before=$ctx_before after=$ctx_after"
  release_lock "$name"
}

cmd_clear() {
  local name="$1"; shift
  local ledger_ok=0 a
  for a in "$@"; do [ "$a" = "--ledger-ok" ] && ledger_ok=1; done
  acquire_lock "$name"
  guard_before_typing "$name"
  local old_sess="$AG_SESSION"
  if [ "$ledger_ok" != "1" ]; then
    echo "refuse: clear $name requires --ledger-ok (confirm a ledger entry has been made first)" >&2
    log clear "$name" "refused-no-ledger-ok"
    release_lock "$name"; exit 3
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would /clear $name"
    log clear "$name" "dry-run"
    release_lock "$name"; return 0
  fi
  hcli agent prompt "$name" "/clear" >/dev/null 2>&1
  # O4 (fix round 3): verify the result instead of trusting agent_prompted.
  # VERDICT-2's H4 residual: only restart confirmed its own result; clear
  # printed "cleared" unconditionally. /clear always mints a new session id
  # (confirmed in the round-1 ctl-test log), so require that change before
  # reporting success.
  local waited=0 new_sess=""
  while [ $waited -lt 10 ]; do
    sleep 1; waited=$((waited + 1))
    fetch_agents
    new_sess=$(agent_field "$name" session_id)
    if [ -n "$new_sess" ] && [ "$new_sess" != "__NOTFOUND__" ] && [ "$new_sess" != "$old_sess" ]; then
      break
    fi
  done
  if [ -z "$new_sess" ] || [ "$new_sess" = "__NOTFOUND__" ] || [ "$new_sess" = "$old_sess" ]; then
    echo "clear UNCONFIRMED for $name: session id did not change after /clear (old=$old_sess new=$new_sess) — not reporting success" >&2
    log clear "$name" "unconfirmed-session=$old_sess"
    release_lock "$name"; exit 1
  fi
  echo "cleared $name (session $old_sess -> $new_sess VERIFIED)"
  log clear "$name" "ok-session=$old_sess-to-$new_sess"
  release_lock "$name"
}

# `model NAME MODEL` NEVER sends the /model slash command (it persists to
# the GLOBAL ~/.claude/settings.json default for every future session on
# this Mac — the exact live incident this fix round exists for). It is now
# session-scoped: a restart with an explicit --model override.
cmd_model() {
  local name="$1" model="$2"
  case "$model" in
    sonnet|opus|haiku) ;;
    *) echo "invalid model: '$model' (expected sonnet|opus|haiku)" >&2; exit 2;;
  esac
  do_restart "$name" "$model"
}

cmd_restart() {
  do_restart "$1" ""
}

# do_restart NAME [OVERRIDE_MODEL]
# - Reads the CURRENT model from the session transcript (or uses
#   OVERRIDE_MODEL) and the current permission mode from the live process
#   cmdline (or, if absent there, from the footer), and ALWAYS passes both
#   explicitly on relaunch. Refuses rather than guessing if either is
#   unknown. Verifies both against the relaunched pane before ever
#   printing success.
do_restart() {
  local name="$1" override_model="$2"
  acquire_lock "$name"
  guard_before_typing "$name"
  local pane="$AG_PANE" sess="$AG_SESSION" cwd="$AG_CWD"

  if [ -z "$sess" ] || [ -z "$cwd" ]; then
    echo "refuse: $name has an empty session id or cwd on record; refusing restart rather than guessing" >&2
    log restart "$name" "refused-empty-session-or-cwd"
    release_lock "$name"; exit 1
  fi

  # O1 residual (fix round 4): a session id on record with NO transcript
  # file on disk at all (deleted, moved, never written) is a different,
  # harder failure than "file exists but has no assistant turn yet" — the
  # registry-model fallback below exists for the latter, not this. Refuse
  # before touching the pane rather than proceeding to `--resume` a session
  # with nothing to resume.
  if [ "$(has_transcript_file "$sess")" != "1" ]; then
    echo "refuse: $name's transcript file for session $sess does not exist on disk; refusing restart rather than resuming nothing" >&2
    log restart "$name" "refused-missing-transcript-file"
    release_lock "$name"; exit 1
  fi

  local model model_src
  if [ -n "$override_model" ]; then
    model="$override_model"
    model_src="override"
  else
    model=$(transcript_last_model "$sess")
    model_src="transcript"
    if [ -z "$model" ]; then
      # O1 (fix round 3): a transcript with no assistant turn yet (e.g. a
      # brand-new agent, or one spawned with CLAUDE_CODE_CHILD_SESSION set
      # so Claude Code never writes a jsonl at all) always refused here,
      # even though restart itself had already recorded a model in the
      # registry on a previous successful spawn/restart. Fall back to that
      # before giving up — still never silently defaulting to anything the
      # agent hasn't actually run as.
      model=$(registry_get "$name" model)
      model_src="registry-fallback"
    fi
  fi
  if [ -z "$model" ]; then
    echo "refuse: could not determine $name's current model from its transcript or registry; refusing restart (never silently defaulting)" >&2
    log restart "$name" "refused-unknown-model"
    release_lock "$name"; exit 1
  fi

  local pinfo perm_args perm_desc cmdline_mode footer_mode
  perm_args=()
  pinfo=$(hcli pane process-info --pane "$pane" 2>&1)
  if print -r -- "$pinfo" | grep -q 'dangerously-skip-permissions'; then
    perm_args=(--dangerously-skip-permissions)
    perm_desc="skip"
  else
    cmdline_mode=$(print -r -- "$pinfo" | grep -o -- '--permission-mode[": ]*[A-Za-z]*' | head -1 | grep -o '[A-Za-z]*$')
    if [ -n "$cmdline_mode" ]; then
      perm_args=(--permission-mode "$cmdline_mode")
      perm_desc="$cmdline_mode"
    else
      footer_mode=$(footer_permission_mode "$pane")
      if [ "$footer_mode" = "skip" ]; then
        perm_args=(--dangerously-skip-permissions)
        perm_desc="skip"
      elif [ -n "$footer_mode" ]; then
        perm_args=(--permission-mode "$footer_mode")
        perm_desc="$footer_mode"
      fi
    fi
  fi
  if [ -z "$perm_desc" ]; then
    echo "refuse: could not determine $name's current permission mode from its process or footer; refusing restart (never silently defaulting)" >&2
    log restart "$name" "refused-unknown-permission-mode"
    release_lock "$name"; exit 1
  fi

  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would restart $name: pane=$pane session=$sess model=$model permission=$perm_desc"
    log restart "$name" "dry-run"
    release_lock "$name"; return 0
  fi

  hcli agent prompt "$name" "/exit" >/dev/null 2>&1
  local waited=0 shellready=0 dialog=0
  while [ $waited -lt 20 ]; do
    sleep 1; waited=$((waited + 1))
    if [ "$(pane_has_dialog "$pane")" = "1" ]; then dialog=1; break; fi
    if ! foreground_is_claude "$pane"; then shellready=1; break; fi
  done
  if [ "$dialog" = "1" ]; then
    hcli pane send-keys "$pane" esc >/dev/null 2>&1
    echo "restart FAILED for $name: /exit opened a dialog (background work running). Sent Esc and stopped — never let its default action fire." >&2
    log restart "$name" "failed-dialog"
    release_lock "$name"; exit 1
  fi
  if [ "$shellready" != "1" ]; then
    fetch_agents
    local st_now
    st_now=$(agent_field "$name" agent_status)
    if [ "$st_now" = "working" ]; then
      echo "restart FAILED for $name: it started a new turn after our /exit (a race). Aborting without ctrl+c so nothing is interrupted mid-turn." >&2
      log restart "$name" "failed-race-working"
      release_lock "$name"; exit 1
    fi
    hcli pane send-keys "$pane" ctrl+c >/dev/null 2>&1
    sleep 1
    hcli pane send-keys "$pane" ctrl+c >/dev/null 2>&1
    waited=0
    while [ $waited -lt 10 ]; do
      sleep 1; waited=$((waited + 1))
      if [ "$(pane_has_dialog "$pane")" = "1" ]; then dialog=1; break; fi
      if ! foreground_is_claude "$pane"; then shellready=1; break; fi
    done
    if [ "$dialog" = "1" ]; then
      hcli pane send-keys "$pane" esc >/dev/null 2>&1
      echo "restart FAILED for $name: a dialog appeared during the ctrl+c fallback. Sent Esc and stopped." >&2
      log restart "$name" "failed-dialog-fallback"
      release_lock "$name"; exit 1
    fi
  fi
  if [ "$shellready" != "1" ]; then
    echo "restart FAILED for $name: pane $pane is still not at a shell prompt." >&2
    echo "--- pane process-info ---" >&2
    hcli pane process-info --pane "$pane" >&2
    echo "--- pane read (recent-unwrapped) ---" >&2
    hcli pane read "$pane" --source recent-unwrapped --lines 20 >&2
    log restart "$name" "failed-no-shell"
    release_lock "$name"; exit 1
  fi

  # Fix round 5: the pane reaching a bare shell does not mean herdr's own
  # agent registry has dropped the OLD registration for $name yet — CONFIRMED
  # live: `agent start` failed `agent_name_taken` right after this exact
  # shellready check passed, and the agent then vanished from `agent list`
  # entirely moments later, orphaning the pane. Wait for the name to
  # actually clear before ever calling `agent start`.
  local name_wait=0
  while [ $name_wait -lt 30 ]; do
    fetch_agents
    [ "$(agent_field "$name" agent_status)" = "__NOTFOUND__" ] && break
    sleep 1; name_wait=$((name_wait + 1))
  done

  local recovery_cmd="$HERDR ${HFLAGS[*]} agent start $name --kind claude --pane $pane --timeout 120000 -- --resume $sess -n $name --model $model ${perm_args[*]}"
  local startout
  startout=$(hcli agent start "$name" --kind claude --pane "$pane" --timeout 120000 -- --resume "$sess" -n "$name" --model "$model" "${perm_args[@]}" 2>&1)
  if print -r -- "$startout" | grep -q '"error"'; then
    # One retry: the same registry-lag race can still hit on the first
    # attempt even after the wait above (e.g. herdr was slower than 30s,
    # or a second transient error). Never silently give up without saying
    # exactly how to recover the pane by hand.
    sleep 2
    fetch_agents
    startout=$(hcli agent start "$name" --kind claude --pane "$pane" --timeout 120000 -- --resume "$sess" -n "$name" --model "$model" "${perm_args[@]}" 2>&1)
  fi
  echo "$startout"
  if print -r -- "$startout" | grep -q '"error"'; then
    echo "restart FAILED for $name: 'agent start' failed twice (see output above) and the pane is now orphaned at a bare shell, NOT under herdr. Recover it by hand:" >&2
    echo "  $recovery_cmd" >&2
    log restart "$name" "failed-start-twice-orphaned-pane=$pane"
    release_lock "$name"; exit 1
  fi
  fetch_agents
  local newstate newsess
  newstate=$(agent_field "$name" agent_status)
  newsess=$(agent_field "$name" session_id)
  if { [ "$newstate" != "idle" ] && [ "$newstate" != "done" ]; } || [ "$newsess" != "$sess" ]; then
    echo "restart FAILED/UNCONFIRMED for $name: post-start state='$newstate' session='$newsess' (expected idle/done, session $sess)" >&2
    log restart "$name" "failed-state=$newstate-session=$newsess"
    release_lock "$name"; exit 1
  fi

  # VERIFY — never print OK without checking the relaunched pane actually
  # launched with the model and permission mode we asked for.
  #
  # Fix round 5: `restart` ALWAYS relaunches with `--resume`, and a
  # `--resume` launch never prints the "Claude Code vX / <Model> · Claude
  # Max" startup banner at all — that banner is fresh-session-only. Live
  # repro on a throwaway agent: a resume to opus showed the permission
  # footer correctly but literally zero occurrences of "Opus" anywhere in
  # the pane, because there is no banner to find it in. Verify against the
  # relaunched process's own cmdline instead (`pane process-info`, the
  # same source already preferred for permission-mode detection above) —
  # unambiguous and present immediately, resume or not. Keep the old
  # banner/footer text check only as a fallback for a fresh (non-resume)
  # launch or a transient process-info race.
  sleep 1
  local post_pinfo model_word ok_model=0 ok_perm=0
  post_pinfo=$(hcli pane process-info --pane "$pane" 2>&1)
  print -r -- "$post_pinfo" | grep -q -- "--model $model" && ok_model=1
  case "$perm_desc" in
    skip|bypassPermissions) print -r -- "$post_pinfo" | grep -q 'dangerously-skip-permissions' && ok_perm=1 ;;
    *) print -r -- "$post_pinfo" | grep -q -- "--permission-mode $perm_desc" && ok_perm=1 ;;
  esac
  if [ "$ok_model" != "1" ] || [ "$ok_perm" != "1" ]; then
    local banner
    banner=$(hcli pane read "$pane" --source recent-unwrapped --lines 20 2>&1)
    case "$model" in
      haiku) model_word="Haiku" ;;
      sonnet) model_word="Sonnet" ;;
      opus) model_word="Opus" ;;
    esac
    if [ "$ok_model" != "1" ]; then
      print -r -- "$banner" | grep -qi "$model_word" && ok_model=1
    fi
    if [ "$ok_perm" != "1" ]; then
      case "$perm_desc" in
        skip|bypassPermissions) print -r -- "$banner" | grep -qi "bypass" && ok_perm=1 ;;
        auto) print -r -- "$banner" | grep -qi "auto mode" && ok_perm=1 ;;
        manual) print -r -- "$banner" | grep -qi "manual mode" && ok_perm=1 ;;
        plan) print -r -- "$banner" | grep -qi "plan mode" && ok_perm=1 ;;
        acceptEdits) print -r -- "$banner" | grep -qi "accept edits" && ok_perm=1 ;;
        *) ok_perm=1 ;;
      esac
    fi
  fi
  if [ "$ok_model" != "1" ] || [ "$ok_perm" != "1" ]; then
    echo "restart FAILED for $name: relaunched, but could not verify model='$model' (matched=$ok_model) and permission='$perm_desc' (matched=$ok_perm) via process cmdline or pane text. Not reporting success." >&2
    echo "$post_pinfo" >&2
    log restart "$name" "failed-verify model=$model($ok_model) perm=$perm_desc($ok_perm)"
    release_lock "$name"; exit 1
  fi

  echo "restart OK for $name (session $sess preserved, state=$newstate, model=$model VERIFIED [src=$model_src], permission=$perm_desc VERIFIED)"
  registry_set "$name" pane_id "$pane"
  registry_set "$name" session_id "$sess"
  registry_set "$name" model "$model"
  log restart "$name" "ok-session=$sess-state=$newstate-model=$model-src=$model_src-perm=$perm_desc"
  release_lock "$name"
}

# O1 residual (fix round 4): parametrized via HERDR_CTL_TEST_PROJECTS_DIR
# (test-only override, same pattern as HERDR_CTL_TEST_REG) so this exact
# check is regression-testable without touching real ~/.claude/projects.
TRANSCRIPT_PROJECTS_DIR="${HERDR_CTL_TEST_PROJECTS_DIR:-$HOME/.claude/projects}"

has_transcript_file() { # $1=session id -> "1" if a matching jsonl exists on disk, else "0"
  local sess="$1"
  if zsh -c 'setopt nullglob; f=('"$TRANSCRIPT_PROJECTS_DIR"'/*/'"$sess"'.jsonl); (( ${#f} > 0 ))' 2>/dev/null; then
    echo 1
  else
    echo 0
  fi
}

transcript_last_model() { # $1=session id -> short model name or empty
  local sess="$1" file
  file=$(zsh -c 'setopt nullglob; for f in ~/.claude/projects/*/'"$sess"'.jsonl; do print -r -- $f; done' | head -1)
  [ -z "$file" ] && return
  python3 -c '
import json,sys
path=sys.argv[1]
model=None
with open(path, encoding="utf-8", errors="replace") as f:
    for line in f:
        line=line.strip()
        if not line: continue
        try:
            o=json.loads(line)
        except Exception:
            continue
        if o.get("type")=="assistant":
            m=(o.get("message") or {}).get("model")
            if m: model=m
short=""
if model:
    ml=model.lower()
    if "haiku" in ml: short="haiku"
    elif "sonnet" in ml: short="sonnet"
    elif "opus" in ml: short="opus"
print(short)
' "$file"
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
  case "$tail_n" in
    ''|*[!0-9]*) tail_n=40 ;;
  esac
  if [ "$tail_n" -lt 1 ]; then tail_n=1; fi
  if [ "$tail_n" -gt 200 ]; then tail_n=200; fi
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
  # O4 (fix round 3): the extract can contain another agent's private
  # working context (VERDICT-2 B4 residual: was mode 0644, world-readable
  # on this shared-UID machine). Restrict it the moment it exists.
  chmod 600 "$out" 2>/dev/null
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
  acquire_lock "$name"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would spawn $name in $cwd model=$model skip_permissions=$skip"
    log spawn "$name" "dry-run"
    release_lock "$name"; return 0
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
    release_lock "$name"; exit 1
  fi
  sleep 2
  local extra=()
  [ "$skip" = "1" ] && extra+=(--dangerously-skip-permissions)
  # O1 (fix round 3): herdr-ctl.sh itself often runs inside a Claude Code
  # pane (the orchestrator's own session), which sets
  # CLAUDE_CODE_CHILD_SESSION=1 in ITS environment. Left set, the new agent
  # process this spawns inherits it, Claude Code treats it as a child
  # session, and never writes its own transcript jsonl at all — which then
  # makes `restart` permanently refuse for that agent (transcript_last_model
  # has nothing to read, and there is no prior registry model either on a
  # first spawn). Unset it for the process we are about to start.
  unset CLAUDE_CODE_CHILD_SESSION
  local startout
  startout=$(hcli agent start "$name" --kind claude --pane "$pane" -- --model "$model" -n "$name" "${extra[@]}" 2>&1)
  echo "$startout"
  fetch_agents
  local newstate sess
  newstate=$(agent_field "$name" agent_status)
  sess=$(agent_field "$name" session_id)
  if [ "$newstate" = "__NOTFOUND__" ] || [ -z "$newstate" ]; then
    echo "spawn WARNING: $name not visible via 'agent list' yet (may still be at a startup dialog, e.g. workspace-trust)." >&2
    local hint="--session ${SESSION:-default}"
    [ -n "$MACHINE" ] && hint="--machine $MACHINE"
    echo "check with: herdr $hint agent get $name" >&2
    log spawn "$name" "warn-not-visible pane=$pane"
    release_lock "$name"; exit 1
  fi
  registry_set "$name" pane_id "$pane"
  registry_set "$name" cwd "$cwd"
  registry_set "$name" session_id "$sess"
  registry_set "$name" model "$model"
  registry_set "$name" task ""
  echo "spawn OK for $name (pane=$pane session=$sess state=$newstate)"
  log spawn "$name" "pane=$pane-session=$sess-state=$newstate"
  release_lock "$name"
}

# ---------- internal test hooks (not part of the public interface) ----------
# Let regression tests pin the wording/parsing logic deterministically
# without needing a live herdr pane for every case.

cmd__test_registry_set() { registry_set "$1" "$2" "$3"; }
cmd__test_lock_dir_for() { echo "$LOCKS_DIR/$1.lock"; }
cmd__test_busy() { busy_wording_hit "$1"; }
cmd__test_has_transcript_file() { has_transcript_file "$1"; }
cmd__test_model_with_fallback() { # $1=jsonl path (may not exist / no assistant turn) $2=name -> mirrors do_restart's O1 resolution order
  local file="$1" name="$2" model=""
  if [ -n "$file" ] && [ -f "$file" ]; then
    model=$(cmd__test_model_from_file "$file")
  fi
  if [ -z "$model" ]; then
    model=$(registry_get "$name" model)
  fi
  echo "$model"
}
cmd__test_model_in_pinfo() { # $1=raw `pane process-info` JSON text $2=model -> "1"/"0" (fix round 5, O1/model-verify)
  print -r -- "$1" | grep -q -- "--model $2" && echo 1 || echo 0
}
cmd__test_busy_pane_file() { # $1 = path to a file with a full raw multi-line pane dump
  local raw footer
  raw=$(cat "$1")
  footer=$(footer_suffix_only "$raw")
  busy_wording_hit "$footer"
}
cmd__test_permission() { footer_permission_mode_text "$1"; }
cmd__test_dialog() { local low; low=$(print -r -- "$1" | tr '[:upper:]' '[:lower:]'); print -r -- "$low" | grep -qE 'background work is running|will stop when you exit|exit and stop tasks' && echo 1 || echo 0; }
cmd__test_draft_ansi_file() { # $1 = path to a file containing raw ANSI pane text -- shares input_box_has_draft's exact parser (DRAFT_PARSE_PY) so the test can never drift from the live logic.
  python3 -c "$DRAFT_PARSE_PY" "$1"
}
cmd__test_model_from_file() { # $1 = jsonl path (bypasses session lookup, for fixtures)
  python3 -c '
import json,sys
path=sys.argv[1]
model=None
with open(path, encoding="utf-8", errors="replace") as f:
    for line in f:
        line=line.strip()
        if not line: continue
        try: o=json.loads(line)
        except Exception: continue
        if o.get("type")=="assistant":
            m=(o.get("message") or {}).get("model")
            if m: model=m
short=""
if model:
    ml=model.lower()
    if "haiku" in ml: short="haiku"
    elif "sonnet" in ml: short="sonnet"
    elif "opus" in ml: short="opus"
print(short)
' "$1"
}
footer_permission_mode_text() { # same as footer_permission_mode but takes raw text, for tests
  local text="$1" low
  low=$(print -r -- "$text" | tr '[:upper:]' '[:lower:]')
  if print -r -- "$low" | grep -q "bypass"; then echo skip; return; fi
  if print -r -- "$low" | grep -q "auto mode"; then echo auto; return; fi
  if print -r -- "$low" | grep -q "manual mode"; then echo manual; return; fi
  if print -r -- "$low" | grep -q "plan mode"; then echo plan; return; fi
  if print -r -- "$low" | grep -q "accept edits"; then echo acceptEdits; return; fi
  echo ""
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
  _test_busy) cmd__test_busy "$@" ;;
  _test_busy_pane_file) cmd__test_busy_pane_file "$@" ;;
  _test_model_in_pinfo) cmd__test_model_in_pinfo "$@" ;;
  _test_permission) cmd__test_permission "$@" ;;
  _test_dialog) cmd__test_dialog "$@" ;;
  _test_draft_ansi_file) cmd__test_draft_ansi_file "$@" ;;
  _test_model_from_file) cmd__test_model_from_file "$@" ;;
  _test_model_with_fallback) cmd__test_model_with_fallback "$@" ;;
  _test_has_transcript_file) cmd__test_has_transcript_file "$@" ;;
  _test_registry_set) cmd__test_registry_set "$@" ;;
  _test_lock_dir_for) cmd__test_lock_dir_for "$@" ;;
  *)
    echo "usage: herdr-ctl.sh [--session NAME] [--dry-run] <status|send|tag|compact|clear|model|restart|transcript|spawn> ..." >&2
    exit 2
    ;;
esac
