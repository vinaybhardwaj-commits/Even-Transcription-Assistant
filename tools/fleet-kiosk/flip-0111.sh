#!/bin/bash
# flip-0111.sh -- flip ONE hospital Mac kiosk's Pulse Presence Chrome extension to build 0.1.1.39.
#
# usage: flip-0111.sh [--check|--dry-run] [--skip-uninstall] [--profile "<dir>"] <machine_id> <ssh_target> <keychain_svc> [ssh_key]
#   --check           read-only: prints occupancy, served version, ext_health for the machine; exits 0
#   --dry-run         prints every command full mode would run (password shown as <from keychain>); runs nothing
#   --skip-uninstall  skip step i only (Cardiology: policy already gone)
#   --profile "<dir>" Chrome profile directory (e.g. "Default", "Profile 1") that STEP iii and STEP vi start Chrome with, as
#                     --profile-directory. Must exist on the host. Without it Chrome is started as before (no flag).
#   ssh_key           default ~/.ssh/id_ecdsa (Dietary/Audiometry: ~/.ssh/opd-bot_ed25519)
#
# Exit codes: 0 ok | 1 usage/unreachable | 2 0.1.1.39 not published | 3 sudo failure (host stopped, no retry)
#             4 occupied or occupancy unknown, skip | 5 presence-guard missing | 6 a step failed | 7 flipped but 0.1.1.39 NOT SEEN
#             8 no keychain item | 9 no usable console user | 10 GUARD LEFT STOPPED (restore failed; fix by hand)
#             11 GUEST_OR_NO_PROFILE (nothing changed; the host's profile list is printed)
# Profile check (before anything is changed, after the guard and occupancy checks): the console user's Chrome "Local State" is read
# for exactly two keys, profile.last_used and profile.last_active_profiles (plutil -extract on the host as root; no python on the
# kiosk). If last_used is "Guest Profile", or no active profile exists (no active list and no last_used), the run aborts with exit 11
# and prints the profile directories found; rerun with --profile "<dir>" to name the profile to use. With --profile the named
# directory must exist on the host (else exit 11) and the Guest/no-profile abort does not apply, because Chrome is told which
# profile to open.
# Every abort prints a RESULT line with the reason. SIGHUP/INT/TERM abort the host the same way (guard restored).
#
# Secrets: the sudo password is read from the Air login Keychain (service <keychain_svc>, account eta-deploy) and goes
# to the host ONLY on ssh stdin of `sudo -S`. It is never in argv, never echoed, never logged.
# Occupancy and extension presence are LOCAL read-only Neon reads on the Air: DATABASE_URL=$(cat ~/.claude/secrets/eta_database_url)
# goes into the node process environment only (never argv, never printed): occ-check.mjs (via ~/pulse-watch/occupancy.mjs) and
# ext-check.mjs, both next to this script. The served version is public and read with `ssh mini curl` (the Air's TLS store fails).

set -u
set -o pipefail

TARGET_VER="0.1.1.39"
EXT_ID="choegfgddhpljibnolbcljnlfhfpimbh"
GUARD_LABEL="com.eta.presence-guard"
GUARD_PLIST="/Library/LaunchDaemons/com.eta.presence-guard.plist"
GUARD_LOG="/var/log/eta-presence-guard.log"
MANAGED_PLIST="/Library/Managed Preferences/com.google.Chrome.plist"
BASE_URL="https://www.evenscribe.app"
LOGFILE="$HOME/fleet-flip-05oct.log"
DBURL_FILE="${ETA_DB_URL_FILE:-$HOME/.claude/secrets/eta_database_url}"
HELPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# machine id of OPD 1 (step iv runs only there) comes from the local config, not the repo: $FLEET_KIOSK_CONFIG or ~/.config/eta-fleet-kiosk/config.sh sets OPD1_ID
[ -r "${FLEET_KIOSK_CONFIG:-$HOME/.config/eta-fleet-kiosk/config.sh}" ] && . "${FLEET_KIOSK_CONFIG:-$HOME/.config/eta-fleet-kiosk/config.sh}"
OPD1_ID="${OPD1_ID:-}"

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }

MODE=full; SKIP_UNINSTALL=0; PROFILE=""; POS=()
while [ $# -gt 0 ]; do
  a="$1"; shift
  case "$a" in
    --check) MODE=check ;;
    --dry-run) MODE=dry ;;
    --skip-uninstall) SKIP_UNINSTALL=1 ;;
    --profile) [ $# -gt 0 ] || { echo "--profile needs a directory name" >&2; usage >&2; exit 1; }; PROFILE="$1"; shift ;;
    --profile=*) PROFILE="${a#--profile=}" ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "unknown option: $a" >&2; usage >&2; exit 1 ;;
    *) POS+=("$a") ;;
  esac
done
if [ "${#POS[@]}" -lt 3 ] || [ "${#POS[@]}" -gt 4 ]; then usage >&2; exit 1; fi
MID="${POS[0]}"; TARGET="${POS[1]}"; SVC="${POS[2]}"; KEY="${POS[3]:-$HOME/.ssh/id_ecdsa}"
KEY="${KEY/#\~/$HOME}"
DRY=0; [ "$MODE" = dry ] && DRY=1

# A profile directory is ONE path component of letters, digits, space, dot, underscore, hyphen (no quote, slash or "..").
case "$PROFILE" in *[!A-Za-z0-9._\ -]*|.|..|..*) echo "bad --profile (letters, digits, space . _ - only, one directory name)" >&2; exit 1 ;; esac
case "$MID" in ''|*[!A-Za-z0-9._-]*) echo "bad machine_id" >&2; exit 1 ;; esac
case "$SVC" in ''|*[!A-Za-z0-9._-]*) echo "bad keychain_svc" >&2; exit 1 ;; esac
case "$TARGET" in *@*) ;; *) echo "ssh_target must be user@host" >&2; exit 1 ;; esac
case "$TARGET" in *[!A-Za-z0-9._@:-]*) echo "bad ssh_target" >&2; exit 1 ;; esac
[ "$MODE" = full ] && [ ! -r "$KEY" ] && { echo "ssh key not readable: $KEY" >&2; exit 1; }

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8 -o IdentitiesOnly=yes -i "$KEY")
MINI_OPTS=(-o BatchMode=yes -o ConnectTimeout=8)
EXPECT_POLICY="$EXT_ID;$BASE_URL/ext/$MID/update.xml"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() {
  local line; line="$(ts) [$MID] $*"
  echo "$line"
  [ "$MODE" = full ] && echo "$line" >> "$LOGFILE"
  return 0
}

GUARD_STOPPED=0; GUARD_BOOTED=0; IN_DIE=0; CHROME_DOWN=0; GUARD_STATE=unknown; CU=""; CUID=""; NO_DIE=0
die() { # die <code> <message>: log, restore the guard (and Chrome) if we left them down, print RESULT, exit
  local code=$1; shift
  local reason="$*"
  if [ "$IN_DIE" = 1 ]; then exit "$code"; fi
  IN_DIE=1
  log "ABORT (exit $code): $reason"
  if [ "$CHROME_DOWN" = 1 ] && [ -n "$CU" ] && [ -n "$CUID" ]; then
    NO_DIE=1
    sudo_sh "launchctl asuser $CUID sudo -u $CU open -a \"Google Chrome\"; echo open_rc=\$?"
    log "Chrome relaunch on abort: $(printf '%s' "$S_OUT" | tr '\n' ' ' | cut -c1-120) (rc=$S_RC)"
    NO_DIE=0
  fi
  if [ "$GUARD_STOPPED" = 1 ] && [ "$GUARD_BOOTED" = 0 ]; then
    log "restoring presence-guard (bootstrap) so the host is not left without it"
    NO_DIE=1
    sudo_sh "launchctl bootstrap system $GUARD_PLIST >/dev/null 2>&1; launchctl print system/$GUARD_LABEL >/dev/null 2>&1 && echo GUARD=LOADED || echo GUARD=NOT_LOADED"
    NO_DIE=0
    if [ "$S_RC" -eq 0 ] && printf '%s' "$S_OUT" | grep -q 'GUARD=LOADED'; then
      GUARD_STATE=y; log "presence-guard restored"
    else
      GUARD_STATE=n
      log "GUARD LEFT STOPPED on $MID -- bootstrap it by hand: sudo launchctl bootstrap system $GUARD_PLIST"
      echo "!!!!! GUARD LEFT STOPPED on $MID !!!!!" >&2
      log "RESULT $MID | $TARGET_VER NOT SEEN (aborted: $reason; restore failed) | guard running n"
      exit 10
    fi
  fi
  log "RESULT $MID | $TARGET_VER NOT SEEN (aborted: $reason) | guard running $GUARD_STATE"
  exit "$code"
}
trap 'die 130 "interrupted (signal)"' HUP INT TERM

rssh() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }

# ---- evenscribe.app reads, all via the Mini -------------------------------------------------------------------------
mini_curl_public() { ssh "${MINI_OPTS[@]}" mini "curl -sS -m 20 '$1'"; }
read -r -d '' PY_XMLVER <<'PY'
import os, re
s = os.environ.get("D", "")
m = re.search(r"<updatecheck\b[^>]*\bversion=['\"]([^'\"]+)['\"]", s)
print(m.group(1) if m else "")
PY

SERVED_VER=""
get_served() { # sets SERVED_VER ("" on failure)
  local xml; xml=$(mini_curl_public "$BASE_URL/ext/$MID/update.xml") || { SERVED_VER=""; return; }
  SERVED_VER=$(D="$xml" python3 -c "$PY_XMLVER")
}

db_node() { # db_node <helper.mjs> [args]: DATABASE_URL only in the node environment
  [ -r "$DBURL_FILE" ] || return 9
  DATABASE_URL="$(cat "$DBURL_FILE")" node "$HELPER_DIR/$1" "${@:2}"
}

OCC_STATE=unknown; OCC_TEXT=""
get_occupancy() { # sets OCC_STATE none|present|unknown and OCC_TEXT; any helper failure = unknown (callers fail closed)
  local out rc
  out=$(db_node occ-check.mjs "$MID" 2>/dev/null); rc=$?
  if [ "$rc" -ne 0 ]; then OCC_STATE=unknown; OCC_TEXT="UNKNOWN (occ-check failed rc=$rc)"; return; fi
  case "$out" in
    nobody)     OCC_STATE=none;    OCC_TEXT="nobody present" ;;
    present*)   OCC_STATE=present; OCC_TEXT="$out" ;;
    ambiguous)  OCC_STATE=present; OCC_TEXT="ambiguous (two doctors, treated as present)" ;;
    *)          OCC_STATE=unknown; OCC_TEXT="UNKNOWN (unexpected output)" ;;
  esac
}

EXT_LATEST=""; EXT_TARGET_AT=""
get_ext() { # get_ext [since_iso]: sets EXT_LATEST "<received_at> <ext_version>" and EXT_TARGET_AT (received_at of a 0.1.1.39 row after since, else "")
  local out rc
  EXT_LATEST="UNKNOWN"; EXT_TARGET_AT=""
  out=$(db_node ext-check.mjs "$MID" ${1:+"$1"} 2>/dev/null); rc=$?
  [ "$rc" -eq 0 ] || { EXT_LATEST="UNKNOWN (ext-check failed rc=$rc)"; return; }
  EXT_LATEST=$(printf '%s\n' "$out" | sed -n 's/^latest //p' | head -1)
  EXT_TARGET_AT=$(printf '%s\n' "$out" | sed -n 's/^target \([^ ]*\) .*/\1/p' | head -1)
}

# ---- --check ------------------------------------------------------------------------------------------------------
if [ "$MODE" = check ]; then
  get_occupancy;   echo "occupancy $MID: $OCC_TEXT"
  get_served;      echo "served $MID: ${SERVED_VER:-UNKNOWN}"
  get_ext;         echo "ext_health $MID: $EXT_LATEST"
  exit 0
fi

# ---- sudo / ssh wrappers for full + dry-run ---------------------------------------------------------------------------
S_OUT=""; S_RC=0
sudo_sh() { # sudo_sh <script text>: one root bash on the host; password via ssh stdin only. Sets S_OUT (stdout+stderr), S_RC.
  local script="$1" b64 out rc
  if [ "$DRY" = 1 ]; then
    echo "[dry-run] $(ts) [$MID] root shell on $TARGET:"
    echo "    <from keychain: -a eta-deploy -s $SVC> | ssh ${SSH_OPTS[*]} $TARGET 'sudo -S -k -p \"\" /bin/bash -c <script>'"
    printf '%s\n' "$script" | sed 's/^/        | /'
    S_OUT=""; S_RC=0; return 0
  fi
  b64=$(printf '%s' "$script" | base64 | tr -d '\n')
  out=$(security find-generic-password -a eta-deploy -s "$SVC" -w 2>/dev/null \
        | rssh "sudo -S -k -p '' /bin/bash -c \"\$(printf %s '$b64' | /usr/bin/base64 -D)\"" 2>&1); rc=$?
  S_OUT="$out"; S_RC=$rc
  if [ "$rc" -eq 255 ]; then [ "$NO_DIE" = 1 ] && { S_RC=255; return 0; }; die 1 "ssh to $TARGET failed"; fi
  if printf '%s' "$out" | grep -qiE 'incorrect password|try again|a password is required|no tty present|not in the sudoers|may not run sudo'; then
    [ "$NO_DIE" = 1 ] && { S_RC=3; return 0; }
    die 3 "sudo failed on $TARGET (service $SVC); stopping this host, no retry"
  fi
  return 0
}

dry_note() { [ "$DRY" = 1 ] && echo "[dry-run] $(ts) [$MID] $*"; return 0; }

expect() { # expect <ERE> <exit code> <message>: S_OUT must match (no-op in dry-run)
  [ "$DRY" = 1 ] && return 0
  printf '%s' "$S_OUT" | grep -qE "$1" || { log "unexpected output: $(printf '%s' "$S_OUT" | tr '\n' ' ' | cut -c1-300)"; die "$2" "$3"; }
}

wait_remote() { # wait_remote <seconds>: LOCAL sleep on the Air in <=45 s slices, with a reachability log between slices
  local left=$1 n
  if [ "$DRY" = 1 ]; then
    echo "[dry-run] $(ts) [$MID] wait ${left}s as local 'sleep' on the Air (<=45 s slices)"; return 0
  fi
  while [ "$left" -gt 0 ]; do
    n=$left; [ "$n" -gt 45 ] && n=45
    sleep "$n"
    left=$((left - n)); log "waited ${n}s (${left}s left)"
  done
}

resolve_console() { # sets CU CUID from the host's console owner
  local out
  if [ "$DRY" = 1 ]; then
    echo "[dry-run] $(ts) [$MID] ssh ${SSH_OPTS[*]} $TARGET 'u=\$(stat -f %Su /dev/console); echo \$u; id -u \"\$u\"'"
    CU="<console_user>"; CUID="<uid>"; return 0
  fi
  out=$(rssh 'u=$(stat -f %Su /dev/console); echo "$u"; id -u "$u"' 2>/dev/null) || die 1 "cannot read console user"
  CU=$(printf '%s\n' "$out" | sed -n 1p); CUID=$(printf '%s\n' "$out" | sed -n 2p)
  case "$CU" in ''|root|loginwindow|_mbsetupuser|*[!A-Za-z0-9._-]*) die 9 "no usable console user ('$CU')" ;; esac
  case "$CUID" in ''|*[!0-9]*) die 9 "bad console uid ('$CUID')" ;; esac
}

chrome_profile_args() { # text appended to an `open -a "Google Chrome" [url]` command: empty, or the profile for a fresh launch
  [ -n "$PROFILE" ] && printf " --args '--profile-directory=%s'" "$PROFILE"
  return 0
}

chrome_relaunch_script() { # $1 = optional URL
  cat <<EOS
killall "Google Chrome" 2>/dev/null
sleep 3
launchctl asuser $CUID sudo -u $CU open -a "Google Chrome" ${1:-}$(chrome_profile_args)
rc=\$?
echo "open_rc=\$rc"
exit \$rc
EOS
}

purge_script() { # $1 = list|remove  (OPD 1: stale 0.1.0.14* extension dirs + Service Worker dir of each profile that had one)
  cat <<EOS
CU=$CU
HOMEDIR=\$(dscl . -read /Users/\$CU NFSHomeDirectory | awk '{print \$2}')
case "\$HOMEDIR" in /Users/?*) ;; *) echo "bad home dir: \$HOMEDIR"; exit 1 ;; esac
/usr/bin/sudo -H -u "\$CU" /usr/bin/env MODE=$1 EXT=$EXT_ID ROOT="\$HOMEDIR/Library/Application Support/Google/Chrome" /bin/bash -s <<'INNER'
cd "\$ROOT" 2>/dev/null || { echo "no chrome dir"; exit 0; }
for prof in */; do
  prof=\${prof%/}
  found=0
  for d in "\$prof"/Extensions/"\$EXT"/0.1.0.14*; do
    [ -d "\$d" ] || continue
    found=1
    echo "EXT_DIR \$ROOT/\$d"
    if [ "\$MODE" = remove ]; then rm -rf -- "\$ROOT/\$d" && echo "REMOVED \$ROOT/\$d"; fi
  done
  if [ "\$found" = 1 ] && [ -d "\$prof/Service Worker" ]; then
    echo "SW_DIR \$ROOT/\$prof/Service Worker"
    if [ "\$MODE" = remove ]; then rm -rf -- "\$ROOT/\$prof/Service Worker" && echo "REMOVED \$ROOT/\$prof/Service Worker"; fi
  fi
done
echo "DONE \$MODE"
INNER
EOS
}

guard_poll_script() {
  cat <<EOS
n=\$(grep -c ' rewrite reason=' "$GUARD_LOG" 2>/dev/null)
f=\$(grep -c ' rewrite_failed ' "$GUARD_LOG" 2>/dev/null)
has=0
/usr/libexec/PlistBuddy -c 'Print :ExtensionInstallForcelist' "$MANAGED_PLIST" 2>/dev/null | grep -qF "$EXPECT_POLICY" && has=1
echo "RW=\${n:-0} FAIL=\${f:-0} HAS=\$has"
EOS
}

ext_dirs_script() {
  cat <<EOS
HOMEDIR=\$(dscl . -read /Users/$CU NFSHomeDirectory | awk '{print \$2}')
for d in "\$HOMEDIR"/Library/Application\ Support/Google/Chrome/*/Extensions/$EXT_ID/*/; do
  [ -d "\$d" ] && echo "EXTVER \$(basename "\$(dirname "\$(dirname "\$(dirname "\$d")")")")/\$(basename "\$d")"
done
echo "EXTVER_DONE"
EOS
}

# ===========================================================================================================================
log "=== flip to $TARGET_VER: mode=$MODE target=$TARGET svc=$SVC key=$KEY skip_uninstall=$SKIP_UNINSTALL ==="

# ---- step 0: pre-checks -------------------------------------------------------------------------------------------------
log "STEP 0 pre-checks"
if [ "$DRY" = 1 ]; then
  dry_note "ssh ${MINI_OPTS[*]} mini \"curl -sS -m 20 '$BASE_URL/ext/$MID/update.xml'\"   -> parse <updatecheck version>; must be $TARGET_VER else exit 2 'not published'"
  dry_note "DATABASE_URL=\$(cat $DBURL_FILE) node $HELPER_DIR/occ-check.mjs $MID   -> must print 'nobody' else exit 4 'occupied, skip' (any error = occupied)"
  dry_note "ssh ${SSH_OPTS[*]} $TARGET true   (reachability) ; security find-generic-password -a eta-deploy -s $SVC   (item must exist, password not read here)"
  resolve_console
else
  rssh true 2>/dev/null || die 1 "host unreachable over ssh ($TARGET)"
  get_served
  if [ "$SERVED_VER" != "$TARGET_VER" ]; then die 2 "not published: served version is '${SERVED_VER:-unreadable}', need $TARGET_VER"; fi
  log "served version $SERVED_VER ok"
  get_occupancy
  case "$OCC_STATE" in
    none)    log "occupancy ok: $OCC_TEXT" ;;
    present) die 4 "occupied, skip ($OCC_TEXT)" ;;
    *)       die 4 "occupied, skip -- occupancy unknown, failing closed ($OCC_TEXT)" ;;
  esac
  security find-generic-password -a eta-deploy -s "$SVC" >/dev/null 2>&1 || die 8 "no keychain item eta-deploy/$SVC"
  resolve_console
  log "console user $CU (uid $CUID)"
fi

# ---- step 1: guard installed ----------------------------------------------------------------------------------------------
log "STEP 1 verify presence-guard is installed"
sudo_sh "launchctl print system/$GUARD_LABEL >/dev/null 2>&1; echo PRINT_RC=\$?; [ -f $GUARD_PLIST ] && echo PLIST=yes || echo PLIST=no"
expect 'PRINT_RC=0' 5 "guard missing (system/$GUARD_LABEL not loaded)"
expect 'PLIST=yes' 5 "guard missing ($GUARD_PLIST absent)"
GUARD_STATE=y
log "guard daemon loaded and plist present"

if [ "$DRY" != 1 ]; then
  get_occupancy
  [ "$OCC_STATE" = none ] || die 4 "occupied, skip -- recheck before first change ($OCC_TEXT)"
  log "occupancy rechecked before first change: $OCC_TEXT"
fi

# ---- profile check: nothing has been changed yet (guard still running), so an abort here needs no restore ---------------
profile_read_script() { # prints LAST_USED=<raw>, ACTIVE=<json>, PROFDIR=<name> lines; reads exactly two Local State keys
  cat <<EOS
HOMEDIR=\$(dscl . -read /Users/$CU NFSHomeDirectory | awk '{print \$2}')
ROOT="\$HOMEDIR/Library/Application Support/Google/Chrome"
LS="\$ROOT/Local State"
if [ -f "\$LS" ]; then
  echo "LAST_USED=\$(/usr/bin/plutil -extract profile.last_used raw -o - "\$LS" 2>/dev/null)"
  echo "ACTIVE=\$(/usr/bin/plutil -extract profile.last_active_profiles json -o - "\$LS" 2>/dev/null | tr -d '\\n')"
else
  echo "NO_LOCAL_STATE=1"
fi
for d in "\$ROOT"/Default "\$ROOT"/Profile\ * "\$ROOT"/Guest\ Profile; do [ -d "\$d" ] && echo "PROFDIR=\$(basename "\$d")"; done
echo PROFILE_READ_DONE
EOS
}

log "STEP pre-i read the active Chrome profile of $CU (Local State: profile.last_used, profile.last_active_profiles)"
if [ "$DRY" = 1 ]; then
  sudo_sh "$(profile_read_script)"
  dry_note "parse LAST_USED/ACTIVE; abort exit 11 GUEST_OR_NO_PROFILE if last_used is 'Guest Profile' or no active profile (active list, else last_used) exists; with --profile the dir must exist on the host"
  dry_note "Chrome will be started with:${PROFILE:+ --profile-directory=$PROFILE}${PROFILE:- no --profile-directory (flag not given)}"
else
  sudo_sh "$(profile_read_script)"
  printf '%s' "$S_OUT" | grep -q 'PROFILE_READ_DONE' || { log "unexpected output: $(printf '%s' "$S_OUT" | tr '\n' ' ' | cut -c1-300)"; die 6 "could not read the Chrome profile state on the host"; }
  P_LAST=$(printf '%s\n' "$S_OUT" | sed -n 's/^LAST_USED=//p' | head -1)
  case "$P_LAST" in null|"<null>"|"(null)") P_LAST="" ;; esac
  P_ACTIVE=$(printf '%s\n' "$S_OUT" | sed -n 's/^ACTIVE=//p' | head -1 | grep -o '"[^"]*"' | tr -d '"' | tr '\n' ',' | sed 's/,$//')
  P_DIRS=$(printf '%s\n' "$S_OUT" | sed -n 's/^PROFDIR=//p' | tr '\n' ',' | sed 's/,$//')
  P_HAVE_ACTIVE="$P_ACTIVE"; [ -n "$P_HAVE_ACTIVE" ] || P_HAVE_ACTIVE="$P_LAST"
  log "chrome profiles on $MID: last_used='${P_LAST:-}' active=[${P_ACTIVE:-}] directories=[${P_DIRS:-}]"
  if [ -n "$PROFILE" ]; then
    case ",$P_DIRS," in *",$PROFILE,"*) log "using --profile '$PROFILE' (present on the host)" ;;
      *) echo "profiles on $MID: ${P_DIRS:-none}"; die 11 "GUEST_OR_NO_PROFILE: --profile '$PROFILE' not found on the host (directories: ${P_DIRS:-none})" ;; esac
  elif [ "$P_LAST" = "Guest Profile" ]; then
    echo "profiles on $MID: ${P_DIRS:-none}"; die 11 "GUEST_OR_NO_PROFILE: Chrome's last used profile is 'Guest Profile' (active=[${P_ACTIVE:-}] directories=[${P_DIRS:-none}]); rerun with --profile \"<dir>\""
  elif [ -z "$P_HAVE_ACTIVE" ]; then
    echo "profiles on $MID: ${P_DIRS:-none}"; die 11 "GUEST_OR_NO_PROFILE: no active Chrome profile (directories=[${P_DIRS:-none}]); rerun with --profile \"<dir>\""
  fi
fi

FLIP_START_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
log "flip started $FLIP_START_ISO (UTC)"

# ---- step ii: stop the guard FIRST --------------------------------------------------------------------------------------
log "STEP ii stop presence-guard (before uninstall, so it cannot re-add the policy)"
sudo_sh "launchctl bootout system/$GUARD_LABEL; echo bootout_rc=\$?; launchctl print system/$GUARD_LABEL >/dev/null 2>&1 && echo STATE=STILL_LOADED || echo STATE=UNLOADED"
expect 'STATE=UNLOADED' 6 "guard still loaded after bootout"
GUARD_STOPPED=1; GUARD_STATE=n
log "guard stopped"

# ---- step i: uninstall --------------------------------------------------------------------------------------------------
if [ "$SKIP_UNINSTALL" = 1 ]; then
  log "STEP i skipped (--skip-uninstall)"
else
  log "STEP i remove ExtensionInstallForcelist, eta-presence dir, kill cfprefsd"
  sudo_sh "P='$MANAGED_PLIST'
if [ -f \"\$P\" ]; then
  out=\$(/usr/libexec/PlistBuddy -c 'Delete :ExtensionInstallForcelist' \"\$P\" 2>&1); rc=\$?
  if [ \$rc -eq 0 ]; then echo POLICY=deleted
  else case \"\$out\" in *'Does Not Exist'*) echo POLICY=already_absent ;; *) echo POLICY=FAILED; echo \"\$out\" ;; esac; fi
else echo POLICY=no_plist; fi
rm -rf '/Library/Application Support/eta-presence'; echo RM_RC=\$?
killall cfprefsd 2>/dev/null; true"
  expect 'POLICY=(deleted|already_absent|no_plist)' 6 "could not delete ExtensionInstallForcelist"
  expect 'RM_RC=0' 6 "rm of /Library/Application Support/eta-presence failed"
  [ "$DRY" = 1 ] || log "uninstall step done ($(printf %s "$S_OUT" | grep -o "POLICY=[a-z_]*" | head -1))"
fi

# ---- step iii: relaunch Chrome as console user -------------------------------------------------------------------------
log "STEP iii relaunch Chrome as $CU (uid $CUID)"
sudo_sh "$(chrome_relaunch_script)"
expect 'open_rc=0' 6 "Chrome relaunch failed"
log "Chrome relaunched; waiting 60 s"
wait_remote 60

# ---- step iv: OPD 1 only -----------------------------------------------------------------------------------------------
if [ "$MID" = "$OPD1_ID" ]; then
  log "STEP iv (OPD 1) stop Chrome, purge stale 0.1.0.14* extension dirs + Service Worker"
  if [ "$DRY" = 1 ]; then
    dry_note "recheck occupancy (occ-check.mjs) right before the second Chrome kill; occupied/unknown -> abort step iv: restore guard, relaunch Chrome, exit 4"
  else
    CHROME_DOWN=1   # an abort from here on relaunches Chrome (harmless if it is still up)
    get_occupancy
    [ "$OCC_STATE" = none ] || die 4 "occupied, skip -- recheck before the OPD 1 Chrome kill ($OCC_TEXT)"
    log "occupancy rechecked before the OPD 1 Chrome kill: $OCC_TEXT"
  fi
  sudo_sh 'killall "Google Chrome" 2>/dev/null
i=0; while pgrep -x "Google Chrome" >/dev/null && [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done
if pgrep -x "Google Chrome" >/dev/null; then echo CHROME=RUNNING; else echo CHROME=STOPPED; fi'
  expect 'CHROME=STOPPED' 6 "Chrome still running, refusing to touch profile data"
  sudo_sh "$(purge_script list)"
  expect 'DONE list' 6 "listing stale extension dirs failed"
  log "WILL REMOVE: $(printf '%s' "$S_OUT" | grep -E '^(EXT_DIR|SW_DIR) ' | tr '\n' ';')"
  sudo_sh "$(purge_script remove)"
  expect 'DONE remove' 6 "removing stale extension dirs failed"
  log "removed: $(printf '%s' "$S_OUT" | grep -E '^REMOVED ' | tr '\n' ';')"
else
  dry_note "STEP iv skipped: machine is not $OPD1_ID"
fi

# ---- step v: bootstrap the guard, wait for rewrite -------------------------------------------------------------------
log "STEP v bootstrap presence-guard and wait up to 75 s for a rewrite"
sudo_sh "$(guard_poll_script)"
BASE_RW=$(printf '%s' "$S_OUT" | sed -n 's/.*RW=\([0-9][0-9]*\).*/\1/p' | head -1); BASE_RW=${BASE_RW:-0}
BASE_FAIL=$(printf '%s' "$S_OUT" | sed -n 's/.*FAIL=\([0-9][0-9]*\).*/\1/p' | head -1); BASE_FAIL=${BASE_FAIL:-0}
[ "$DRY" = 1 ] && { BASE_RW="<n>"; BASE_FAIL="<n>"; }
sudo_sh "launchctl bootstrap system $GUARD_PLIST; echo bootstrap_rc=\$?"
expect 'bootstrap_rc=0' 6 "guard bootstrap failed"
GUARD_BOOTED=1; GUARD_STATE=y
log "guard bootstrapped (baseline rewrite lines: $BASE_RW)"
if [ "$DRY" = 1 ]; then
  dry_note "poll every 5 s up to 75 s: root shell counting ' rewrite reason=' lines in $GUARD_LOG (> baseline) and PlistBuddy Print :ExtensionInstallForcelist containing '$EXPECT_POLICY'; timeout -> exit 6"
  sudo_sh "$(guard_poll_script)"
else
  START=$SECONDS; OK=0
  while [ $((SECONDS - START)) -lt 75 ]; do
    sleep 5
    sudo_sh "$(guard_poll_script)"
    RW=$(printf '%s' "$S_OUT" | sed -n 's/.*RW=\([0-9][0-9]*\).*/\1/p' | head -1); RW=${RW:-0}
    FL=$(printf '%s' "$S_OUT" | sed -n 's/.*FAIL=\([0-9][0-9]*\).*/\1/p' | head -1); FL=${FL:-0}
    HAS=$(printf '%s' "$S_OUT" | sed -n 's/.*HAS=\([01]\).*/\1/p' | head -1)
    if [ "$FL" -gt "$BASE_FAIL" ]; then die 6 "guard logged rewrite_failed"; fi
    if [ "$RW" -gt "$BASE_RW" ] && [ "${HAS:-0}" = 1 ]; then OK=1; break; fi
  done
  [ "$OK" = 1 ] || die 6 "no guard rewrite + policy within 75 s (rewrites $RW vs baseline $BASE_RW, policy_present=${HAS:-?})"
  log "guard rewrote the policy ($((RW - BASE_RW)) new rewrite line(s)); managed plist carries $EXPECT_POLICY"
fi

# ---- step vi: relaunch Chrome at Pulse -----------------------------------------------------------------------------------
log "STEP vi RESTART Chrome (needed to load the restored policy) at https://pulse.even.in/ as $CU"
sudo_sh "pkill -TERM -x \"Google Chrome\"; for i in 1 2 3 4 5; do pgrep -x \"Google Chrome\" >/dev/null || break; sleep 3; done; pkill -KILL -x \"Google Chrome\" 2>/dev/null; sleep 2; launchctl asuser $CUID sudo -u $CU open -a \"Google Chrome\" \"https://pulse.even.in/\"$(chrome_profile_args); echo open_rc=\$?"
expect 'open_rc=0' 6 "opening Chrome at pulse.even.in failed"
CHROME_DOWN=0

# ---- step vii: poll ext_health every 30 s up to 3 min ------------------------------------------------------------------
log "STEP vii poll Neon every 30 s for up to 3 min (success: ext row with ext_version $TARGET_VER received after $FLIP_START_ISO)"
SEEN_AT=""
if [ "$DRY" = 1 ]; then
  dry_note "poll (up to 7 times, 30 s apart): DATABASE_URL=\$(cat $DBURL_FILE) node $HELPER_DIR/ext-check.mjs $MID <flip_start_iso> -> success = ext row (source='ext') with payload ext_version $TARGET_VER received after flip start"
  sudo_sh "$(ext_dirs_script)"
  dry_note "guard running check: root shell 'launchctl print system/$GUARD_LABEL'"
  dry_note "final line: $MID | $TARGET_VER seen at <time> or NOT SEEN | guard running y/n"
  exit 0
fi
START=$SECONDS
while :; do
  get_ext "$FLIP_START_ISO"
  log "ext latest: $EXT_LATEST"
  if [ -n "$EXT_TARGET_AT" ]; then SEEN_AT="$EXT_TARGET_AT"; break; fi
  [ $((SECONDS - START)) -ge 180 ] && break
  sleep 30
done
sudo_sh "$(ext_dirs_script)"
log "extension version dirs on host: $(printf '%s' "$S_OUT" | grep '^EXTVER ' | sed 's/^EXTVER //' | tr '\n' ' ')"
sudo_sh "launchctl print system/$GUARD_LABEL >/dev/null 2>&1; echo GUARD_RC=\$?"
GUARD_RUN=n; printf '%s' "$S_OUT" | grep -q 'GUARD_RC=0' && GUARD_RUN=y
if [ -n "$SEEN_AT" ]; then
  log "RESULT $MID | $TARGET_VER seen at $SEEN_AT | guard running $GUARD_RUN"
  exit 0
fi
log "RESULT $MID | $TARGET_VER NOT SEEN | guard running $GUARD_RUN"
exit 7
