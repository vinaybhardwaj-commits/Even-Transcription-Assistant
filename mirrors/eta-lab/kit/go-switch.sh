#!/bin/bash
# go-switch.sh v4 (herdr-kit, FABLE 438 + 442 + 443/444/447) -- move one OpenCode pane
# from the Zen route (opencode/<model>) onto the OpenCode Go subscription
# (opencode-go/<model>). Fable 447 rules the shape after two proven failure modes:
#
#   PROVEN (Fable 443/444 + herdr-kit pilot #3633): a TUI relaunched with -s RESUMES the
#   session's old provider; the in-TUI picker can move the footer but post-switch turns
#   write no message rows and bill nothing. -s resume NEVER takes Go.
#   PROVEN (Fable 447): a pane launched without OPENCODE_CONFIG loads only the global
#   config (Zen provider only); `-m opencode-go/<m>` then fails to resolve and OpenCode
#   SILENTLY falls back to a free model (big-pickle, cost $0) -- the free-model incident.
#   PROVEN (Fable 447): opencode-go/deepseek-v4-pro FAILS from this account ("requires
#   Global regions" -- not ZDR-clean). Checkers move to opencode-go/kimi-k3.
#
# THE ONLY SHAPE THAT WORKS (Fable 447, verified at message level):
#   FRESH-session launch with the OPENCODE_CONFIG env prefix inside the pane's shell:
#     herdr pane run <pane> "OPENCODE_CONFIG=<pane-config> opencode -m opencode-go/<brand>"
#   then re-bind the agent name (herdr agent rename), then verify by DATABASE EVIDENCE:
#   the first message of the new session must have providerID=opencode-go and
#   modelID=<brand> in opencode.db. The footer marker is checked too but is NEVER
#   sufficient (herdr-kit pilot #3633: footer said Go while turns wrote no rows).
#
# Per pane: (1) idle gate unless --stopped; (2) edit ONLY ~/oc/<name>/opencode.jsonc
# (model -> opencode-go/<brand>, ADD provider opencode-go with the SAME apiKey file;
# .bak-goswitch backup); (3) quit the TUI and prove it quit; (4) fresh relaunch via
# herdr pane run with the env prefix; (5) rename to re-bind; (6) PONG prompt; (7) db
# verify providerID/modelID; (8) log one line. On any failure after the TUI quit: kill
# the Go instance and RESTORE the pane on Zen with -s <old sid> (context returns; Zen
# resume re-pins Zen which is exactly right for a restore). Only an unrecoverable pane
# exits 1 (STOP RUN, page Fable).
#
# No security-relevant file is read or written: no authorized_keys, no ~/.ssh, no env
# dumps, no secret files. Config files are parsed with python3 json; a file that fails
# to parse is SKIPPED, never rewritten blind. Session ids, pane ids and model ids are
# not credentials.
#
# PHI guard (coded, eta-refuter #3619 + Fable 447/449): the ONLY Go targets are the
# ZDR-reviewed ids in map_brand; REFUSE_PANES holds pane names Fable bars from Go,
# hard-refused.
#
# Usage:
#   go-switch.sh --host mini|box|c3 --pane <name> [--stopped] [--apply] [--max-wait S]
#   go-switch.sh --host mini|box|c3 --all [--apply]   (checkers run last; herdr-kit's
#                                                     own Mini pane is never auto-touched)
#   go-switch.sh --host mini|box|c3 --plan           (dry-run list only)
#
# Exit codes: 0 = switched or cleanly deferred/skipped; 1 = pane DOWN and unrestorable
# (STOP RUN, page Fable); 2 = skipped/refused; 3 = bad usage.
#
# bash 3.2 (Mini) safe: no assoc arrays, no mapfile.
set -u

HOST="mini"
PANE=""
STOPPED=0
APPLY=0
ALL=0
MAX_WAIT=900
LOG="$HOME/oc/go-switch.log"

BOX_MACHINE="c33e904116170d7a433e283bad3200c8"
C3_MACHINE="85baa2e0f8428b0b03a3e8606f826e43"
BOX_SSH="e2e-lab-ts"
C3_SSH="e2e-ci"
CHECKERS=" eta-refuter eta-refuter-2 vj-refuter "
REFUSE_PANES=" "
CHECKER_MODEL="deepseek-v4-pro"   # default; --checker-model overrides (449 same-family exception)

usage() { grep '^#' "$0" | sed -n '2,55p'; exit 3; }

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --pane) PANE="$2"; shift 2 ;;
    --stopped) STOPPED=1; shift ;;
    --apply) APPLY=1; shift ;;
    --all) ALL=1; shift ;;
    --plan) ALL=1; shift ;;
    --max-wait) MAX_WAIT="$2"; shift 2 ;;
    --checker-model) CHECKER_MODEL="$2"; shift 2 ;;
    --help|-h) usage ;;
    *) echo "unknown argument: $1" >&2; exit 3 ;;
  esac
done

case "$HOST" in
  mini) MACHINE_ARG=""; REMOTE=""; OC_HOME="$HOME" ;;
  box)  MACHINE_ARG="--machine $BOX_MACHINE"; REMOTE="$BOX_SSH"; OC_HOME="/home/eta" ;;
  c3)   MACHINE_ARG="--machine $C3_MACHINE"; REMOTE="$C3_SSH"; OC_HOME="/home/eta" ;;
  *) echo "--host must be mini|box|c3" >&2; exit 3 ;;
esac
DB_PATH="$OC_HOME/.local/share/opencode/opencode.db"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG"; }
die() { log "FAIL $*"; exit 1; }

h() { herdr $MACHINE_ARG "$@"; }

config_path() { # name -> absolute path of the pane's opencode.jsonc
  case "$HOST" in
    mini) printf '%s/oc/%s/opencode.jsonc' "$HOME" "$1" ;;
    *)    printf '%s/oc/%s/opencode.jsonc' "$OC_HOME" "$1" ;;
  esac
}

read_config() { # path -> "model\napiKeyfile"
  if [ -n "$REMOTE" ]; then
    ssh -o BatchMode=yes -o ConnectTimeout=20 "$REMOTE" \
      "python3 -c 'import json;d=json.load(open(\"$1\"));m=d.get(\"model\") or \"\";k=(d.get(\"provider\",{}).get(\"opencode\",{}) or {}).get(\"options\",{}).get(\"apiKey\",{});print(m);print(k.get(\"file\",\"\"))'"
  else
    python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));m=d.get("model") or "";k=(d.get("provider",{}).get("opencode",{}) or {}).get("options",{}).get("apiKey",{});print(m);print(k.get("file",""))' "$1"
  fi
}

write_config() { # path brand keyfile
  local py
  py=$(cat <<PYEOF
import json, shutil, os, sys
path, gobrand, keyfile = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(path))
d["model"] = "opencode-go/" + gobrand
prov = d.setdefault("provider", {})
cur = prov.get("opencode") or {}
opts = dict((cur.get("options") or {}))
if keyfile:
    opts["apiKey"] = {"file": keyfile}
prov["opencode-go"] = {"options": opts}
tmp = path + ".tmp-goswitch"
with open(tmp, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
with open(tmp) as f:
    json.load(f)
shutil.copy2(path, path + ".bak-goswitch")
os.replace(tmp, path)
print("written")
PYEOF
)
  if [ -n "$REMOTE" ]; then
    printf '%s\n' "$py" | ssh -o BatchMode=yes -o ConnectTimeout=20 "$REMOTE" "python3 - '$1' '$2' '$3'"
  else
    printf '%s\n' "$py" | python3 - "$1" "$2" "$3"
  fi
}

# Go target mapping (Fable 449, superseding 447's checker line). Returns the Go brand:
# all 8 ZDR-reviewed ids map 1:1; CHECKERS (any *-refuter pane) default to
# deepseek-v4-pro; kimi-k3 is RESERVED for Fable and PHI/security/production-deploy
# checks (a checker keeps kimi-k3 only via --checker-model, e.g. while checking a
# DeepSeek-family builder: never the same family as the builder). 30 Sep is a
# RE-CONFIRM date, not a known expiry (449) -- no date refusal in code.
map_brand() { # pane_name zen_brand -> go_brand (stdout), rc!=0 = refuse
  local name="$1" brand="$2"
  # checker match covers numbered names (eta-refuter-2) per eta-refuter #3657
  case "$name" in
    *-refuter|*-refuter-[0-9]*|*-refuter-[0-9]*-*|*-refuter-[0-9]*[a-z]*)
      case "$brand" in
        deepseek-*) printf 'deepseek-v4-pro'; return 0 ;;   # already the checker family
        glm-5.3|glm-5.3-flash|qwen3.8-flash|minimax-m3|kimi-k3|kimi-k2.7-code)
          printf '%s' "$CHECKER_MODEL"; return 0 ;;
      esac
      return 1 ;;
  esac
  case "$brand" in
    glm-5.3|glm-5.3-flash|qwen3.8-flash|deepseek-v4-pro|deepseek-v4.1-flash|minimax-m3|kimi-k3|kimi-k2.7-code) printf '%s' "$brand" ;;
    *) return 1 ;;
  esac
}

valid_name() { printf '%s' "$1" | grep -qE '^[A-Za-z0-9_.-]+$'; }

inventory() { # NAME|pane_id|status|sid for live opencode agents
  h agent list 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for a in d.get("result", {}).get("agents", []):
    if a.get("agent") != "opencode":
        continue
    sid = (a.get("agent_session") or {}).get("value", "")
    print("%s|%s|%s|%s" % (a["name"], a.get("pane_id", ""), a.get("agent_status", "?"), sid))
'
}

pane_bound_name() { # pane_id -> the name bound to that pane (may be empty)
  h agent list 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for a in d.get("result", {}).get("agents", []):
    if a.get("pane_id") == sys.argv[1] and a.get("agent") == "opencode":
        print(a.get("name") or "")
        break
' "$1"
}

pane_has_agent() { [ -n "$(pane_bound_name "$1")" ]; }

# Stopped-pane table (FABLE 442): name|pane_id|old-sid -- used for pane ids and for the
# Zen RESTORE (-s old-sid). Captured from herdr-kit's dry-run of 26 Sep ~12:39Z.
STOPPED_TABLE="yoga-drain|w3:p2|ses_f27eda619ffeeYiGJKLSvvJkCJ
lab-mover|w6:p2|ses_f27e26227ffe6Q7rFa7V1KwLv6
split-speaker|w8:p2|ses_f27eb2a2effe0tgxKN0uGcsI5E
lx|w9:p2|ses_f26e572d9ffel32xmgBNAd7SUe
surg-deid|wG:p2|ses_f23b6c80cffe8yDtQSm3zcBxgR
surg-page|wH:p2|ses_f27eb3680ffeBIkrRpaSTiaeE7
join-shard|wJ:p2|ses_f27eb3177ffezTo8sFj1PHdjMx
hist-miner|wK:p2|ses_f27ef4e02ffeeGhayqQEo7c4N1
hist-bulk|wM:p3|ses_f23b3aea7ffeHQEENmzD7hMV5v
tunnel-ops|wN:p2|ses_f27eb6f61ffe4od3D4N4SN019H
mb-rx|wQ:p2|ses_f27f0391fffe5ICMpsLB8a9Zng
mb-ot|wR:p2|ses_f27f23a3effe72XSlS2fS2LJ6i
mb-ipd|wS:p2|ses_f27f0ae17ffeRniKz8hRmYXRkq
vj-data|wT:p2|ses_f23b78bb7ffewD75MYNqmxPI4F
vj-arms|wV:p2|ses_f27e5fe56ffeibeyLtTKKBM1rS
vj-link|wX:p2|ses_f27e68153ffextA12kkOmzMElr
diar-lab|w4:p2|ses_f27e11e98ffedHMfGyVllcWuov"

stopped_lookup() { # name -> "pane_id old_sid"
  printf '%s\n' "$STOPPED_TABLE" | grep "^$1|" | head -1 | awk -F'|' '{print $2, $3}'
}

# last ASSISTANT message provider/model for a session, from opencode.db (read-only);
# role filter per eta-refuter #3657 minor (a user-only latest row must not cause a rollback)
db_last_msg() { # session_id -> "providerID modelID" (may be empty)
  local q="SELECT json_extract(data,'\$.providerID')||' '||json_extract(data,'\$.modelID') FROM message WHERE session_id='$1' AND json_extract(data,'\$.role')='assistant' ORDER BY time_created DESC LIMIT 1;"
  if [ -n "$REMOTE" ]; then
    ssh -o BatchMode=yes -o ConnectTimeout=20 "$REMOTE" "sqlite3 $DB_PATH \"$q\" 2>/dev/null" | head -1
  else
    sqlite3 "$DB_PATH" "$q" 2>/dev/null | head -1
  fi
}

quit_tui() { # name -> 0 if the agent record is gone within 3 tries
  local tries=0
  h agent send-keys "$1" ctrl+c ctrl+c >/dev/null 2>&1
  while [ "$tries" -lt 3 ]; do
    sleep 2
    pane_has_agent "$2" || return 0
    h agent send-keys "$1" ctrl+c ctrl+c >/dev/null 2>&1
    tries=$((tries + 1))
  done
  return 1
}

restore_zen() { # name pane old_model old_sid -> best-effort Zen restore
  local name="$1" pane="$2" old_model="$3" old_sid="$4"
  local cpath
  cpath=$(config_path "$name")
  h pane run "$pane" "OPENCODE_CONFIG=$cpath opencode -m $old_model -s $old_sid" >/dev/null 2>&1
  sleep 8
  if ! pane_has_agent "$pane"; then
    log "RESTORE-DETECT-WAIT $host_name $name: herdr has not detected the zen relaunch yet"
    sleep 7
  fi
  h agent rename "$pane" "$name" >/dev/null 2>&1
  local screen
  screen=$(h agent read "$name" 2>/dev/null | tr -d '\r')
  if printf '%s' "$screen" | grep -qF "OpenCode Zen"; then
    log "OK-RESTORED $host_name $name: back on $old_model with -s resume (context returned)"
    return 0
  fi
  log "RESTORE-UNVERIFIED $host_name $name: zen relaunch sent but the Zen marker is not on screen -- CHECK THE PANE"
  return 1
}

switch_one() {
  local name="$1"
  if ! valid_name "$name"; then log "SKIP $host_name $name: invalid name characters"; return 2; fi

  local info cur_pane cur_status cur_sid
  info=$(inventory | grep "^${name}|" | head -1)
  if [ -z "$info" ]; then
    if [ "$STOPPED" = 1 ]; then
      local lu
      lu=$(stopped_lookup "$name")
      if [ -z "$lu" ]; then log "SKIP $host_name $name: stopped but not in the captured table"; return 2; fi
      cur_pane=$(printf '%s' "$lu" | cut -d' ' -f1)
      cur_sid=$(printf '%s' "$lu" | cut -d' ' -f2)
      cur_status="stopped"
    else
      log "SKIP $host_name $name: not in herdr agent list"; return 2
    fi
  else
    cur_pane=$(printf '%s' "$info" | cut -d'|' -f2)
    cur_status=$(printf '%s' "$info" | cut -d'|' -f3)
    cur_sid=$(printf '%s' "$info" | cut -d'|' -f4)
  fi

  case "$REFUSE_PANES" in *" $name "*)
    log "REFUSE $host_name $name: on Fable's never-on-Go list"; return 2 ;;
  esac

  # (1) idle gate unless --stopped
  if [ "$STOPPED" != 1 ] && [ "$cur_status" = "working" ]; then
    if [ "$APPLY" = 1 ]; then
      log "WAIT $host_name $name: working, waiting up to ${MAX_WAIT}s"
      h agent wait "$name" --until idle --until done --timeout $((MAX_WAIT * 1000)) >/dev/null 2>&1
      info=$(inventory | grep "^${name}|" | head -1)
      cur_status=$(printf '%s' "$info" | cut -d'|' -f3)
      if [ "$cur_status" != "idle" ] && [ "$cur_status" != "done" ]; then
        log "DEFER $host_name $name: still $cur_status after ${MAX_WAIT}s"; return 0
      fi
    else
      log "PLAN $host_name $name: (busy now; apply will wait ${MAX_WAIT}s)"
    fi
  fi

  # (2) config read + mapping + PHI guard
  local cpath model keyfile brand
  cpath=$(config_path "$name")
  model=$(read_config "$cpath" 2>/dev/null | sed -n '1p')
  keyfile=$(read_config "$cpath" 2>/dev/null | sed -n '2p')
  if [ -z "$model" ]; then log "SKIP $host_name $name: no parseable opencode.jsonc at $cpath"; return 2; fi
  case "$model" in
    opencode-go/*) log "SKIP $host_name $name: already on $model"; return 0 ;;
    opencode/*) brand=${model#opencode/} ;;
    *) log "SKIP $host_name $name: model '$model' is not opencode/<brand>"; return 2 ;;
  esac
  local gobrand
  if ! gobrand=$(map_brand "$name" "$brand"); then
    log "REFUSE $host_name $name: $brand has no Go mapping -- Fable names the replacement"
    return 2
  fi

  if [ "$APPLY" != 1 ]; then
    log "PLAN $host_name $name: $model -> opencode-go/$gobrand (FRESH session) | pane=$cur_pane status=$cur_status | restore-sid=${cur_sid:-(none)}"
    return 0
  fi

  # (3) config write
  log "DO $host_name $name: config -> opencode-go/$gobrand"
  if ! write_config "$cpath" "$gobrand" "$keyfile" >/dev/null 2>&1; then
    log "DEFER $host_name $name: config write failed (pane untouched)"; return 0
  fi

  # (4) quit + prove quit (unless --stopped: pane already at a shell)
  if [ "$STOPPED" != 1 ]; then
    if ! quit_tui "$name" "$cur_pane"; then
      log "DEFER $host_name $name: TUI did not quit after ctrl+c x2 (config already switched; rerun --apply later to relaunch)"
      return 0
    fi
  fi

  # (5) FRESH relaunch with the env prefix (447's only proven shape)
  h pane run "$cur_pane" "OPENCODE_CONFIG=$cpath opencode -m opencode-go/$gobrand" >/dev/null 2>&1
  sleep 10
  if ! pane_has_agent "$cur_pane"; then
    sleep 8
    pane_has_agent "$cur_pane" || { restore_zen "$name" "$cur_pane" "$model" "$cur_sid" || die "$host_name $name is DOWN (go start undetected AND zen restore unverified)"; return 1; }
  fi
  h agent rename "$cur_pane" "$name" >/dev/null 2>&1

  # (6) first turn: PONG
  if ! h agent prompt "$name" "Reply with the single word PONG and nothing else." --wait --until done --until idle >/dev/null 2>&1; then
    sleep 5
  fi
  sleep 8

  # (7) db verify: providerID + modelID of the FIRST message of the FRESH session
  local newsid row
  newsid=$(inventory | grep "^${name}|" | head -1 | cut -d'|' -f4)
  if [ -z "$newsid" ]; then
    log "VERIFY-FAIL $host_name $name: fresh session id not found after relaunch"
    restore_zen "$name" "$cur_pane" "$model" "$cur_sid" || die "$host_name $name is DOWN (verify failed AND zen restore unverified)"
    return 1
  fi
  row=$(db_last_msg "$newsid")
  if [ "$row" = "opencode-go $gobrand" ]; then
    :
  else
    log "VERIFY-FAIL $host_name $name: db last message is '$row', expected 'opencode-go $gobrand' (session $newsid)"
    restore_zen "$name" "$cur_pane" "$model" "$cur_sid" || die "$host_name $name is DOWN (verify failed AND zen restore unverified)"
    return 1
  fi

  # secondary marker check (never sufficient on its own)
  local screen
  screen=$(h agent read "$name" 2>/dev/null | tr -d '\r')
  local marker="ok"
  printf '%s' "$screen" | grep -qF "OpenCode Go" || marker="marker-missing"

  # (8) log
  log "OK $host_name $name: opencode-go/$gobrand db-verified (session $newsid) $marker (was $model; fresh session; old session $cur_sid stays resumable on Zen)"
  return 0
}

host_name="$HOST"

if [ "$ALL" = 1 ]; then
  # checkers strictly last; never auto-touch herdr-kit's own Mini pane
  rest=""
  for p in $(inventory | cut -d'|' -f1); do
    if [ "$HOST" = "mini" ] && [ "$p" = "herdr-kit" ]; then
      log "SKIP mini herdr-kit: self-pane -- switches itself last, manually"
      continue
    fi
    case "$CHECKERS" in *" $p "*) continue ;; esac
    rest="$rest $p"
  done
  for p in $rest; do switch_one "$p"; done
  for p in $(inventory | cut -d'|' -f1); do
    case "$CHECKERS" in *" $p "*) switch_one "$p" ;; esac
  done
  log "DONE all-panes host=$HOST apply=$APPLY"
  exit 0
fi

[ -n "$PANE" ] || usage
switch_one "$PANE"
rc=$?
log "DONE pane=$PANE host=$HOST apply=$APPLY rc=$rc"
exit $rc
