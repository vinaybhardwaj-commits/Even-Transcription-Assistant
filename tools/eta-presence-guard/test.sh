#!/bin/bash
# test.sh — runs WITHOUT root against temp PLIST_PATH/STATE_DIR. macOS only (PlistBuddy, plutil).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GUARD="$HERE/eta-presence-guard.sh"
PB=/usr/libexec/PlistBuddy
MID="EHRC-ECHOs-Mac-mini"
EXT="choegfgddhpljibnolbcljnlfhfpimbh"
WANT="${EXT};https://www.evenscribe.app/ext/${MID}/update.xml"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
P="$tmp/Managed Preferences/com.google.Chrome.plist"
S="$tmp/state"
pass=0; fail=0

check() { # check <description> <command...>
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); printf 'PASS  %s\n' "$d"
  else fail=$((fail + 1)); printf 'FAIL  %s\n' "$d"; fi
}

run_guard() { # env: MID_OVERRIDE; BOOT (kern.boottime text, wins) else UP (seconds) else 100000
  local -a ov=()
  if [ -n "${BOOT:-}" ]; then ov+=(BOOTTIME_OVERRIDE="$BOOT")
  elif [ -n "${UP:-}" ]; then ov+=(UPTIME_OVERRIDE="$UP")
  else ov+=(UPTIME_OVERRIDE=100000); fi
  env PLIST_PATH="$P" STATE_DIR="$S" ENV_FILE="$tmp/no-such-env" MACHINE_ID="${MID_OVERRIDE:-$MID}" \
      NO_KILL=1 BOOT_LOOP_SLEEP="${BLS:-0.05}" "${ov[@]}" bash "$GUARD" "$@"
}
pb_get() { "$PB" -c "Print $1" "$P" 2>/dev/null; }
has_text() { grep -qF -- "$2" <<< "$1"; }
no_text() { ! grep -qF -- "$2" <<< "$1"; }

# 1. missing file -> writes, reason missing
out="$(run_guard 2>&1)"
check "missing: logs rewrite reason=missing" has_text "$out" "rewrite reason=missing machine=$MID"
check "missing: plist exists and lints" plutil -lint "$P"
check "missing: forcelist[0] is the expected entry" test "$(pb_get :ExtensionInstallForcelist:0)" = "$WANT"
check "missing: last_rewrite recorded" test -s "$S/last_rewrite"
check "missing: no temp file left behind" test -z "$(ls -A "$(dirname "$P")" | grep -v '^com.google.Chrome.plist$')"

# 2. correct file -> no write, mtime unchanged
touch -t 202001010000 "$P"
m1="$(stat -f %m "$P")"; h1="$(shasum "$P" | cut -d' ' -f1)"
out="$(run_guard 2>&1)"
m2="$(stat -f %m "$P")"; h2="$(shasum "$P" | cut -d' ' -f1)"
check "ok: mtime unchanged" test "$m1" = "$m2"
check "ok: content unchanged" test "$h1" = "$h2"
check "ok: no rewrite logged" test -z "$out"
echo 29 > "$S/ok_count"
out="$(run_guard 2>&1)"
check "ok: logged on 30th run" has_text "$out" " ok"
check "ok: still no write on 30th run" test "$(stat -f %m "$P")" = "$m1"

# 3. other keys + wrong entry -> entry replaced, other keys preserved
rm -f "$P"
"$PB" -c "Add :HomepageLocation string https://example.com/" \
      -c "Add :ExtensionInstallForcelist array" \
      -c "Add :ExtensionInstallForcelist:0 string stale;https://old.example/update.xml" "$P" >/dev/null 2>&1
out="$(run_guard 2>&1)"
check "stripped: logs reason=stripped" has_text "$out" "rewrite reason=stripped machine=$MID"
check "stripped: plist lints" plutil -lint "$P"
check "stripped: foreign entry kept at [0]" test "$(pb_get :ExtensionInstallForcelist:0)" = "stale;https://old.example/update.xml"
check "stripped: ours appended at [1]" test "$(pb_get :ExtensionInstallForcelist:1)" = "$WANT"
check "stripped: other key preserved" test "$(pb_get :HomepageLocation)" = "https://example.com/"

# 3b. fix 2: [other, old-ours-with-file-url] -> [other, E]; no duplicates of our id
rm -f "$P"
"$PB" -c "Add :ExtensionInstallForcelist array" \
      -c "Add :ExtensionInstallForcelist:0 string other;https://x" \
      -c "Add :ExtensionInstallForcelist:1 string ${EXT};file:///old/update.xml" \
      -c "Add :SomeOtherPolicy bool true" "$P" >/dev/null 2>&1
out="$(run_guard 2>&1)"
check "mixed list: reason=stripped" has_text "$out" "rewrite reason=stripped"
check "mixed list: [0] is other;https://x" test "$(pb_get :ExtensionInstallForcelist:0)" = "other;https://x"
check "mixed list: [1] is E" test "$(pb_get :ExtensionInstallForcelist:1)" = "$WANT"
check "mixed list: exactly two entries" bash -c "! \"$PB\" -c 'Print :ExtensionInstallForcelist:2' \"$P\" >/dev/null 2>&1"
check "mixed list: other key preserved" test "$(pb_get :SomeOtherPolicy)" = "true"

# 3c. fix 2: failure leaves original untouched, logs rewrite_failed, no temp file
rm -f "$P"
"$PB" -c "Add :ExtensionInstallForcelist array" -c "Add :ExtensionInstallForcelist:0 string other;https://x" "$P" >/dev/null 2>&1
h1="$(shasum "$P" | cut -d' ' -f1)"
out="$(PB=/usr/bin/false run_guard 2>&1)"
check "failed write: logs rewrite_failed" has_text "$out" "rewrite_failed reason=stripped"
check "failed write: original untouched" test "$(shasum "$P" | cut -d' ' -f1)" = "$h1"
check "failed write: no temp file left" test -z "$(ls -A "$(dirname "$P")" | grep -v '^com.google.Chrome.plist$')"

# 4. unknown host -> no write, nothing created
rm -rf "$P" "$S"
out="$(MID_OVERRIDE="not-a-kiosk" run_guard 2>&1)"
check "unknown host: logs unknown_host" has_text "$out" "unknown_host"
check "unknown host: no plist written" test ! -e "$P"
check "unknown host: no state written" test ! -e "$S"

# 5. dry-run writes nothing
out="$(run_guard --dry-run 2>&1)"
check "dry-run: decision printed" has_text "$out" "dry-run decision=rewrite reason=missing"
check "dry-run: no plist written" test ! -e "$P"
check "dry-run: no state written" test ! -e "$S"

# 6. boot reason when uptime < 180 s
out="$(UP=60 run_guard 2>&1)"
check "boot: logs reason=boot" has_text "$out" "rewrite reason=boot machine=$MID"
check "boot: plist written" test "$(pb_get :ExtensionInstallForcelist:0)" = "$WANT"

# 6b. fix 1: parse the real kern.boottime text (sec AND usec present), not UPTIME_OVERRIDE
rm -rf "$P" "$S"
b=$(( $(date +%s) - 50 ))
out="$(BOOT="{ sec = $b, usec = 293731 } Mon Oct  5 12:00:00 2026" run_guard --dry-run 2>&1)"
check "boottime parse: booted 50 s ago -> reason=boot (usec not read)" has_text "$out" "reason=boot"
fixed=1791154182
out="$(BOOT="{ sec = $fixed, usec = 293731 } Mon Oct  5 12:00:00 2026" run_guard --dry-run 2>&1)"
up_got="$(sed -n 's/.*uptime=\([0-9]*\)s.*/\1/p' <<< "$out" | sed -n 1p)"
exp=$(( $(date +%s) - fixed ))
d=$(( up_got - exp )); [ "$d" -lt 0 ] && d=$(( -d ))
check "boottime parse: sec=1791154182 yields now-sec (diff=${d}s)" test -n "$up_got" -a "$d" -le 5

# 7. corrupt plist is replaced
mkdir -p "$(dirname "$P")"; printf 'not a plist' > "$P"
out="$(run_guard 2>&1)"
check "corrupt: reason=stripped" has_text "$out" "rewrite reason=stripped machine=$MID"
check "corrupt: plist lints afterwards" plutil -lint "$P"

# 8. fix 3: relaunch rung — absent-only and once per rewrite
P="$tmp/rl/com.google.Chrome.plist"; S="$tmp/rl-seed"
run_guard >/dev/null 2>&1                       # seed a correct plist (state dir S is separate)
RS="$tmp/rl-state"; mkdir -p "$RS"
HR="$tmp/Users"; CHROME="$HR/kiosk/Library/Application Support/Google/Chrome/Default/Extensions"
mkdir -p "$CHROME"
echo $(( $(date +%s) - 1000 )) > "$RS/last_rewrite"
rl() {
  env PLIST_PATH="$P" STATE_DIR="$RS" ENV_FILE="$tmp/no-such-env" MACHINE_ID="$MID" NO_KILL="${NK:-1}" \
      UPTIME_OVERRIDE=100000 CONSOLE_USER_OVERRIDE=kiosk HOME_ROOT="$HR" HID_IDLE_OVERRIDE="${IDLE:-1000}" \
      QUIT_POLL=0.01 PATH="${STUBPATH:-$PATH}" bash "$GUARD" "$@"
}
out="$(rl --dry-run 2>&1)"
check "relaunch: all gates pass, extension dir absent -> would run" has_text "$out" "dry-run relaunch: would restart Chrome"
mkdir -p "$CHROME/$EXT"; touch -t 202001010000 "$CHROME/$EXT"      # present, OLDER than last_rewrite
out="$(rl --dry-run 2>&1)"
check "relaunch: dir present (even if older than rewrite) -> no" has_text "$out" "no (extension_present)"
rmdir "$CHROME/$EXT"
out="$(rl 2>&1)"
check "relaunch: fires and logs relaunch" has_text "$out" "relaunch"
check "relaunch: consumed rewrite recorded" test "$(cat "$RS/last_relaunch_rewrite")" = "$(cat "$RS/last_rewrite")"
rm -f "$RS/last_relaunch"                                          # isolate from the 30-min gate
out="$(rl --dry-run 2>&1)"
check "relaunch: second eligibility check -> already consumed" has_text "$out" "no (already_relaunched_for_this_rewrite)"
out="$(rl 2>&1)"
check "relaunch: does not fire twice for the same rewrite" no_text "$out" "relaunch"
echo $(( $(date +%s) - 900 )) > "$RS/last_rewrite"                 # a new rewrite happened
out="$(rl --dry-run 2>&1)"
check "relaunch: new rewrite re-arms the rung" has_text "$out" "dry-run relaunch: would restart Chrome"
echo $(( $(date +%s) - 100 )) > "$RS/last_rewrite"                 # rewrite only 100 s old
out="$(rl --dry-run 2>&1)"
check "relaunch: rewrite younger than 3 min -> no" has_text "$out" "no (last_rewrite_under_3min)"
echo $(( $(date +%s) - 200 )) > "$RS/last_rewrite"                 # 200 s old: eligible (was 15 min)
out="$(rl --dry-run 2>&1)"
check "relaunch: rewrite older than 3 min -> would run" has_text "$out" "dry-run relaunch: would restart Chrome"
check "relaunch: no clinic-hours gate left in the script" bash -c "! grep -qiE 'clinic_hours|LOCAL_DOW|LOCAL_HM|2130' '$GUARD'"
out="$(IDLE=300 rl --dry-run 2>&1)"
check "relaunch: console not idle > 600 s -> no" has_text "$out" "no (not_idle_300s)"

# 8b. restart method: open (Chrome not running) / term (exits during wait) / kill (never exits)
BIN2="$tmp/bin2"; SD2="$tmp/stub2"; mkdir -p "$BIN2" "$SD2"
cat > "$BIN2/pgrep" <<'EOF'
#!/bin/bash
n=$(cat "$STUB_DIR/pg" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_DIR/pg"
[ "$n" -le "${STUB_PGREP_RUNS:-0}" ]
EOF
cat > "$BIN2/killall" <<'EOF'
#!/bin/bash
echo "killall $*" >> "$STUB_DIR/calls"
EOF
cat > "$BIN2/pkill" <<'EOF'
#!/bin/bash
echo "pkill $*" >> "$STUB_DIR/calls"
EOF
cat > "$BIN2/launchctl" <<'EOF'
#!/bin/bash
echo "launchctl $*" >> "$STUB_DIR/calls"
EOF
cat > "$BIN2/id" <<'EOF'
#!/bin/bash
if [ "$1 ${2:-}" = "-u kiosk" ]; then echo 501; else exec /usr/bin/id "$@"; fi
EOF
chmod +x "$BIN2"/*
rearm() { rm -f "$SD2"/* "$RS/last_relaunch" "$RS/last_relaunch_rewrite"; echo $(( $(date +%s) - 1000 )) > "$RS/last_rewrite"; }
rearm
out="$(STUB_DIR="$SD2" STUB_PGREP_RUNS=0 STUBPATH="$BIN2:$PATH" NK=0 rl 2>&1)"
check "restart: Chrome not running -> method=open" has_text "$out" "relaunch method=open"
check "restart: open issued as console user (uid 501)" grep -q "asuser 501 sudo -u kiosk open -a Google Chrome https://pulse.even.in/" "$SD2/calls"
check "restart: nothing signalled when Chrome not running" bash -c "! grep -q 'pkill' '$SD2/calls'"
rearm
out="$(STUB_DIR="$SD2" STUB_PGREP_RUNS=3 STUBPATH="$BIN2:$PATH" NK=0 rl 2>&1)"
check "restart: exits during wait -> method=term" has_text "$out" "relaunch method=term"
check "restart: SIGTERM sent" grep -qx "pkill -TERM -x Google Chrome" "$SD2/calls"
check "restart: no SIGKILL on graceful exit" bash -c "! grep -q 'pkill -KILL' '$SD2/calls'"
check "restart: no osascript anywhere (script, calls)" bash -c "! grep -q osascript '$GUARD' '$SD2/calls'"
check "restart: open comes last" bash -c "tail -1 '$SD2/calls' | grep -q 'open -a Google Chrome'"
rearm
out="$(STUB_DIR="$SD2" STUB_PGREP_RUNS=9999 STUBPATH="$BIN2:$PATH" NK=0 rl 2>&1)"
check "restart: never exits -> method=kill" has_text "$out" "relaunch method=kill"
check "restart: SIGTERM then SIGKILL issued" bash -c "grep -n pkill '$SD2/calls' | tr '\n' ' ' | grep -q 'pkill -TERM -x Google Chrome.*pkill -KILL -x Google Chrome'"
check "restart: open comes after the kill" bash -c "tail -1 '$SD2/calls' | grep -q 'open -a Google Chrome'"

# 8c. window rung (G1): stubbed pgrep / lsof / launchctl / id; fake Chrome dir; HID idle via override
WB="$tmp/wbin"; WSD="$tmp/wstub"; WS="$tmp/wstate"; WH="$tmp/wusers"; mkdir -p "$WB" "$WSD" "$WS"
WC="$WH/kiosk/Library/Application Support/Google/Chrome"
mkdir -p "$WC/Default" "$WC/Profile 2"
printf 'CANARY-PREFS' > "$WC/Default/Preferences"; printf 'CANARY-PREFS' > "$WC/Profile 2/Preferences"
printf '{"profile":{"last_active_profiles":["Profile 2"],"last_used":"Profile 2"}}' > "$WC/Local State"
plutil -convert binary1 "$WC/Local State"
cat > "$WB/pgrep" <<'EOF2'
#!/bin/bash
[ "${STUB_CHROME:-1}" = "1" ] && { echo 4242; echo 4243; exit 0; }
exit 1
EOF2
cat > "$WB/lsof" <<'EOF2'
#!/bin/bash
echo "lsof $*" >> "$STUB_DIR/calls"
[ -n "${STUB_LSOF_EMPTY:-}" ] && exit "${STUB_LSOF_RC:-1}"
echo p4242; echo n/dev/null
[ -n "${STUB_LOADED:-}" ] && printf 'n%s\n' "$STUB_LOADED"
exit "${STUB_LSOF_RC:-0}"
EOF2
cat > "$WB/launchctl" <<'EOF2'
#!/bin/bash
echo "launchctl $*" >> "$STUB_DIR/calls"
EOF2
cat > "$WB/id" <<'EOF2'
#!/bin/bash
if [ "$1 ${2:-}" = "-u kiosk" ]; then echo 501; else exec /usr/bin/id "$@"; fi
EOF2
chmod +x "$WB"/*
wg() { # wg [guard args]; env: IDLE (default 1000) NK (default 0)
  env PLIST_PATH="$P" STATE_DIR="$WS" ENV_FILE="$tmp/no-such-env" MACHINE_ID="$MID" NO_KILL="${NK:-0}" \
      UPTIME_OVERRIDE=100000 CONSOLE_USER_OVERRIDE=kiosk HOME_ROOT="$WH" HID_IDLE_OVERRIDE="${IDLE:-1000}" \
      STUB_DIR="$WSD" PATH="$WB:$PATH" bash "$GUARD" "$@"
}
wreset() { rm -f "$WSD"/* "$WS"/window_open_*; }
wreset
out="$(wg 2>&1)"
check "window: not loaded + idle -> launches Chrome binary for Profile 2" grep -qF 'launchctl asuser 501 sudo -u kiosk /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Profile 2 https://pulse.even.in/' "$WSD/calls"
check "window: logs window_open" has_text "$out" "window_open method=launch profile=Profile 2"
check "window: Chrome is not quit (no pkill/killall of Chrome)" bash -c "! grep -qE 'pkill|kill' '$WSD/calls'"
check "window: rate-limit state written" test -s "$WS/window_open_Profile_2"
: > "$WSD/calls"
out="$(wg 2>&1)"
check "window: second tick within 30 min -> no launch (rate limit)" bash -c "! grep -q launchctl '$WSD/calls'"
echo $(( $(date +%s) - 1700 )) > "$WS/window_open_Profile_2"
wg >/dev/null 2>&1
check "window: 29 min after last -> still no launch" bash -c "! grep -q launchctl '$WSD/calls'"
echo $(( $(date +%s) - 1900 )) > "$WS/window_open_Profile_2"
wg >/dev/null 2>&1
check "window: 31 min after last -> launches again" grep -q launchctl "$WSD/calls"
wreset
STUB_LOADED="$WC/Profile 2/History" wg >/dev/null 2>&1
check "window: profile loaded (open file under its dir) -> no launch" bash -c "! grep -q launchctl '$WSD/calls'"
out="$(STUB_LOADED="$WC/Profile 2/History" wg --dry-run 2>&1)"
check "window: dry-run reports profile_loaded" has_text "$out" "no (profile_loaded) profile=Profile 2"
wreset
STUB_LOADED="$WC/Default/History" wg >/dev/null 2>&1
check "window: a different profile loaded does not count -> launch" grep -q launchctl "$WSD/calls"
wreset
STUB_LOADED="$WC/Profile 22/History" wg >/dev/null 2>&1
check "window: prefix-sibling dir (Profile 22) does not count as loaded" grep -q launchctl "$WSD/calls"
wreset
IDLE=599 wg >/dev/null 2>&1
check "window: idle 599 s -> no launch" bash -c "! grep -q launchctl '$WSD/calls'"
IDLE=600 wg >/dev/null 2>&1
check "window: idle exactly 600 s -> no launch" bash -c "! grep -q launchctl '$WSD/calls'"
IDLE=601 wg >/dev/null 2>&1
check "window: idle 601 s -> launch" grep -q launchctl "$WSD/calls"
wreset
STUB_CHROME=0 wg >/dev/null 2>&1
check "window: Chrome not running -> no launch, no lsof" bash -c "! grep -qE 'launchctl|lsof' '$WSD/calls'"
wreset
out="$(NK=1 wg 2>&1)"
check "window: NO_KILL=1 -> logs skipped, no launchctl" bash -c "grep -q 'window_open method=skipped profile=Profile 2' <<< \"\$1\" && ! grep -q launchctl '$WSD/calls'" _ "$out"
wreset
out="$(wg --dry-run 2>&1)"
check "window: dry-run -> would open, no launchctl, no state" bash -c "grep -q 'dry-run window: would open https://pulse.even.in/ in profile=Profile 2' <<< \"\$1\" && ! grep -q launchctl '$WSD/calls' && [ ! -e '$WS/window_open_Profile_2' ]" _ "$out"
wreset
STUB_LOADED="$WC/Default/History" wg >/dev/null 2>&1
check "window: lsof is given names-only flags and the Chrome pids" grep -qE 'lsof -nP -w -p 4242,4243 -Fn' "$WSD/calls"
cp "$WB/lsof" "$WB/lsof.orig"
wreset
STUB_LSOF_RC=1 STUB_LOADED="$WC/Profile 2/History" wg >/dev/null 2>&1
check "window: lsof rc=1 (a pid gone) with a loaded profile -> still no launch" bash -c "! grep -q launchctl '$WSD/calls'"
wreset
STUB_LSOF_EMPTY=1 STUB_LSOF_RC=1 wg >/dev/null 2>&1
check "window: lsof prints nothing -> fail closed, no launch" bash -c "! grep -q launchctl '$WSD/calls'"
wreset
out="$(STUB_LSOF_EMPTY=1 wg --dry-run 2>&1)"
check "window: dry-run reports lsof_unknown" has_text "$out" "no (lsof_unknown) profile=Profile 2"
wreset
rm -f "$WB/lsof"; wg >/dev/null 2>&1; cp "$WB/lsof.orig" "$WB/lsof"
check "window: lsof missing from PATH entry -> no launch" bash -c "! grep -q launchctl '$WSD/calls'"
# runtime proof that nothing inside a profile dir is opened: the files are FIFOs, a read would hang the tick
wreset
for f in Preferences Cookies "Login Data" History; do rm -f "$WC/Profile 2/$f"; mkfifo "$WC/Profile 2/$f"; done
cat > "$WB/lsof" <<'EOF2'
#!/bin/bash
echo p4242; echo n/dev/null
exit 0
EOF2
chmod +x "$WB/lsof"
check "window: FIFO Preferences/Cookies/Login Data/History in the profile dir -> tick finishes (nothing read)" bash -c "( wg >/dev/null 2>&1 ) & p=\$!; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do kill -0 \$p 2>/dev/null || exit 0; sleep 0.5; done; kill \$p; exit 1"
for f in Preferences Cookies "Login Data" History; do rm -f "$WC/Profile 2/$f"; done
cp "$WB/lsof.orig" "$WB/lsof"
check "window: guard never names Preferences/Cookies/Login Data/History" bash -c "! grep -E 'Preferences|Cookies|Login Data|/History' '$GUARD' | grep -qv 'Managed Preferences'"
check "window: post body carries kind=window_open" bash -c "grep -qF 'post_event \"window_open\" \"window_open\"' '$GUARD' && grep -qF '\"kind\":\"%s\"' '$GUARD'"

# 8b2. relaunch rung judges "missing" on the profiles Chrome reports open (Local State), else any-profile
HR="$tmp/Users-lsp"
PB_BASE() { printf '%s' "$HR/kiosk/Library/Application Support/Google/Chrome"; }
lsp_reset() { rm -rf "$HR"; mkdir -p "$(PB_BASE)"; rearm; }
lsp_prof() { mkdir -p "$(PB_BASE)/$1"; }                                  # profile dir, no extension
lsp_ext() { mkdir -p "$(PB_BASE)/$1/Extensions/$EXT/1.0.0_0"; }            # profile dir WITH extension version dir
lsp_state() { printf '%s' "$1" > "$(PB_BASE)/Local State"; }
lsp_json() { # lsp_json <last_active_profiles json array> [last_used]
  lsp_state "{\"other\":{\"SECRET_SENTINEL\":\"xyzzy\"},\"profile\":{\"last_active_profiles\":$1,\"last_used\":\"${2:-Default}\",\"info_cache\":{}}}"
}

# a. OPD 4 case: open profile lacks it, a stale one has it -> eligible
lsp_reset; lsp_prof "Profile 2"; lsp_ext "Profile 1"; lsp_json '["Profile 2"]' "Profile 2"
out="$(rl --dry-run 2>&1)"
check "profile gap (a): active Profile 2 lacks ext, stale Profile 1 has it -> would restart" has_text "$out" "dry-run relaunch: would restart Chrome"
check "profile gap (a): basis=active, profiles=Profile 2, missing=Profile 2" has_text "$out" "basis=active profiles=Profile 2 missing=Profile 2"
check "profile gap (a): Local State content never logged" no_text "$out" "SECRET_SENTINEL"
lsp_reset; lsp_prof "Profile 2"; lsp_ext "Profile 1"; lsp_json '["Profile 2"]' "Profile 2"
out="$(rl 2>&1)"
check "profile gap (a): real relaunch logs basis/profiles/missing" has_text "$out" "relaunch method=skipped basis=active profiles=Profile 2 missing=Profile 2"

# b. active profile has it -> not eligible
lsp_reset; lsp_ext "Profile 2"; lsp_prof "Profile 1"; lsp_json '["Profile 2"]' "Profile 2"
out="$(rl --dry-run 2>&1)"
check "profile gap (b): active profile has ext -> no (extension_present_active)" has_text "$out" "no (extension_present_active) basis=active profiles=Profile 2"

# c. two active profiles, only one has it -> eligible
lsp_reset; lsp_ext "Profile 1"; lsp_prof "Profile 2"; lsp_json '["Profile 1","Profile 2"]'
out="$(rl --dry-run 2>&1)"
check "profile gap (c): 2 active, only Profile 1 has ext -> would restart" has_text "$out" "dry-run relaunch: would restart Chrome"
check "profile gap (c): profiles joined, missing=Profile 2" has_text "$out" "basis=active profiles=Profile 1,Profile 2 missing=Profile 2"
lsp_reset; lsp_ext "Profile 1"; lsp_ext "Profile 2"; lsp_json '["Profile 1","Profile 2"]'
out="$(rl --dry-run 2>&1)"
check "profile gap (c2): 2 active, both have ext -> no (extension_present_active)" has_text "$out" "no (extension_present_active) basis=active profiles=Profile 1,Profile 2"

# d. no Local State -> old any-profile rule
lsp_reset; lsp_ext "Profile 1"; lsp_prof "Profile 2"
out="$(rl --dry-run 2>&1)"
check "profile gap (d): no Local State, a profile has ext -> no (extension_present), basis=fallback" has_text "$out" "no (extension_present) basis=fallback profiles=Profile 1"
lsp_reset; lsp_prof "Profile 1"
out="$(rl --dry-run 2>&1)"
check "profile gap (d2): no Local State, no ext anywhere -> would restart, basis=fallback" has_text "$out" "would restart Chrome as kiosk"
check "profile gap (d2): fallback basis shown" has_text "$out" "basis=fallback profiles=none missing=none"

# e. empty last_active_profiles -> last_used decides
lsp_reset; lsp_prof "Profile 2"; lsp_ext "Profile 1"; lsp_json '[]' "Profile 2"
out="$(rl --dry-run 2>&1)"
check "profile gap (e): empty last_active_profiles, last_used lacks ext -> would restart" has_text "$out" "dry-run relaunch: would restart Chrome"
check "profile gap (e): basis=active from last_used" has_text "$out" "basis=active profiles=Profile 2 missing=Profile 2"

# f. traversal and non-existent names are dropped -> fallback
lsp_reset; lsp_ext "Profile 1"; mkdir -p "$HR/kiosk/Library/Application Support/Google/evil/Extensions/$EXT/1.0"
lsp_json '["../evil"]' "../evil"
out="$(rl --dry-run 2>&1)"
check "profile gap (f1): ../evil dropped -> basis=fallback, Profile 1 has ext -> no" has_text "$out" "no (extension_present) basis=fallback profiles=Profile 1"
lsp_reset; lsp_ext "Profile 1"; lsp_json '["Profile 9"]' "Profile 9"
out="$(rl --dry-run 2>&1)"
check "profile gap (f2): Profile 9 (no dir) dropped -> basis=fallback" has_text "$out" "no (extension_present) basis=fallback profiles=Profile 1"
lsp_reset; lsp_prof "Profile 2"; lsp_ext "Profile 1"; lsp_json '["..","Profile 2","Profile 2","a/b"]' "."
out="$(rl --dry-run 2>&1)"
check "profile gap (f3): .. / a/b rejected, duplicates collapsed" has_text "$out" "basis=active profiles=Profile 2 missing=Profile 2"

# g. extension dir present but empty in the active profile -> eligible
lsp_reset; mkdir -p "$(PB_BASE)/Profile 2/Extensions/$EXT"; lsp_ext "Profile 1"; lsp_json '["Profile 2"]' "Profile 2"
out="$(rl --dry-run 2>&1)"
check "profile gap (g): empty ext dir in active profile -> would restart" has_text "$out" "dry-run relaunch: would restart Chrome"

# h. malformed Local State -> fallback, no abort, exit 0 (dry-run and real tick)
lsp_reset; lsp_ext "Profile 1"; lsp_state 'not json {{ SECRET_SENTINEL'
out="$(rl --dry-run 2>&1)"; rc=$?
check "profile gap (h): malformed Local State -> basis=fallback (old rule)" has_text "$out" "no (extension_present) basis=fallback profiles=Profile 1"
check "profile gap (h): exits 0, no error line, no content leaked" bash -c "[ $rc -eq 0 ] && ! grep -q 'error rc=' <<< \"\$1\" && ! grep -q SECRET_SENTINEL <<< \"\$1\"" _ "$out"
lsp_reset; lsp_prof "Profile 1"; lsp_state 'not json {{'
out="$(rl 2>&1)"; rc=$?
check "profile gap (h2): malformed + no ext, real tick still relaunches and exits 0" bash -c "[ $rc -eq 0 ] && grep -q 'relaunch method=skipped basis=fallback' <<< \"\$1\"" _ "$out"

# i. other gates unchanged: idle gate still blocks an otherwise eligible profile gap
lsp_reset; lsp_prof "Profile 2"; lsp_ext "Profile 1"; lsp_json '["Profile 2"]' "Profile 2"
out="$(IDLE=300 rl --dry-run 2>&1)"
check "profile gap (i): eligible profile gap still blocked by idle gate" has_text "$out" "no (not_idle_300s)"
HR="$tmp/Users"                                                    # restore for the sections below

# 8b3. Refuter F1/F2/F4
# F1: last_active_profiles yields no ACCEPTED name -> last_used decides
lsp_reset; lsp_prof "Profile 2"; lsp_ext "Profile 1"; lsp_json '["Profile 9"]' "Profile 2"
out="$(rl --dry-run 2>&1)"
check "F1: active=[Profile 9 (no dir)], last_used=Profile 2 lacks ext -> would restart" has_text "$out" "dry-run relaunch: would restart Chrome"
check "F1: basis=active from last_used" has_text "$out" "basis=active profiles=Profile 2 missing=Profile 2"
lsp_reset; lsp_prof "Profile 2"; lsp_ext "Profile 1"; lsp_json '["../evil"]' "Profile 2"
out="$(rl --dry-run 2>&1)"
check "F1: active=[../evil] rejected, last_used=Profile 2 used" has_text "$out" "basis=active profiles=Profile 2 missing=Profile 2"
lsp_reset; lsp_ext "Profile 2"; lsp_ext "Profile 1"; lsp_json '["Profile 9"]' "Profile 2"
out="$(rl --dry-run 2>&1)"
check "F1: last_used Profile 2 has ext -> no (extension_present_active)" has_text "$out" "no (extension_present_active) basis=active profiles=Profile 2"
# F2: dotfile-only extension dir counts as missing
lsp_reset; mkdir -p "$(PB_BASE)/Profile 2/Extensions/$EXT"; : > "$(PB_BASE)/Profile 2/Extensions/$EXT/.DS_Store"
lsp_ext "Profile 1"; lsp_json '["Profile 2"]' "Profile 2"
out="$(rl --dry-run 2>&1)"
check "F2: ext dir holding only .DS_Store -> missing -> would restart" has_text "$out" "dry-run relaunch: would restart Chrome"
lsp_reset; mkdir -p "$(PB_BASE)/Profile 2/Extensions/$EXT"; : > "$(PB_BASE)/Profile 2/Extensions/$EXT/.DS_Store"
mkdir -p "$(PB_BASE)/Profile 2/Extensions/$EXT/1.0.0_0"; lsp_json '["Profile 2"]' "Profile 2"
out="$(rl --dry-run 2>&1)"
check "F2: dotfile plus a real version dir -> present" has_text "$out" "no (extension_present_active)"
# F4: a name containing | must not drop another name
lsp_reset; lsp_prof "a|b"; lsp_prof "a"; lsp_ext "a|b"; lsp_json '["a|b","a"]' "a"
out="$(rl --dry-run 2>&1)"
check "F4: names 'a|b' and 'a' both kept (| is not a separator)" has_text "$out" "basis=active profiles=a|b,a missing=a"
lsp_reset; lsp_prof "x"; lsp_json '["x","x","x"]' "x"
out="$(rl --dry-run 2>&1)"
check "F4: exact duplicates still collapsed" has_text "$out" "basis=active profiles=x missing=x"
HR="$tmp/Users"

# 8c. boot race: re-check every BOOT_LOOP_SLEEP while uptime < 300 s, always terminates
P="$tmp/bl/com.google.Chrome.plist"; S="$tmp/bl-state"; rm -rf "$tmp/bl" "$S"
( while [ ! -e "$P" ]; do sleep 0.01; done; rm -f "$P" ) &       # simulate macOS wiping it after our write
wp=$!
out="$(UP=60 BLS=0.4 run_guard 2>&1)"
wait "$wp"
check "boot loop: wiped file rewritten (exactly 2 rewrites)" test "$(grep -c 'rewrite reason=boot' <<< "$out")" -eq 2
check "boot loop: entry present at exit" test "$(pb_get :ExtensionInstallForcelist:0)" = "$WANT"
rm -rf "$tmp/bl" "$S"
out="$(UP=60 BLS=0.05 run_guard 2>&1)"
check "boot loop: stable file -> single rewrite, then exits" test "$(grep -c 'rewrite reason=boot' <<< "$out")" -eq 1
rm -rf "$tmp/bl" "$S"
b=$(( $(date +%s) - 297 ))
( BOOT="{ sec = $b, usec = 1 } Mon Oct  5 00:00:00 2026" BLS=1 run_guard > "$tmp/bl2.out" 2>&1 ) &
gp=$!
( while kill -0 "$gp" 2>/dev/null; do rm -f "$P"; sleep 0.05; done ) &
t0=$(date +%s); wait "$gp"; dt=$(( $(date +%s) - t0 ))
check "boot loop: ends when uptime reaches 300 s even if file keeps vanishing (took ${dt}s)" test "$dt" -ge 1 -a "$dt" -le 12
check "boot loop: kept rewriting while it kept vanishing" test "$(grep -c 'rewrite reason=missing' "$tmp/bl2.out")" -ge 2
P="$tmp/bl3/com.google.Chrome.plist"; S="$tmp/bl3-state"
out="$(UP=60 run_guard --dry-run 2>&1)"
check "boot loop: dry-run reports but does not loop" has_text "$out" "dry-run boot-loop: uptime=60s"

# 8d. rewrite_failed posts capped at 3 per boot
rm -rf "$tmp/cap" "$S"; P="$tmp/cap/com.google.Chrome.plist"; S="$tmp/cap-state"; mkdir -p "$tmp/cap"
"$PB" -c "Add :ExtensionInstallForcelist array" -c "Add :ExtensionInstallForcelist:0 string other;https://x" "$P" >/dev/null 2>&1
bootA="{ sec = $(( $(date +%s) - 100000 )), usec = 1 } Mon Oct  5 00:00:00 2026"
bootB="{ sec = $(( $(date +%s) - 200000 )), usec = 1 } Sat Oct  3 00:00:00 2026"
all=""
for _ in 1 2 3 4 5; do all="$all$(BOOT="$bootA" PB=/usr/bin/false run_guard 2>&1)"$'\n'; done
check "failed-post cap: 5 failures log rewrite_failed 5 times" test "$(grep -c 'rewrite_failed reason=' <<< "$all")" -eq 5
check "failed-post cap: only 3 posts attempted" test "$(grep -c 'post status=skipped' <<< "$all")" -eq 3
check "failed-post cap: remaining 2 suppressed" test "$(grep -c 'post status=suppressed' <<< "$all")" -eq 2
out="$(BOOT="$bootB" PB=/usr/bin/false run_guard 2>&1)"
check "failed-post cap: a new boot resets the cap" has_text "$out" "post status=skipped"

# 9. fix 4/5: install.sh bootout wait, bootstrap retries, tty read (stubbed launchctl, INSTALL_ROOT sandbox)
BIN="$tmp/bin"; SD="$tmp/stub"; mkdir -p "$BIN" "$SD"
cat > "$BIN/launchctl" <<'EOF'
#!/bin/bash
echo "$1" >> "$STUB_DIR/calls"
bump() { local n; n=$(cat "$STUB_DIR/$1" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_DIR/$1"; echo "$n"; }
case "$1" in
  print) n=$(bump print_n); [ "$n" -le 2 ] ;;
  bootstrap) n=$(bump bootstrap_n); [ "$n" -gt "${STUB_BOOTSTRAP_FAILS:-0}" ] ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$BIN/launchctl"
# fixture token, built at runtime so secret scanners never see a literal
FAKE_TOK="tok_$(printf 'F%.0s' 1 2 3)fixture"
inst_run() { # inst_run <root> [env...]
  local r="$1"; shift
  printf '%s\n' "$FAKE_TOK" | env PATH="$BIN:$PATH" STUB_DIR="$SD" INSTALL_ROOT="$r" "$@" bash "$HERE/install.sh" --machine-id "$MID" 2>&1
}
rm -f "$SD"/*
out="$(inst_run "$tmp/ir1" STUB_BOOTSTRAP_FAILS=2 LAUNCHCTL="$BIN/launchctl")"; rc=$?
check "install: succeeds after 2 failed bootstraps" test "$rc" -eq 0
check "install: bootstrap called 3 times" test "$(grep -c '^bootstrap$' "$SD/calls")" -eq 3
check "install: polled print until gone (>=3 prints)" test "$(grep -c '^print$' "$SD/calls")" -ge 3
check "install: env file has machine id" grep -qx "MACHINE_ID=$MID" "$tmp/ir1/usr/local/etc/eta-presence-guard.env"
check "install: env file mode 600" test "$(stat -f %Lp "$tmp/ir1/usr/local/etc/eta-presence-guard.env")" = "600"
check "install: token never echoed" no_text "$out" "$FAKE_TOK"
rm -f "$SD"/*
out="$(inst_run "$tmp/ir2" STUB_BOOTSTRAP_FAILS=99 LAUNCHCTL="$BIN/launchctl")"; rc=$?
check "install: gives up (non-zero) after 3 failed bootstraps" test "$rc" -ne 0
check "install: exactly 3 bootstrap attempts, no more" test "$(grep -c '^bootstrap$' "$SD/calls")" -eq 3
rm -f "$SD"/*
rm -f "$SD"/*
out="$(inst_run "$tmp/ir4")"; rc=$?
check "install: INSTALL_ROOT alone succeeds without touching launchctl" test "$rc" -eq 0
check "install: INSTALL_ROOT alone never calls launchctl (stub on PATH untouched)" test ! -e "$SD/calls"
check "install: INSTALL_ROOT alone installs the files" test -x "$tmp/ir4/usr/local/libexec/eta-presence-guard.sh" -a -f "$tmp/ir4/Library/LaunchDaemons/com.eta.presence-guard.plist"
rm -f "$SD"/*
(sleep 1; printf '%s\n' "$FAKE_TOK"; sleep 1) | env PATH="$BIN:$PATH" STUB_DIR="$SD" INSTALL_ROOT="$tmp/ir3" \
  script -q /dev/null bash "$HERE/install.sh" --machine-id "$MID" >/dev/null 2>&1
check "install: tty path (read -rs) stores the token" grep -qx "INGEST_TOKEN=$FAKE_TOK" "$tmp/ir3/usr/local/etc/eta-presence-guard.env"
check "install: source uses read -rs behind a tty test" bash -c "grep -q 'if \[ -t 0 \]' '$HERE/install.sh' && grep -q 'read -rs' '$HERE/install.sh'"

# 10. no token literal / bearer secret in the repo files
check "no bearer secret literal in files" bash -c "! grep -E 'Bearer [A-Za-z0-9._~+/=-]{16,}' \"$HERE\"/*.sh \"$HERE\"/*.plist \"$HERE\"/README.md"

printf '\nSUMMARY: PASS=%d FAIL=%d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
