#!/bin/bash
# flip-0111.sh -- flip ONE hospital Mac kiosk's Pulse Presence Chrome extension to build 0.1.1.39 (FLIP_TARGET_VER overrides, e.g. 0.1.1.40).
#
# usage: flip-0111.sh [--check|--dry-run|--census] [--profile "<dir>"] [--all-open-profiles] [--legacy-flip [--skip-uninstall]] <machine_id> <ssh_target> <keychain_svc> [ssh_key]
#
# A version move now runs the REPAIR path by default (fable 6 Oct 21:55: the plain flip left OPD 1 on the old build; --repair moved seven
# profiles in ~30 s each). Without --profile the profile is Local State profile.last_used (else the first profile.last_active_profiles
# entry); the old policy-remove / relaunch / restore / relaunch flow is kept behind --legacy-flip.
#   --check           read-only: prints occupancy, served version, ext_health for the machine; exits 0
#   --dry-run         prints every command full mode would run (password shown as <from keychain>); runs nothing
#   --census          read-only: per profile of the console user, the extension version dirs (empty dirs included) and which are stale
#                     for the target version; no occupancy/served checks, nothing is changed (still needs the Keychain item: root ls)
#   --all-open-profiles  also repair every other profile whose extension dir is older than the target or empty (closed profiles come
#                     back with stale versions). The other profiles go first, the active one last (Chrome ends on it); occupancy is
#                     rechecked before every profile's repair (fail closed: the remaining profiles are left alone, exit 4).
#   --legacy-flip     the old flow (STEP i-vii) instead of the repair
#   --skip-uninstall  (legacy flow only) skip step i (Cardiology: policy already gone)
#   --profile "<dir>" Chrome profile directory (e.g. "Default", "Profile 1"): the profile to repair (or, legacy flow, that STEP iii
#                     and STEP vi start Chrome with as --profile-directory). Must exist on the host.
#   --repair          (the default; kept for old command lines) re-install the extension in ONE profile whose Extensions/<id> dir is empty while Chrome
#                     still records the old version: one root script on the host (guard bootout; managed plist moved aside;
#                     cfprefsd flushed; Chrome restarted on the profile so it uninstalls; plist restored; cfprefsd flushed; Chrome
#                     restarted so it installs fresh; guard bootstrapped). A trap always restores the plist and the guard. Same
#                     occupancy gate as a flip (fail closed). Verifies <profile>/Extensions/<id>/0.1.1.39_0 and an ext heartbeat.
#   ssh_key           default ~/.ssh/id_ecdsa (Dietary/Audiometry: ~/.ssh/opd-bot_ed25519)
#
# Exit codes: 0 ok | 1 usage/unreachable | 2 target version (FLIP_TARGET_VER, default 0.1.1.39) not published | 3 sudo failure (host stopped, no retry)
#             4 occupied or occupancy unknown, skip | 5 presence-guard missing | 6 a step failed | 7 flipped but the target version NOT SEEN
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

TARGET_VER="${FLIP_TARGET_VER:-0.1.1.39}"   # FLIP_TARGET_VER=0.1.1.40 for the 0.1.1.40 rollout; ext-check.mjs reads the same variable
export FLIP_TARGET_VER="$TARGET_VER"
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

usage() { sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; }

MODE=full; SKIP_UNINSTALL=0; PROFILE=""; REPAIR=1; REPAIR_FLAG=0; LEGACY=0; CENSUS=0; ALLOPEN=0; POS=()
while [ $# -gt 0 ]; do
  a="$1"; shift
  case "$a" in
    --check) MODE=check ;;
    --dry-run) MODE=dry ;;
    --skip-uninstall) SKIP_UNINSTALL=1 ;;
    --repair) REPAIR_FLAG=1 ;;
    --legacy-flip) LEGACY=1 ;;
    --census) CENSUS=1 ;;
    --all-open-profiles) ALLOPEN=1 ;;
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
if [ "$LEGACY" = 1 ]; then
  REPAIR=0
  [ "$REPAIR_FLAG" = 0 ] || { echo "--legacy-flip cannot be combined with --repair" >&2; exit 1; }
  [ "$ALLOPEN" = 0 ] && [ "$CENSUS" = 0 ] || { echo "--legacy-flip cannot be combined with --all-open-profiles or --census" >&2; exit 1; }
else
  [ "$SKIP_UNINSTALL" = 0 ] || { echo "--skip-uninstall belongs to the legacy flow: add --legacy-flip" >&2; exit 1; }
fi
if [ "$MODE" = check ]; then
  [ "$REPAIR_FLAG" = 0 ] || { echo "--repair cannot be combined with --check" >&2; exit 1; }
  [ "$CENSUS" = 0 ] && [ "$ALLOPEN" = 0 ] || { echo "--check cannot be combined with --census or --all-open-profiles" >&2; exit 1; }
fi
[ "$CENSUS" = 0 ] || [ "$ALLOPEN" = 0 ] || { echo "--census is read-only: it cannot be combined with --all-open-profiles" >&2; exit 1; }

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

REPAIR_ASIDE=0; GUARD_STOPPED=0; GUARD_BOOTED=0; IN_DIE=0; CHROME_DOWN=0; GUARD_STATE=unknown; CU=""; CUID=""; NO_DIE=0
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
  if [ "$REPAIR_ASIDE" = 1 ]; then
    log "repair aborted: restoring the managed plist and the guard"
    NO_DIE=1
    sudo_sh "$(repair_restore_text)"
    NO_DIE=0
    log "repair restore: $(printf '%s' "$S_OUT" | tr '\n' ' ' | cut -c1-160) (rc=$S_RC)"
    if [ "$S_RC" -eq 0 ] && printf '%s' "$S_OUT" | grep -q 'GUARD=LOADED'; then GUARD_BOOTED=1; GUARD_STATE=y; fi
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
  # a profile's 0.1.0.14* dirs go only when another version dir of the same id is already there; an id dir is never left empty
  other=0
  for v in "\$prof"/Extensions/"\$EXT"/[!.]*; do
    [ -d "\$v" ] || continue
    case "\$v" in */0.1.0.14*) ;; *) other=1 ;; esac
  done
  found=0; removed=0
  for d in "\$prof"/Extensions/"\$EXT"/0.1.0.14*; do
    [ -d "\$d" ] || continue
    found=1
    echo "EXT_DIR \$ROOT/\$d"
    if [ "\$other" = 0 ]; then echo "KEPT_ONLY_VERSION \$ROOT/\$d"; continue; fi
    if [ "\$MODE" = remove ]; then rm -rf -- "\$ROOT/\$d" && removed=1 && echo "REMOVED \$ROOT/\$d"; fi
  done
  if [ "\$MODE" = list ] && [ "\$found" = 1 ] && [ "\$other" = 1 ]; then removed=1; fi
  if [ "\$removed" = 1 ] && [ -d "\$prof/Service Worker" ]; then
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

repair_prelude() { # assignments for the repair/restore root scripts; values are %q-quoted so no profile text can break out
  printf 'CU=%q CUID=%q PROF=%q EXT=%q TV=%q GLABEL=%q GPLIST=%q MP=%q ASIDE_DIR=%q\n' "$CU" "$CUID" "$PROFILE" "$EXT_ID" "$TARGET_VER" "$GUARD_LABEL" "$GUARD_PLIST" "$MANAGED_PLIST" "${REPAIR_ASIDE_DIR:-/var/db/eta-presence-guard}"
}

repair_restore_plist_body() { # put the plist back from the aside copy and flush cfprefsd; idempotent
  cat <<'EOS'
ASIDE="$ASIDE_DIR/com.google.Chrome.plist.repair-aside"
if [ -f "$ASIDE" ]; then
  mkdir -p "$(dirname "$MP")" && mv -f "$ASIDE" "$MP" && echo REPAIR_PLIST_RESTORED=1 || echo REPAIR_PLIST_RESTORED=0
fi
killall cfprefsd 2>/dev/null
sleep 1
EOS
}

repair_restore_guard_body() { # bootstrap the guard if it is not loaded
  cat <<'EOS'
launchctl print "system/$GLABEL" >/dev/null 2>&1 || launchctl bootstrap system "$GPLIST" >/dev/null 2>&1
launchctl print "system/$GLABEL" >/dev/null 2>&1 && echo GUARD=LOADED || echo GUARD=NOT_LOADED
EOS
}

repair_restore_body() { repair_restore_plist_body; repair_restore_guard_body; }

repair_restore_text() { repair_prelude; echo "trap '' PIPE"; repair_restore_body; }

repair_script() { # the ONE root script of --repair mode
  repair_prelude
  cat <<'EOS'
trap '' PIPE   # the ssh channel may drop mid-run: a failed echo must not kill the trap handler
ASIDE="$ASIDE_DIR/com.google.Chrome.plist.repair-aside"
HOMEDIR=$(dscl . -read /Users/$CU NFSHomeDirectory | awk '{print $2}')
case "$HOMEDIR" in /Users/?*) ;; *) echo "REPAIR_ERR=bad_home"; exit 1 ;; esac
PDIR="$HOMEDIR/Library/Application Support/Google/Chrome/$PROF"
EXTD="$PDIR/Extensions/$EXT"
[ -d "$PDIR" ] || { echo "REPAIR_ERR=no_profile"; exit 1; }
chrome_stop() {
  pkill -TERM -x "Google Chrome" 2>/dev/null
  for i in 1 2 3 4 5; do pgrep -x "Google Chrome" >/dev/null || break; sleep 3; done
  pkill -KILL -x "Google Chrome" 2>/dev/null
  sleep 2
}
chrome_start() {
  launchctl asuser "$CUID" sudo -u "$CU" open -a "Google Chrome" --args "--profile-directory=$PROF" "https://pulse.even.in/" >/dev/null 2>&1
}
ext_gone() { [ ! -d "$EXTD" ] || [ -z "$(ls -A "$EXTD" 2>/dev/null | grep -v '^\.')" ]; }
cleanup() {
  trap - EXIT HUP INT TERM
  if [ "$CHROME_DOWN" = 1 ] && ! pgrep -x "Google Chrome" >/dev/null; then chrome_start; fi
EOS
  repair_restore_body | sed 's/^/  /'
  cat <<'EOS'
}
CHROME_DOWN=0
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
# crash recovery: a leftover aside copy from an earlier run goes back first
if [ -f "$ASIDE" ]; then echo REPAIR_STALE_ASIDE=1; mv -f "$ASIDE" "$MP"; fi
launchctl bootout "system/$GLABEL" 2>/dev/null
if launchctl print "system/$GLABEL" >/dev/null 2>&1; then echo REPAIR_ERR=guard_still_loaded; exit 1; fi
echo REPAIR_GUARD_STOPPED=1
mkdir -p "$(dirname "$ASIDE")" && chmod 700 "$(dirname "$ASIDE")"
if [ -f "$MP" ]; then mv -f "$MP" "$ASIDE" || { echo REPAIR_ERR=aside_failed; exit 1; }; fi
killall cfprefsd 2>/dev/null; sleep 2
echo REPAIR_PLIST_ASIDE=1
# phase 1: Chrome without the policy uninstalls the extension from the profile
CHROME_DOWN=1; chrome_stop; chrome_start; CHROME_DOWN=0
i=0; while [ $i -lt 24 ]; do ext_gone && break; sleep 5; i=$((i+1)); done
ext_gone && echo UNINSTALLED=1 || echo UNINSTALLED=0
# phase 2: restore the policy, flush, restart so Chrome installs fresh; the guard stays out until the install wait is over
EOS
  repair_restore_plist_body
  cat <<'EOS'
CHROME_DOWN=1; chrome_stop; chrome_start; CHROME_DOWN=0
i=0; while [ $i -lt 36 ]; do [ -d "$EXTD/${TV}_0" ] && break; sleep 5; i=$((i+1)); done
[ -d "$EXTD/${TV}_0" ] && echo INSTALLED=1 || echo INSTALLED=0
exit 0
EOS
}

# ===========================================================================================================================
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

# ---- helpers shared by --census and --all-open-profiles ----------------------------------------------------------------
census_script() { # read-only: one CENSUS|<profile>|absent|empty|present|<comma-separated version dirs> line per profile dir
  cat <<EOS
HOMEDIR=\$(dscl . -read /Users/$CU NFSHomeDirectory | awk '{print \$2}')
ROOT="\$HOMEDIR/Library/Application Support/Google/Chrome"
for d in "\$ROOT"/Default "\$ROOT"/Profile\ *; do
  [ -d "\$d" ] || continue
  n=\$(basename "\$d"); e="\$d/Extensions/$EXT_ID"
  if [ ! -d "\$e" ]; then echo "CENSUS|\$n|absent|"; continue; fi
  v=""; for x in "\$e"/[!.]*; do [ -e "\$x" ] && v="\$v\${v:+,}\$(basename "\$x")"; done
  if [ -z "\$v" ]; then echo "CENSUS|\$n|empty|"; else echo "CENSUS|\$n|present|\$v"; fi
done
echo CENSUS_DONE
EOS
}

ver_lt() { # ver_lt <a> <b>: dotted-integer a < b (a trailing _N build suffix is ignored; non-numeric parts count as 0)
  local IFS=. i x y; local -a A B
  A=(${1%%_*}); B=(${2%%_*})
  for i in 0 1 2 3; do
    x=${A[i]:-0}; y=${B[i]:-0}
    case "$x$y" in *[!0-9]*) return 1 ;; *) ;; esac
    [ "$x" -lt "$y" ] && return 0
    [ "$x" -gt "$y" ] && return 1
  done
  return 1
}

# census_state <state> <versions-csv>: prints STALE (empty dir, or no version >= target) | CURRENT | NONE (extension dir absent)
census_state() {
  local st="$1" vs="$2" v have_new=0 have_old=0
  [ "$st" = absent ] && { echo NONE; return; }
  [ "$st" = empty ] && { echo STALE; return; }
  # only dotted-numeric version dirs (optional _N suffix) count; anything else (Temp, a stray .crx) is ignored, and a profile left
  # with no version dir is STALE
  for v in ${vs//,/ }; do
    case "$v" in ''|*[!0-9._]*|.*|*..*|_*|*_*_*|*.) continue ;; *) ;; esac
    case "${v%%_*}" in *_*) continue ;; *) ;; esac
    if ver_lt "$v" "$TARGET_VER"; then have_old=1; else have_new=1; fi
  done
  if [ "$have_new" = 1 ]; then echo CURRENT; else echo STALE; fi
}

# ---- --census: read-only, no occupancy or served-version gate -----------------------------------------------------------
if [ "$CENSUS" = 1 ]; then
  log "=== census for target $TARGET_VER: mode=$MODE target=$TARGET svc=$SVC ==="
  if [ "$DRY" = 1 ]; then
    dry_note "ssh ${SSH_OPTS[*]} $TARGET true ; security find-generic-password -a eta-deploy -s $SVC (item must exist)"
    resolve_console
  else
    rssh true 2>/dev/null || die 1 "host unreachable over ssh ($TARGET)"
    security find-generic-password -a eta-deploy -s "$SVC" >/dev/null 2>&1 || die 8 "no keychain item eta-deploy/$SVC"
    resolve_console
  fi
  sudo_sh "$(profile_read_script; census_script)"
  if [ "$DRY" = 1 ]; then dry_note "print per profile: name (* = active), state, version dirs, STALE|CURRENT|NONE against $TARGET_VER"; exit 0; fi
  printf '%s' "$S_OUT" | grep -q 'CENSUS_DONE' || { log "unexpected output: $(printf '%s' "$S_OUT" | tr '\n' ' ' | cut -c1-300)"; die 6 "census script failed"; }
  C_LAST=$(printf '%s\n' "$S_OUT" | sed -n 's/^LAST_USED=//p' | head -1)
  C_ACTIVE=$(printf '%s\n' "$S_OUT" | sed -n 's/^ACTIVE=//p' | head -1 | grep -o '"[^"]*"' | tr -d '"' | tr '\n' ',' | sed 's/,$//')
  echo "census $MID (console $CU) target $TARGET_VER: last_used='${C_LAST:-}' active=[${C_ACTIVE:-}]"
  nstale=0
  while IFS='|' read -r tag name st vs; do
    [ "$tag" = CENSUS ] || continue
    mark=" "; [ "$name" = "$C_LAST" ] && mark="*"
    cs=$(census_state "$st" "$vs")
    [ "$cs" = STALE ] && nstale=$((nstale + 1))
    printf '  %s %-14s %-8s %-40s %s\n' "$mark" "$name" "$st" "${vs:--}" "$cs"
  done <<< "$S_OUT"
  echo "census $MID: $nstale stale profile(s)"
  exit 0
fi

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
  if [ "$REPAIR" = 1 ] && [ -z "$PROFILE" ]; then   # the repair target is the active profile: Local State profile.last_used
    PROFILE="${P_LAST:-${P_ACTIVE%%,*}}"
    case "$PROFILE" in ''|*[!A-Za-z0-9._\ -]*|.|..|..*) echo "profiles on $MID: ${P_DIRS:-none}"; die 11 "GUEST_OR_NO_PROFILE: cannot name the active profile ('$PROFILE'); rerun with --profile \"<dir>\"" ;; esac
    case ",$P_DIRS," in *",$PROFILE,"*) ;; *) echo "profiles on $MID: ${P_DIRS:-none}"; die 11 "GUEST_OR_NO_PROFILE: the active profile '$PROFILE' has no directory on the host" ;; esac
    log "repairing the active profile '$PROFILE' (Local State profile.last_used)"
  fi
fi
[ "$DRY" != 1 ] || [ "$REPAIR" != 1 ] || [ -n "$PROFILE" ] || PROFILE="<last_used from Local State>"

# ---- repair path (default): one root script per profile -----------------------------------------------------------------
repair_one() { # repair_one: repair profile $PROFILE (global); dies on any failure (the die() restore covers the guard and the plist)
  log "REPAIR profile '$PROFILE' on $MID (console $CU)"
  GUARD_STOPPED=1; GUARD_BOOTED=0; GUARD_STATE=n; REPAIR_ASIDE=1
  sudo_sh "$(repair_script)"
  if [ "$DRY" = 1 ]; then return 0; fi
  case "$S_OUT" in *REPAIR_ERR=no_profile*) REPAIR_ASIDE=0; GUARD_STOPPED=0; die 11 "GUEST_OR_NO_PROFILE: --profile '$PROFILE' not found on the host" ;; esac
  if printf '%s' "$S_OUT" | grep -q 'GUARD=LOADED'; then GUARD_BOOTED=1; GUARD_STATE=y; fi
  if printf '%s' "$S_OUT" | grep -q 'REPAIR_PLIST_RESTORED=0'; then die 6 "repair: could not restore the managed plist (aside copy kept in /var/db/eta-presence-guard)"; fi
  [ "$S_RC" -eq 0 ] || { log "repair output: $(printf '%s' "$S_OUT" | tr '\n' ' ' | cut -c1-300)"; die 6 "repair root script failed (rc=$S_RC)"; }
  log "repair output ($PROFILE): $(printf '%s' "$S_OUT" | grep -E '^(REPAIR_|UNINSTALLED|INSTALLED|GUARD)' | tr '\n' ' ')"
  [ "$GUARD_BOOTED" = 1 ] || die 6 "repair: guard not loaded after the script"
  REPAIR_ASIDE=0
  printf '%s' "$S_OUT" | grep -q 'INSTALLED=1' || die 7 "repair: $PROFILE/Extensions/$EXT_ID/${TARGET_VER}_0 not present"
  return 0
}

if [ "$REPAIR" = 1 ]; then
  ACTIVE_PROFILE="$PROFILE"; ORDER=(); REPAIRED=""
  FLIP_START_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  log "repair started $FLIP_START_ISO (UTC)"
  if [ "$ALLOPEN" = 1 ]; then
    # every other profile whose extension dir is stale for the target (empty dir, or no version >= target) goes first, the active one last
    sudo_sh "$(census_script)"
    if [ "$DRY" = 1 ]; then
      dry_note "parse CENSUS lines: every profile except the active one whose extension dir is STALE (empty, or no version >= $TARGET_VER) is repaired first, each after an occupancy recheck; the active profile last"
    else
      printf '%s' "$S_OUT" | grep -q 'CENSUS_DONE' || { log "unexpected output: $(printf '%s' "$S_OUT" | tr '\n' ' ' | cut -c1-300)"; die 6 "census script failed"; }
      while IFS='|' read -r tag name st vs; do
        [ "$tag" = CENSUS ] || continue
        [ "$name" = "$ACTIVE_PROFILE" ] && continue
        [ "$(census_state "$st" "$vs")" = STALE ] && ORDER+=("$name")
      done <<< "$S_OUT"
      log "census: stale profiles to repair besides '$ACTIVE_PROFILE': ${ORDER[*]:-none}"
    fi
  fi
  ORDER+=("$ACTIVE_PROFILE")
  n=0
  for PROFILE in "${ORDER[@]}"; do
    if [ "$n" -gt 0 ] && [ "$DRY" != 1 ]; then
      get_occupancy
      if [ "$OCC_STATE" != none ]; then
        log "repaired so far: ${REPAIRED:-nothing}; not repaired (left alone): ${ORDER[*]:$n}"
        die 4 "occupied or unknown before the Chrome relaunch for profile '$PROFILE' ($OCC_TEXT); stopped, remaining profiles untouched"
      fi
      log "occupancy rechecked before profile '$PROFILE': $OCC_TEXT"
    fi
    repair_one
    REPAIRED="${REPAIRED:+$REPAIRED, }$PROFILE"
    n=$((n + 1))
  done
  PROFILE="$ACTIVE_PROFILE"
  if [ "$DRY" = 1 ]; then
    dry_note "verify per profile: <profile>/Extensions/$EXT_ID/${TARGET_VER}_0 exists (INSTALLED=1); then ext-check.mjs shows a ${TARGET_VER} heartbeat after $FLIP_START_ISO (poll 30 s, up to 3 min)"
    exit 0
  fi
  START=$SECONDS; SEEN_AT=""
  while :; do
    get_ext "$FLIP_START_ISO"
    log "ext latest: $EXT_LATEST"
    if [ -n "$EXT_TARGET_AT" ]; then SEEN_AT="$EXT_TARGET_AT"; break; fi
    [ $((SECONDS - START)) -ge 180 ] && break
    sleep 30
  done
  if [ -n "$SEEN_AT" ]; then log "RESULT $MID | repair $REPAIRED | $TARGET_VER installed and heartbeat seen at $SEEN_AT | guard running y"; exit 0; fi
  log "RESULT $MID | repair $REPAIRED | $TARGET_VER installed, heartbeat NOT SEEN | guard running y"
  exit 7
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
  KEPT=$(printf '%s' "$S_OUT" | grep -E '^KEPT_ONLY_VERSION ' | tr '\n' ';')
  [ -z "$KEPT" ] || log "REPORT kept (only version in its id dir, would have left it empty): $KEPT -- fix with --repair --profile \"<dir>\""
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
