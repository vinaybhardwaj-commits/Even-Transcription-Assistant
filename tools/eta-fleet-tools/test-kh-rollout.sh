#!/bin/bash
# test-kh-rollout.sh -- offline test of kh-rollout.sh with stub ssh / scp / security / node-helper. No host, no keychain, no Neon.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/kh-roll-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $*"; }
has() { case "$2" in *"$3"*) ok ;; *) bad "$1: expected '$3' in:"; printf '%s\n' "$2" | sed 's/^/    | /' ;; esac; }
hasnt() { case "$2" in *"$3"*) bad "$1: must NOT contain '$3'" ;; *) ok ;; esac; }
eq() { [ "$2" = "$3" ] && ok || bad "$1: expected '$3' got '$2'"; }

bash -n "$HERE/kh-rollout.sh" && ok || bad "bash -n kh-rollout.sh"
bash -n "$HERE/test-kh-rollout.sh" && ok || bad "bash -n this file"
command -v shellcheck >/dev/null 2>&1 && { shellcheck -S warning "$HERE/kh-rollout.sh" >/dev/null 2>&1 && ok || bad "shellcheck kh-rollout.sh"; }

mkdir -p "$T/bin" "$T/tools" "$T/home" "$T/pkg/build" "$T/pkg/launchd"
cp "$HERE/kh-rollout.sh" "$HERE/macho-uuid.mjs" "$T/tools/"
cat > "$T/tools/hb-check.mjs" <<'JSEOF'
// stub: logs its arguments; answers with a heartbeat only if its time is AFTER the `since` argument.
//   FAKE_HB_AT=<iso>          the heartbeat's time
//   FAKE_HB_MODE=pre|post     pre = the time the install STARTED on the host; post = 5 s after install.sh returned
import fs from 'node:fs';
const dir = process.env.FAKE_DIR, since = process.argv[3];
fs.appendFileSync(dir + '/hb.args', process.argv.slice(2).join(' ') + '\n');
let at = process.env.FAKE_HB_AT || '';
if (process.env.FAKE_HB_MODE === 'pre') at = fs.readFileSync(dir + '/install.start', 'utf8').trim();
if (process.env.FAKE_HB_MODE === 'post') at = new Date(Date.parse(fs.readFileSync(dir + '/install.done', 'utf8').trim()) + 5000).toISOString();
console.log(at && Date.parse(at) > Date.parse(since) ? 'heartbeat ' + new Date(at).toISOString() : 'none');
JSEOF
# REAL Mach-O files, no stub for the uuid parser: the package binary is the real kiosk-health build, the "installed" copy is that
# binary ad-hoc re-signed exactly as install.sh does (cp + codesign --force -s -), and a different thin arm64 binary is compiled here.
REAL_BIN="${KH_REAL_BIN:-$HOME/dev/eta-kiosk-health/build/kiosk-health}"
[ -f "$REAL_BIN" ] || make -C "$HOME/dev/eta-kiosk-health" build >/dev/null 2>&1
[ -f "$REAL_BIN" ] || { echo "FAIL: no real kiosk-health binary at $REAL_BIN (make build in eta-kiosk-health)"; exit 1; }
printf '#!/bin/bash\necho install\n' > "$T/pkg/install.sh"; cp "$REAL_BIN" "$T/pkg/build/kiosk-health"
cp "$REAL_BIN" "$T/installed-resigned"; codesign --force -s - "$T/installed-resigned" >/dev/null 2>&1 || { echo "FAIL: codesign"; exit 1; }
printf 'int main(void){return 0;}\n' > "$T/other.c"; cc -arch arm64 -o "$T/other-thin" "$T/other.c" >/dev/null 2>&1 || { echo "FAIL: cc"; exit 1; }
: > "$T/empty-file"; head -c 100 "$REAL_BIN" > "$T/truncated"; echo "this is plainly not a binary file at all, only text" > "$T/text-file"
printf '<plist/>' > "$T/pkg/launchd/com.evenscribe.kiosk-health.plist"
PKG_SHA="$(shasum -a 256 "$T/pkg/build/kiosk-health" | awk '{print $1}')"
PKG_UUID="$(node "$HERE/macho-uuid.mjs" "$T/pkg/build/kiosk-health")"; PKG_UUID_12="${PKG_UUID:0:12}"
INST_SHA="$(shasum -a 256 "$T/installed-resigned" | awk '{print $1}')"
echo "postgres://fake" > "$T/dburl"; echo k > "$T/key"; chmod 600 "$T/key"

cat > "$T/hosts" <<HEOF
# comment
M-ONE   u@h1.invalid   svc-one   room_1   install_1   kiosk   $T/key
M-TWO   u@h2.invalid   svc-two   room_2   install_2   kiosk   $T/key
HEOF
cat > "$T/hosts-todo" <<HEOF
M-ONE   u@h1.invalid   svc-one   TODO_ROOM_ID   install_1   kiosk   $T/key
HEOF

cat > "$T/bin/security" <<'STUB'
#!/bin/bash
echo "security $*" >> "$FAKE_CALLS"
case " $* " in *" -w "*) echo "fake-sudo-password" ;; esac
exit 0
STUB
cat > "$T/bin/scp" <<'STUB'
#!/bin/bash
echo "scp $*" >> "$FAKE_CALLS"
exit 0
STUB
# ssh stub: scenario via env FAKE_* ; every argv is recorded; stdin of the token write and of sudo is captured to files.
cat > "$T/bin/ssh" <<'STUB'
#!/bin/bash
echo "ssh $*" >> "$FAKE_CALLS"
cmd="${@: -1}"
host=""; for a in "$@"; do case "$a" in *@*) host="$a" ;; mini) host=mini ;; esac; done
case "$cmd" in
  true) [ "${FAKE_UNREACHABLE:-}" = 1 ] && exit 255; exit 0 ;;
  "cat ~/oc/eta-kiosk-health/.ingest-token") echo "SECRET-TOKEN-R7"; exit 0 ;;
  *"cat > "*"/token") cat > "$FAKE_DIR/token.stdin"; exit 0 ;;
  *"sudo -S -k -p '' /bin/bash "*install.sh*)
    cat > "$FAKE_DIR/sudo.stdin"
    if [ "${FAKE_SUDO_FAIL:-}" = 1 ]; then echo "Sorry, try again."; exit 1; fi
    date -u +%Y-%m-%dT%H:%M:%SZ > "$FAKE_DIR/install.start"
    sleep "${FAKE_INSTALL_DELAY:-1.2}"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$FAKE_DIR/install.done"
    echo "eta-kiosk-health installed"; echo "    token: set (never printed)"; exit "${FAKE_INSTALL_RC:-0}" ;;
  *"sudo -S -k -p '' /bin/sh -c"*)
    cat > /dev/null
    echo "	state = ${FAKE_STATE:-running}"; echo "	pid = 4242"
    exit 0 ;;
  "cat /usr/local/libexec/eta-kiosk-health/kiosk-health")
    : > "$FAKE_DIR/cat.start"; sleep "${FAKE_CAT_DELAY:-0}"
    cat "${FAKE_INSTALLED_BIN:-$FAKE_DIR/installed-resigned}"; exit 0 ;;
esac
exit 0
STUB
chmod +x "$T/bin/security" "$T/bin/scp" "$T/bin/ssh"

run() { # run <flags...>: stdout+stderr then rc
  : > "$T/calls"; rm -f "$T/token.stdin" "$T/sudo.stdin" "$T/install.start" "$T/install.done" "$T/hb.args"
  HOME="$T/home" PATH="$T/bin:$PATH" ETA_DB_URL_FILE="$T/dburl" FAKE_CALLS="$T/calls" FAKE_DIR="$T" PKG_SHA="$PKG_SHA" \
    KH_REACH_RETRY_SECS=0 KH_HB_POLL_SECS=0 KH_HB_WAIT_SECS=1 KH_ROLLOUT_LOG="$T/rollout.log" \
    bash "$T/tools/kh-rollout.sh" "$@" 2>&1
  echo "rc=$?"
}
calls() { cat "$T/calls"; }
# pid of the kh-rollout.sh process behind a background `( ... ) &` job: the subshell usually exec's it (then it IS $1), else it is a child.
script_pid() {
  if ps -o command= -p "$1" 2>/dev/null | grep -q 'kh-rollout.sh'; then echo "$1"; else pgrep -P "$1" | head -1; fi
}

# 0. macho-uuid.mjs on REAL Mach-O files
mu() { node "$HERE/macho-uuid.mjs" "$@" 2>&1; echo "rc=$?"; }
out="$(mu "$REAL_BIN")"; has "macho-uuid: real build prints 32 hex" "$out" "rc=0"
eq "macho-uuid: 32 lowercase hex digits" "$(printf '%s' "$PKG_UUID" | grep -cE '^[0-9a-f]{32}$')" "1"
if /usr/bin/dwarfdump --uuid "$REAL_BIN" >/dev/null 2>&1; then
  dd_uuid="$(/usr/bin/dwarfdump --uuid "$REAL_BIN" | awk 'NR==1 {print $2}' | tr -d '-' | tr 'A-F' 'a-f')"
  eq "macho-uuid: matches dwarfdump --uuid (independent reader)" "$PKG_UUID" "$dd_uuid"
fi
eq "macho-uuid: re-signed copy has the same LC_UUID" "$(node "$HERE/macho-uuid.mjs" "$T/installed-resigned")" "$PKG_UUID"
check_ne2() { [ "$1" != "$2" ] && ok || bad "$3"; }
check_ne2 "$(shasum -a 256 < "$T/installed-resigned")" "$(shasum -a 256 < "$REAL_BIN")" "re-signed copy differs in bytes"
other="$(node "$HERE/macho-uuid.mjs" "$T/other-thin")"
check_ne2 "$other" "$PKG_UUID" "a different binary has a different LC_UUID"
out="$(mu /bin/ls)"; has "macho-uuid: fat binary fails clearly" "$out" "fat (universal)"; has "macho-uuid: fat rc 2" "$out" "rc=2"
out="$(mu "$T/text-file")"; has "macho-uuid: text file" "$out" "not a Mach-O file"
out="$(mu "$T/empty-file")"; has "macho-uuid: empty file" "$out" "too short"
out="$(mu "$T/truncated")"; has "macho-uuid: truncated Mach-O" "$out" "rc=2"
out="$(mu "$T/does-not-exist")"; has "macho-uuid: missing file" "$out" "rc=2"
out="$(mu)"; has "macho-uuid: usage" "$out" "usage"

# 1. usage errors
out="$(run)"; has "no args" "$out" "rc=1"
out="$(run --pkg "$T/pkg")"; has "no hosts" "$out" "--hosts is required"
out="$(run --pkg "$T/nope" --hosts "$T/hosts")"; has "bad pkg" "$out" "package dir not found"
out="$(run --bogus)"; has "unknown option" "$out" "unknown option"

# 1b. a package whose binary is not a thin Mach-O is refused up front
mkdir -p "$T/pkgbad/build" "$T/pkgbad/launchd"; cp "$T/pkg/install.sh" "$T/pkgbad/"; cp /bin/ls "$T/pkgbad/build/kiosk-health"; cp "$T/pkg/launchd/"* "$T/pkgbad/launchd/"
out="$(run --pkg "$T/pkgbad" --hosts "$T/hosts" --dry-run)"
has "fat package refused" "$out" "package binary: fat (universal)"; has "fat package rc 1" "$out" "rc=1"

# 2. dry-run: plan only, nothing executed
out="$(run --pkg "$T/pkg" --hosts "$T/hosts" --first-install --token-from-mini --dry-run)"
has "dry: rc 0" "$out" "rc=0"
has "dry: plan for host 1" "$out" "plan: ssh u@h1.invalid true"
has "dry: first-install args" "$out" "--force-config --machine M-ONE --room-id room_1 --install-id install_1 --console-user kiosk --post true --watchdog on --audio-ladder off --reboot-rung off --token-file"
has "dry: token pipe is stdin" "$out" "umask 077; cat >"
has "dry: password not shown" "$out" "<from keychain>"
has "dry: table" "$out" "DRY-RUN"
eq "dry: no ssh/scp/security call at all" "$(wc -c < "$T/calls" | tr -d ' ')" "0"
hasnt "dry: no log file written" "$(ls "$T" | tr '\n' ' ')" "rollout.log"
out="$(run --pkg "$T/pkg" --hosts "$T/hosts" --dry-run)"
hasnt "dry update-only: plain install.sh (no force-config)" "$out" "--force-config"
has "dry update-only: plain install.sh" "$out" "/bin/bash /tmp/kh-rollout."
hasnt "dry update-only: no token step" "$out" "ingest-token"

# 3. TODO host is skipped, not installed
out="$(run --pkg "$T/pkg" --hosts "$T/hosts-todo")"
has "todo: skipped" "$out" "SKIPPED (a field is still TODO)"
has "todo: rc 6" "$out" "rc=6"
eq "todo: nothing run" "$(wc -c < "$T/calls" | tr -d ' ')" "0"

# 4. a good first install on both hosts
out="$(FAKE_HB_AT=2099-01-01T00:00:00.000Z run --pkg "$T/pkg" --hosts "$T/hosts" --first-install --token-from-mini)"
has "ok: rc 0" "$out" "rc=0"
eq "ok: two OK rows" "$(printf '%s\n' "$out" | grep -c '^M-.* | OK$')" "2"
has "ok: uuid column header" "$out" "installed uuid"
has "ok: uuid column value (LC_UUID of the real build)" "$out" "$PKG_UUID_12"
has "ok: heartbeat time" "$out" "2099-01-01T00:00:00.000Z"
has "ok: log written" "$(cat "$T/rollout.log")" "RESULT M-TWO"
has "install argv has the flags" "$(calls)" "--force-config --machine M-TWO --room-id room_2 --install-id install_2 --console-user kiosk --post true --watchdog on --audio-ladder off --reboot-rung off --token-file /tmp/kh-rollout."
hasnt "password never in argv" "$(calls)" "fake-sudo-password"
hasnt "token never in argv" "$(calls)" "SECRET-TOKEN-R7"
hasnt "token never printed" "$out" "SECRET-TOKEN-R7"
hasnt "token never logged" "$(cat "$T/rollout.log")" "SECRET-TOKEN-R7"
hasnt "password never printed" "$out" "fake-sudo-password"
eq "password reached sudo on stdin" "$(cat "$T/sudo.stdin")" "fake-sudo-password"
eq "token reached the host on stdin" "$(cat "$T/token.stdin")" "SECRET-TOKEN-R7"
has "token written under umask 077" "$(calls)" "umask 077; cat > /tmp/kh-rollout."
has "stage dir removed after" "$(calls)" "rm -rf /tmp/kh-rollout."
hasnt "never touches Chrome, recorder, pmset, guard" "$(calls | grep -v 'launchctl print system/com.evenscribe.kiosk-health')" "presence-guard"
for w in "Google Chrome" pmset RoomRecorder killall; do hasnt "no '$w' in any command" "$(calls)" "$w"; done

# 5. update-only runs plain install.sh
out="$(FAKE_HB_AT=2099-01-01T00:00:00.000Z run --pkg "$T/pkg" --hosts "$T/hosts")"
has "update: rc 0" "$out" "rc=0"
hasnt "update: no --force-config" "$(calls)" "--force-config"
hasnt "update: no token step" "$(calls)" "ingest-token"

# 6. failures
out="$(FAKE_SUDO_FAIL=1 run --pkg "$T/pkg" --hosts "$T/hosts")"
has "sudo fail: result" "$out" "FAILED sudo (first sudo failure; stopped, no retry)"
eq "sudo fail: exactly one sudo attempt per host" "$(calls | grep -c "sudo -S -k -p ''")" "2"
has "sudo fail: rc 6" "$out" "rc=6"
# a different thin arm64 binary: LC_UUID differs -> FAIL
out="$(FAKE_INSTALLED_BIN="$T/other-thin" run --pkg "$T/pkg" --hosts "$T/hosts")"
has "uuid mismatch (different real binary)" "$out" "FAILED uuid mismatch"
hasnt "uuid mismatch: no OK row" "$(printf '%s\n' "$out" | grep '^M-')" "| OK"
# /bin/ls is a fat binary: fails clearly, never guesses a slice
out="$(FAKE_INSTALLED_BIN=/bin/ls run --pkg "$T/pkg" --hosts "$T/hosts")"
has "fat installed binary fails clearly" "$out" "FAILED installed binary: fat (universal) binary"
out="$(FAKE_INSTALLED_BIN="$T/text-file" run --pkg "$T/pkg" --hosts "$T/hosts")"
has "non-Mach-O installed file" "$out" "FAILED installed binary: not a Mach-O file"
out="$(FAKE_INSTALLED_BIN="$T/empty-file" run --pkg "$T/pkg" --hosts "$T/hosts")"
has "empty installed file" "$out" "FAILED could not read the installed binary"
# the real bug: the installed (re-signed) copy has a DIFFERENT sha256 but the same LC_UUID -> PASS
check_ne() { [ "$1" != "$2" ] && ok || bad "$3: both are '$1'"; }
check_ne "$INST_SHA" "$PKG_SHA" "the ad-hoc re-signed copy must differ in sha256 from the package (that is the install.sh bug)"
out="$(FAKE_HB_AT=2099-01-01T00:00:00.000Z run --pkg "$T/pkg" --hosts "$T/hosts")"
eq "re-signed copy (different sha, same LC_UUID) passes on both hosts" "$(printf '%s\n' "$out" | grep -c '^M-.* | OK$')" "2"
has "installed sha is still logged as info" "$(cat "$T/rollout.log")" "installed sha256 ${INST_SHA:0:12}"
has "package sha is logged as info" "$(cat "$T/rollout.log")" "package ${PKG_SHA:0:12}"
eq "no local temp copy of the installed binary is left" "$(ls "${TMPDIR:-/tmp}" | grep -c '^kh-rollout-bin' || true)" "0"
# the install itself must not need otool/dwarfdump/xcrun/python3 on the host
for t in otool dwarfdump xcrun python3; do hasnt "no $t on the host" "$(calls)" "$t"; done
has "installed binary read with plain ssh cat (no sudo)" "$(calls)" "cat /usr/local/libexec/eta-kiosk-health/kiosk-health"
# INT while the installed binary is being copied: the local temp file is removed by the trap
: > "$T/calls"; rm -f "$T/install.start" "$T/install.done" "$T/cat.start"
( HOME="$T/home" PATH="$T/bin:$PATH" ETA_DB_URL_FILE="$T/dburl" FAKE_CALLS="$T/calls" FAKE_DIR="$T" PKG_SHA="$PKG_SHA" FAKE_CAT_DELAY=3 \
  KH_REACH_RETRY_SECS=0 KH_ROLLOUT_LOG="$T/rollout-cat.log" \
  perl -e '$SIG{INT}="DEFAULT"; exec @ARGV' bash "$T/tools/kh-rollout.sh" --pkg "$T/pkg" --hosts "$T/hosts" > "$T/cat.out" 2>&1 ) &
sub=$!
for _ in $(seq 1 40); do [ -f "$T/cat.start" ] && break; sleep 0.25; done
pid="$(script_pid "$sub")"; kill -INT "$pid"
wait "$sub"; rc=$?
eq "INT during the binary copy exits 130" "$rc" "130"
eq "INT during the binary copy leaves no local temp file" "$(ls "${TMPDIR:-/tmp}" | grep -c '^kh-rollout-bin' || true)" "0"
out="$(FAKE_STATE=waiting run --pkg "$T/pkg" --hosts "$T/hosts")"
has "not running" "$out" "FAILED daemon not running"
out="$(run --pkg "$T/pkg" --hosts "$T/hosts")"
has "no heartbeat" "$out" "FAILED no heartbeat within 1s"
has "no heartbeat: NOT SEEN" "$out" "NOT SEEN"
out="$(FAKE_UNREACHABLE=1 run --pkg "$T/pkg" --hosts "$T/hosts")"
has "unreachable: skipped" "$out" "SKIPPED unreachable after 2 tries"
eq "unreachable: 2 tries per host" "$(calls | grep -c ' true$')" "4"
out="$(FAKE_INSTALL_RC=1 run --pkg "$T/pkg" --hosts "$T/hosts")"
has "install.sh failure" "$out" "FAILED install.sh exit 1"

# 6b. F29: the heartbeat window opens after install.sh returns
out="$(FAKE_HB_MODE=pre run --pkg "$T/pkg" --hosts "$T/hosts")"
has "F29: a heartbeat from before the install completed does NOT pass" "$out" "FAILED no heartbeat within 1s"
eq "F29: no OK row for a pre-install heartbeat" "$(printf '%s\n' "$out" | grep -c '^M-.* | OK$')" "0"
out="$(FAKE_HB_AT=2000-01-01T00:00:00.000Z run --pkg "$T/pkg" --hosts "$T/hosts")"
has "F29: an old heartbeat does not pass" "$out" "NOT SEEN"
out="$(FAKE_HB_MODE=post run --pkg "$T/pkg" --hosts "$T/hosts")"
eq "F29: a heartbeat after install completion passes (both hosts)" "$(printf '%s\n' "$out" | grep -c '^M-.* | OK$')" "2"
since="$(awk 'END {print $2}' "$T/hb.args")"; done_at="$(cat "$T/install.done")"
check_ge() { [ "$1" \> "$2" ] || [ "$1" = "$2" ] && ok || bad "$3: '$1' is not >= '$2'"; }
check_ge "$since" "$done_at" "F29: since passed to hb-check is taken after install.sh returned"
has "F29: the since value is logged" "$(cat "$T/rollout.log")" "a heartbeat must be newer than"

# 6c. F30: INT mid-run: the host staging dir is removed, nothing is left locally, the run stops at once
before="$(ls "${TMPDIR:-/tmp}" | grep -c '^kh-rollout' || true)"
: > "$T/calls"; rm -f "$T/install.start" "$T/install.done"
( HOME="$T/home" PATH="$T/bin:$PATH" ETA_DB_URL_FILE="$T/dburl" FAKE_CALLS="$T/calls" FAKE_DIR="$T" PKG_SHA="$PKG_SHA" FAKE_INSTALL_DELAY=3 \
  KH_REACH_RETRY_SECS=0 KH_HB_POLL_SECS=0 KH_HB_WAIT_SECS=1 KH_ROLLOUT_LOG="$T/rollout-int.log" \
  perl -e '$SIG{INT}="DEFAULT"; $SIG{TERM}="DEFAULT"; $SIG{HUP}="DEFAULT"; exec @ARGV' bash "$T/tools/kh-rollout.sh" --pkg "$T/pkg" --hosts "$T/hosts" --first-install --token-from-mini > "$T/int.out" 2>&1 ) &
sub=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -f "$T/install.start" ] && break; sleep 0.25; done
pid="$(script_pid "$sub")"
kill -INT "$pid"
wait "$sub"; rc=$?
eq "F30: INT exits 130" "$rc" "130"
has "F30: caught INT" "$(cat "$T/int.out")" "caught INT"
has "F30: host staging dir (token file inside) removed on INT" "$(calls)" "rm -rf /tmp/kh-rollout."
hasnt "F30: the run stopped (no verify step, no second host)" "$(calls)" "svc-two"
hasnt "F30: stopped before verify" "$(calls)" "launchctl print"
eq "F30: no kh-rollout temp entries left locally" "$(ls "${TMPDIR:-/tmp}" | grep -c '^kh-rollout' || true)" "$before"
hasnt "F30: token not in the output" "$(cat "$T/int.out")" "SECRET-TOKEN-R7"
# TERM and HUP take the same path
for sig in TERM HUP; do
  : > "$T/calls"; rm -f "$T/install.start"
  ( HOME="$T/home" PATH="$T/bin:$PATH" ETA_DB_URL_FILE="$T/dburl" FAKE_CALLS="$T/calls" FAKE_DIR="$T" PKG_SHA="$PKG_SHA" FAKE_INSTALL_DELAY=3 \
    KH_REACH_RETRY_SECS=0 KH_ROLLOUT_LOG="$T/rollout-$sig.log" \
    perl -e '$SIG{INT}="DEFAULT"; $SIG{TERM}="DEFAULT"; $SIG{HUP}="DEFAULT"; exec @ARGV' bash "$T/tools/kh-rollout.sh" --pkg "$T/pkg" --hosts "$T/hosts" > "$T/$sig.out" 2>&1 ) &
  sub=$!
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -f "$T/install.start" ] && break; sleep 0.25; done
  pid="$(script_pid "$sub")"; kill -"$sig" "$pid"
  wait "$sub"; rc=$?
  eq "F30: $sig exit code" "$rc" "$([ "$sig" = TERM ] && echo 143 || echo 129)"
  has "F30: $sig cleans the host" "$(calls)" "rm -rf /tmp/kh-rollout."
done
# a normal run also leaves no staging dir pending: every install ends with exactly one rm -rf per host
run --pkg "$T/pkg" --hosts "$T/hosts" >/dev/null
eq "cleanup: one rm -rf per host on a normal run" "$(calls | grep -c 'rm -rf /tmp/kh-rollout.')" "2"

# 7. bad hosts file lines are refused before anything runs
printf 'M-ONE u@h svc room\n' > "$T/hosts-short"
out="$(run --pkg "$T/pkg" --hosts "$T/hosts-short" --dry-run)"; has "short line" "$out" "need 6 or 7 fields"
printf 'M-ONE u@h svc room inst kiosk;rm\n' > "$T/hosts-inj"
out="$(run --pkg "$T/pkg" --hosts "$T/hosts-inj" --dry-run)"; has "bad chars refused" "$out" "bad characters"
printf 'M-ONE uh svc room inst kiosk\n' > "$T/hosts-notarget"
out="$(run --pkg "$T/pkg" --hosts "$T/hosts-notarget" --dry-run)"; has "target needs @" "$out" "ssh_target must be user@host"

# 8. hosts-opd.txt (filled by fable): six hosts planned, none skipped, nothing executed
out="$(run --pkg "$T/pkg" --hosts "$HERE/hosts-opd.txt" --dry-run)"
has "hosts-opd parses" "$out" "hosts=6"
eq "hosts-opd: six hosts planned" "$(printf '%s\n' "$out" | grep -c ' plan: ssh .* true ')" "6"
eq "hosts-opd: zero skipped" "$(printf '%s\n' "$out" | grep -c 'SKIPPED')" "0"
eq "hosts-opd: six dry-run rows" "$(printf '%s\n' "$out" | grep -c '^EHRC-.* | DRY-RUN')" "6"
eq "hosts-opd: nothing executed" "$(wc -c < "$T/calls" | tr -d ' ')" "0"

echo "kh-rollout tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
