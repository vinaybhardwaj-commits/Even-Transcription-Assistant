#!/bin/bash
# kh-rollout.sh -- install a kiosk-health package onto a list of kiosks from the Air, one host at a time.
#
# usage: kh-rollout.sh --pkg DIR --hosts FILE [--token-from-mini] [--first-install] [--dry-run]
#   --pkg DIR          package: DIR/build/kiosk-health, DIR/install.sh, DIR/launchd/
#   --hosts FILE       one host per line, blank lines and #comments ignored:
#                        machine_id ssh_target keychain_svc room_id install_id console_user [ssh_key]
#                      a host with any field that starts with TODO is SKIPPED and reported (fable fills those in)
#   --token-from-mini  read ~/oc/eta-kiosk-health/.ingest-token over `ssh mini` and pipe it to the host into a 0600 temp file
#                      (stdin only: never in argv, never printed, never in a shell variable); deleted after the install
#   --first-install    install.sh --force-config --machine ID --room-id R --install-id I --console-user U --post true
#                      --watchdog on --audio-ladder off --reboot-rung off [--token-file F]
#                      (default = update only: plain install.sh, which keeps the host's config.json)
#   --dry-run          print the plan for every host; no ssh, no keychain, no Neon
#
# Per host: reachability (2 tries, 5 min apart, else skip), stage the package in a 0700 dir under /tmp, install.sh under sudo
# (password from the Air login Keychain, service <keychain_svc>, account eta-deploy, on ssh stdin of `sudo -S -k -p ''` only),
# then verify: launchd shows the daemon running, the installed binary's Mach-O LC_UUID equals the package's, and a heartbeat row for the
# machine lands in Neon kiosk_health_events within 120 s (hb-check.mjs; DATABASE_URL read from ~/.claude/secrets/eta_database_url
# into the node environment only). The first sudo failure stops THAT host; there is no retry and no other password is tried.
# Never touches Chrome, the recorder, pmset or the presence guard: the only thing run as root is the package's install.sh and
# read-only checks of the kiosk-health daemon.
#
# Log: ~/fleet-kh-rollout-<YYYY-MM-DD>.log. Final table: machine | installed uuid | running | first heartbeat | result.
# Exit: 0 every host OK | 1 usage | 6 at least one host skipped or failed.
# Why LC_UUID and not sha256: install.sh ad-hoc re-signs the installed binary (codesign --force -s -), so its bytes and sha256 never equal
# the package's. The LC_UUID (load command 0x1b) survives. The installed binary (0755, readable without sudo) is copied with plain
# `ssh <target> cat` into a 0600 temp file on the Air and parsed by macho-uuid.mjs (thin arm64 only; a fat binary fails clearly). Nothing
# like otool, dwarfdump, xcrun or python3 runs on a kiosk. The installed sha256 is still logged, as information only.
# Heartbeat window (F29): it opens when install.sh has returned 0 on the host (Air clock, +1 s), so a heartbeat the OLD daemon sent
# before the install can never satisfy the check; the 120 s run from that moment. The heartbeat event carries no pid or binary
# sha, so the post-install timestamp is the only match key.
# Cleanup (F30): a trap on EXIT INT TERM HUP removes the host's staging dir (which holds the token file), best effort over ssh with
# a 10 s limit. No token is ever written on the Air, so there is no local token file to remove.
# Test knobs (env): KH_REACH_RETRY_SECS (default 300), KH_HB_POLL_SECS (10), KH_HB_WAIT_SECS (120), KH_ROLLOUT_LOG.
set -u
set -o pipefail

LABEL="com.evenscribe.kiosk-health"
LIBEXEC_BIN="/usr/local/libexec/eta-kiosk-health/kiosk-health"
MINI_TOKEN_PATH='~/oc/eta-kiosk-health/.ingest-token'
DBURL_FILE="${ETA_DB_URL_FILE:-$HOME/.claude/secrets/eta_database_url}"
HELPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
REACH_RETRY="${KH_REACH_RETRY_SECS:-300}"; HB_POLL="${KH_HB_POLL_SECS:-10}"; HB_WAIT="${KH_HB_WAIT_SECS:-120}"
LOGFILE="${KH_ROLLOUT_LOG:-$HOME/fleet-kh-rollout-$(date +%Y-%m-%d).log}"
MINI_OPTS=(-o BatchMode=yes -o ConnectTimeout=8)

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; }
fail_usage() { echo "kh-rollout.sh: $*" >&2; usage >&2; exit 1; }

PKG=""; HOSTS=""; TOKEN_MINI=0; FIRST=0; DRY=0
while [ $# -gt 0 ]; do
  a="$1"; shift
  case "$a" in
    --pkg) [ $# -gt 0 ] || fail_usage "--pkg needs a directory"; PKG="$1"; shift ;;
    --hosts) [ $# -gt 0 ] || fail_usage "--hosts needs a file"; HOSTS="$1"; shift ;;
    --token-from-mini) TOKEN_MINI=1 ;;
    --first-install) FIRST=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail_usage "unknown option: $a" ;;
  esac
done
[ -n "$PKG" ] || fail_usage "--pkg is required"
[ -n "$HOSTS" ] || fail_usage "--hosts is required"
[ -d "$PKG" ] || fail_usage "package dir not found: $PKG"
[ -r "$HOSTS" ] || fail_usage "hosts file not readable: $HOSTS"
PKG="$(cd "$PKG" && pwd)"
[ -f "$PKG/build/kiosk-health" ] || fail_usage "missing $PKG/build/kiosk-health"
[ -f "$PKG/install.sh" ] || fail_usage "missing $PKG/install.sh"
[ -f "$PKG/launchd/$LABEL.plist" ] || fail_usage "missing $PKG/launchd/$LABEL.plist"
PKG_SHA="$(shasum -a 256 "$PKG/build/kiosk-health" | awk '{print $1}')"
command -v node >/dev/null 2>&1 || fail_usage "node is required (macho-uuid.mjs)"
PKG_UUID="$(node "$HELPER_DIR/macho-uuid.mjs" "$PKG/build/kiosk-health" 2>&1)" || fail_usage "package binary: ${PKG_UUID#error: }"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# with_timeout <seconds> <command...>: run, kill after <seconds> (macOS has no timeout(1)). Returns the command's status.
with_timeout() {
  local secs=$1 p w rc; shift
  "$@" & p=$!
  ( sleep "$secs"; kill -TERM "$p" 2>/dev/null ) & w=$!
  wait "$p" 2>/dev/null; rc=$?
  pkill -P "$w" 2>/dev/null; kill "$w" 2>/dev/null; wait "$w" 2>/dev/null
  return "$rc"
}
CUR=""
log() {
  local line; line="$(ts) [${CUR:--}] $*"
  echo "$line"
  [ "$DRY" = 1 ] || echo "$line" >> "$LOGFILE"
  return 0
}

safe() { case "$1" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac; return 0; }

# ---- parse the hosts file (all validation before the first host is touched) ----------------------------------------------
H_ID=(); H_TARGET=(); H_SVC=(); H_ROOM=(); H_INST=(); H_USER=(); H_KEY=(); H_BAD=()
n=0
while IFS= read -r raw || [ -n "$raw" ]; do
  n=$((n + 1))
  line="${raw%%#*}"
  # shellcheck disable=SC2086
  set -- $line
  [ $# -eq 0 ] && continue
  if [ $# -lt 6 ] || [ $# -gt 7 ]; then echo "kh-rollout.sh: $HOSTS line $n: need 6 or 7 fields" >&2; exit 1; fi
  for f in "$1" "$3" "$4" "$5" "$6"; do safe "$f" || { echo "kh-rollout.sh: $HOSTS line $n: bad characters in a field" >&2; exit 1; }; done
  case "$2" in *@*) ;; *) echo "kh-rollout.sh: $HOSTS line $n: ssh_target must be user@host" >&2; exit 1 ;; esac
  case "$2" in *[!A-Za-z0-9._@:-]*) echo "kh-rollout.sh: $HOSTS line $n: bad ssh_target" >&2; exit 1 ;; esac
  bad=""
  for f in "$@"; do case "$f" in TODO*) bad="a field is still TODO" ;; esac; done
  H_ID+=("$1"); H_TARGET+=("$2"); H_SVC+=("$3"); H_ROOM+=("$4"); H_INST+=("$5"); H_USER+=("$6")
  k="${7:-$HOME/.ssh/id_ecdsa}"; H_KEY+=("${k/#\~/$HOME}"); H_BAD+=("$bad")
done < "$HOSTS"
[ "${#H_ID[@]}" -gt 0 ] || fail_usage "no hosts in $HOSTS"

# ---- helpers ---------------------------------------------------------------------------------------------------------------
SSH_OPTS=(); TARGET=""; SVC=""
rssh() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }
S_OUT=""; S_RC=0
sudo_run() { # sudo_run <command text for the host>: root command; password on ssh stdin only. Sets S_OUT (stdout+stderr), S_RC.
  local out rc
  out=$(security find-generic-password -a eta-deploy -s "$SVC" -w 2>/dev/null | rssh "sudo -S -k -p '' $1" 2>&1); rc=$?
  S_OUT="$out"; S_RC=$rc
}
sudo_failed() { printf '%s' "$S_OUT" | grep -qiE 'incorrect password|try again|a password is required|no tty present|not in the sudoers|may not run sudo'; }

db_node() { [ -r "$DBURL_FILE" ] || return 9; DATABASE_URL="$(cat "$DBURL_FILE")" node "$HELPER_DIR/$1" "${@:2}"; }

LOCAL_BIN=""     # 0600 temp copy of the installed binary on the Air (removed by the traps)
local_cleanup() { [ -n "$LOCAL_BIN" ] && rm -f "$LOCAL_BIN"; LOCAL_BIN=""; return 0; }
CLEAN_STAGE=""   # non-empty while the current host has a staging dir (and maybe a token file) on it
host_cleanup() { # best effort, 10 s limit; uses the current TARGET / SSH_OPTS
  [ -n "$CLEAN_STAGE" ] || return 0
  local st="$CLEAN_STAGE"; CLEAN_STAGE=""
  with_timeout 10 ssh "${SSH_OPTS[@]}" "$TARGET" "rm -rf $st" >/dev/null 2>&1 || true
}
on_exit() { host_cleanup; local_cleanup; }
on_signal() { # on_signal <name> <exit code>
  CUR="${CUR:--}"; echo "$(ts) [$CUR] caught $1: cleaning up the host and stopping" >&2
  host_cleanup; local_cleanup
  exit "$2"
}
trap on_exit EXIT
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap 'on_signal HUP 129' HUP

R_UUID=(); R_RUN=(); R_HB=(); R_RES=(); R_ID=()
record() { R_ID+=("$CUR"); R_UUID+=("$1"); R_RUN+=("$2"); R_HB+=("$3"); R_RES+=("$4"); log "RESULT $CUR | uuid $1 | running $2 | heartbeat $3 | $4"; }

# procs_script: sh script run as root on the host; prints PROCS=<n>, the number of processes whose REAL executable is the installed
# binary (R10b). Candidates are the holders of the daemon lock, whoever has the binary file open, plus every process whose ps name
# ends in "kiosk-health" (an orphan of a replaced binary); each is
# counted only if `lsof -a -p PID -d txt -Fn` (first txt entry) names the installed binary's real path. This sees an orphan started
# as ./kiosk-health, through a symlink or under another argv[0], and ignores a different program that merely sets argv[0].
procs_script() {
  printf 'BIN=%s\nLOCK=/var/db/eta-kiosk-health/spool/daemon.lock\n' "$LIBEXEC_BIN"
  cat <<'EOS'
REAL="$(cd "$(dirname "$BIN")" && pwd -P)/kiosk-health"
c=0
for p in $( { [ -f "$LOCK" ] && /usr/sbin/lsof -t "$LOCK"; /usr/sbin/lsof -t "$REAL"; /bin/ps -axo pid=,comm= | /usr/bin/awk '{ p = $1; $1 = ""; sub(/^ +/, ""); n = split($0, a, "/"); if (a[n] == "kiosk-health") print p }'; } 2>/dev/null | /usr/bin/sort -un ); do
  x="$(/usr/sbin/lsof -a -p "$p" -d txt -Fn 2>/dev/null | /usr/bin/sed -n 's/^n//p' | /usr/bin/head -1)"
  [ "$x" = "$REAL" ] && c=$((c + 1))
done
echo "PROCS=$c"
EOS
}

# ---- one host ---------------------------------------------------------------------------------------------------------------
do_host() { # do_host <index>
  local i=$1 stage tries ok=0 install_args since t_hb hb="-" running="-" inst_sha="-" inst_uuid="-" urc procs line
  CUR="${H_ID[$i]}"; TARGET="${H_TARGET[$i]}"; SVC="${H_SVC[$i]}"
  SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8 -o IdentitiesOnly=yes -i "${H_KEY[$i]}")
  stage="/tmp/kh-rollout.$$.$i.$RANDOM"
  log "=== host ${H_ID[$i]} target=$TARGET svc=$SVC console_user=${H_USER[$i]} mode=$([ "$FIRST" = 1 ] && echo first-install || echo update-only) pkg_uuid=${PKG_UUID:0:12} pkg_sha=${PKG_SHA:0:12}"
  if [ -n "${H_BAD[$i]}" ]; then record "-" "-" "-" "SKIPPED (${H_BAD[$i]})"; return; fi

  install_args=""
  if [ "$FIRST" = 1 ]; then
    install_args="--force-config --machine ${H_ID[$i]} --room-id ${H_ROOM[$i]} --install-id ${H_INST[$i]} --console-user ${H_USER[$i]} --post true --watchdog on --audio-ladder off --reboot-rung off"
    [ "$TOKEN_MINI" = 1 ] && install_args="$install_args --token-file $stage/token"
  fi

  if [ "$DRY" = 1 ]; then
    log "plan: ssh $TARGET true (2 tries, ${REACH_RETRY}s apart; unreachable -> skip)"
    log "plan: security find-generic-password -a eta-deploy -s $SVC   (must exist; password read only for the sudo calls below)"
    log "plan: ssh $TARGET 'mkdir -m 700 -p $stage/build $stage/launchd' ; scp build/kiosk-health install.sh launchd/$LABEL.plist"
    [ "$TOKEN_MINI" = 1 ] && log "plan: ssh mini cat $MINI_TOKEN_PATH | ssh $TARGET 'umask 077; cat > $stage/token'   (stdin only, never printed)"
    log "plan: <from keychain> | ssh $TARGET \"sudo -S -k -p '' /bin/bash $stage/install.sh${install_args:+ $install_args}\""
    log "plan: <from keychain> | ssh $TARGET \"sudo -S -k -p '' /bin/sh -c 'launchctl print system/$LABEL'\"   (running?)"
    log "plan: ssh $TARGET cat $LIBEXEC_BIN > <0600 temp file on the Air>; node macho-uuid.mjs <temp> -> LC_UUID must equal the package's ${PKG_UUID:0:12} (install.sh re-signs ad hoc, so sha256 differs; logged as info)"
    log "plan: node hb-check.mjs ${H_ID[$i]} <time install.sh returned, +1 s>  every ${HB_POLL}s up to ${HB_WAIT}s (heartbeat row in kiosk_health_events)"
    log "plan: ssh $TARGET 'rm -rf $stage'"
    record "-" "-" "-" "DRY-RUN (nothing executed)"; return
  fi

  # 1. reachability: 2 tries, REACH_RETRY seconds apart
  for tries in 1 2; do
    if rssh true >/dev/null 2>&1; then ok=1; break; fi
    log "unreachable (try $tries of 2)"
    [ "$tries" = 1 ] && sleep "$REACH_RETRY"
  done
  [ "$ok" = 1 ] || { record "-" "-" "-" "SKIPPED unreachable after 2 tries"; return; }
  security find-generic-password -a eta-deploy -s "$SVC" >/dev/null 2>&1 || { record "-" "-" "-" "SKIPPED no keychain item eta-deploy/$SVC"; return; }

  # 2. stage the package (and, for a first install, the token through ssh stdin into a 0600 file)
  CLEAN_STAGE="$stage"
  rssh "umask 077; mkdir -p $stage/build $stage/launchd" >/dev/null 2>&1 || { host_cleanup; record "-" "-" "-" "FAILED could not create $stage"; return; }
  if ! scp -q "${SSH_OPTS[@]}" "$PKG/install.sh" "$TARGET:$stage/install.sh" \
     || ! scp -q "${SSH_OPTS[@]}" "$PKG/build/kiosk-health" "$TARGET:$stage/build/kiosk-health" \
     || ! scp -q "${SSH_OPTS[@]}" "$PKG/launchd/$LABEL.plist" "$TARGET:$stage/launchd/$LABEL.plist"; then
    host_cleanup; record "-" "-" "-" "FAILED copying the package"; return
  fi
  if [ "$FIRST" = 1 ] && [ "$TOKEN_MINI" = 1 ]; then
    if ! ssh "${MINI_OPTS[@]}" mini "cat $MINI_TOKEN_PATH" 2>/dev/null | rssh "umask 077; cat > $stage/token" >/dev/null 2>&1; then
      host_cleanup; record "-" "-" "-" "FAILED could not pipe the token from the mini"; return
    fi
    log "token piped to the host (0600 temp file; value not logged)"
  fi

  # 3. install under sudo: stdin password only, one attempt
  sudo_run "/bin/bash $stage/install.sh${install_args:+ $install_args}"
  if sudo_failed; then host_cleanup; record "-" "-" "-" "FAILED sudo (first sudo failure; stopped, no retry)"; return; fi
  if [ "$S_RC" -eq 255 ]; then host_cleanup; record "-" "-" "-" "FAILED ssh error during install"; return; fi
  log "install.sh rc=$S_RC: $(printf '%s' "$S_OUT" | grep -v -i 'token' | tail -3 | tr '\n' ' ' | cut -c1-240)"
  host_cleanup   # also removes the token temp file
  if [ "$S_RC" -ne 0 ]; then record "-" "-" "-" "FAILED install.sh exit $S_RC"; return; fi
  # F29: the heartbeat window opens now, after install.sh returned 0 (+1 s so the same-second old heartbeat cannot count)
  since="$(date -u -v+1S +%Y-%m-%dT%H:%M:%SZ)"; t_hb=$SECONDS
  log "install done; a heartbeat must be newer than $since"

  # 4. verify: running, Mach-O LC_UUID (not sha256: install.sh re-signs ad hoc), heartbeat
  sudo_run "/bin/sh -c \"launchctl print system/$LABEL 2>&1 | grep -E '^[[:space:]]*(state|pid) ='\""
  if sudo_failed; then record "-" "-" "-" "FAILED sudo during verify (stopped)"; return; fi
  printf '%s\n' "$S_OUT" | grep -qE '^[[:space:]]*state = running' && running="yes" || running="NO"
  LOCAL_BIN="$(mktemp "${TMPDIR:-/tmp}/kh-rollout-bin.XXXXXX")" || { record "-" "$running" "-" "FAILED could not make a local temp file"; return; }
  chmod 600 "$LOCAL_BIN"
  if ! with_timeout 60 ssh "${SSH_OPTS[@]}" "$TARGET" "cat $LIBEXEC_BIN" > "$LOCAL_BIN" 2>/dev/null || [ ! -s "$LOCAL_BIN" ]; then
    local_cleanup; record "-" "$running" "-" "FAILED could not read the installed binary over ssh"; return
  fi
  inst_sha="$(shasum -a 256 "$LOCAL_BIN" | awk '{print $1}')"
  inst_uuid="$(node "$HELPER_DIR/macho-uuid.mjs" "$LOCAL_BIN" 2>&1)"; urc=$?
  local_cleanup
  if [ "$urc" -ne 0 ]; then record "-" "$running" "-" "FAILED installed binary: ${inst_uuid#error: }"; return; fi
  log "verify: running=$running installed_uuid=${inst_uuid:0:12} package_uuid=${PKG_UUID:0:12} (installed sha256 ${inst_sha:0:12}, package ${PKG_SHA:0:12}: info only, install.sh re-signs)"
  if [ "$inst_uuid" != "$PKG_UUID" ]; then record "${inst_uuid:0:12}" "$running" "-" "FAILED uuid mismatch (installed ${inst_uuid:0:12} vs package ${PKG_UUID:0:12})"; return; fi
  if [ "$running" != "yes" ]; then record "${inst_uuid:0:12}" "NO" "-" "FAILED daemon not running"; return; fi
  # R10: exactly one process may run the installed binary; two means an orphan beside the launchd job, none means no daemon
  sudo_run "/bin/sh -c \"\$(printf %s '$(procs_script | base64 | tr -d '\n')' | /usr/bin/base64 -D)\""
  if sudo_failed; then record "${inst_uuid:0:12}" "$running" "-" "FAILED sudo during the process count (stopped)"; return; fi
  procs="$(printf '%s\n' "$S_OUT" | sed -n 's/^PROCS=\([0-9][0-9]*\)$/\1/p' | head -1)"; procs="${procs:--1}"
  log "verify: processes running the installed binary: $procs"
  if [ "$procs" != "1" ]; then record "${inst_uuid:0:12}" "$running" "-" "FAILED kiosk-health process count $procs (expected exactly 1)"; return; fi
  while :; do
    line="$(db_node hb-check.mjs "${H_ID[$i]}" "$since" 2>/dev/null)"
    case "$line" in heartbeat\ *) hb="${line#heartbeat }"; break ;; esac
    [ $((SECONDS - t_hb)) -ge "$HB_WAIT" ] && break
    sleep "$HB_POLL"
  done
  if [ "$hb" = "-" ]; then record "${inst_uuid:0:12}" "yes" "NOT SEEN" "FAILED no heartbeat within ${HB_WAIT}s"; return; fi
  record "${inst_uuid:0:12}" "yes" "$hb" "OK"
}

log "=== kh-rollout start: pkg=$PKG pkg_uuid=${PKG_UUID:0:12} pkg_sha=${PKG_SHA:0:12} hosts=${#H_ID[@]} first_install=$FIRST token_from_mini=$TOKEN_MINI dry_run=$DRY"
for i in "${!H_ID[@]}"; do do_host "$i"; done

CUR=""
echo
printf '%-34s | %-12s | %-7s | %-26s | %s\n' machine "installed uuid" running "first heartbeat" result
bad=0
for i in "${!R_ID[@]}"; do
  printf '%-34s | %-12s | %-7s | %-26s | %s\n' "${R_ID[$i]}" "${R_UUID[$i]}" "${R_RUN[$i]}" "${R_HB[$i]}" "${R_RES[$i]}"
  case "${R_RES[$i]}" in OK|DRY-RUN*) ;; *) bad=1 ;; esac
done
[ "$DRY" = 1 ] || { echo; echo "log: $LOGFILE"; }
[ "$bad" = 0 ] || exit 6
exit 0
