#!/bin/bash
# Test harness helpers. Fixtures only: nothing here touches a kiosk, a real TCC.db, or a real LaunchAgent.
# shellcheck disable=SC2034,SC2154
KDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0; FAILS=0
ok()   { PASS=$((PASS + 1)); }
fail() { FAILS=$((FAILS + 1)); echo "  FAIL: $*"; }
assert_eq()  { if [ "$1" = "$2" ]; then ok; else fail "$3: expected [$2] got [$1]"; fi; }
assert_has() { if printf '%s' "$1" | grep -q -- "$2"; then ok; else fail "$3: [$2] not found in [$(printf '%s' "$1" | head -c 300)]"; fi; }
assert_not() { if printf '%s' "$1" | grep -q -- "$2"; then fail "$3: [$2] unexpectedly present"; else ok; fi; }
assert_rc()  { if [ "$1" -eq "$2" ]; then ok; else fail "$3: rc expected $2 got $1"; fi; }
# line number of first line matching $2 in file $1 (0 if none)
lineno() { grep -n -- "$2" "$1" 2>/dev/null | head -n1 | cut -d: -f1 | sed 's/^$/0/'; }

ist_epoch() { TZ=Asia/Kolkata date -j -f '%Y-%m-%d %H:%M' "2026-10-14 $1" +%s; }

mk_sandbox() { # sets T and the whole environment; PATH gets the fake bin dir first
  T="$(mktemp -d "${SBROOT:-${TMPDIR:-/tmp}}/sb.XXXXXX")"
  export T
  export HOME="$T/home"; mkdir -p "$HOME/Library/LaunchAgents" "$T/bin" "$T/rr/captures" "$T/app/Contents/MacOS"
  export GUARDIAN_HOME="$HOME/Library/Application Support/EvenScribe/Guardian"
  export RR_ROOT="$T/rr" RR_PLIST="$HOME/Library/LaunchAgents/com.evenscribe.room-recorder.plist" RR_APP="$T/app"
  : >"$RR_PLIST"
  export GUARDIAN_ROOM="opd9"
  export GUARDIAN_TESTMODE=1   # library-test seam: GUARDIAN_FAKE_NOW is honoured only here; guardian.sh run|check never read it (R12)
  export GUARDIAN_TEST_ENTRY=1 # lets guardian.sh once|handle honour the environment; run|check ignore it
  export GUARDIAN_FAKE_NOW; GUARDIAN_FAKE_NOW="$(ist_epoch 11:00)"
  export CONFIRM_TIMEOUT_S=2 GUARDIAN_SETTLE_S=0 PROBE_CAP_S=1
  export GUARDIAN_PUBLISH_CMD='{ printf "%s\t" "$1"; cat; } >>"$T/pub.log"'
  export GUARDIAN_FLAG_CMD='cat "$T/flagout"; exit "$(cat "$T/flagrc")"'
  export GUARDIAN_SUDO="$T/bin/fakesudo"
  export GUARDIAN_TEST_DPRIME_HEAL=1   # test seam for 2.4 d' HEAL (the constant is 0 in run mode and in the shipped build); the d2 shadow test sets it to 0
  export GUARDIAN_ROOT_HELPER="$KDIR/bin/guardian-root.sh"
  export GUARDIAN_ROOT_TESTMODE=1 GUARDIAN_ROOT_TEST_DB="$T/TCC.db" GUARDIAN_ROOT_LOG_BIN="$T/bin/log"   # R16: the helper pins /usr/bin/log; its own test seam (non-root + test mode only)
  export GUARDIAN_LOG_BIN="$T/bin/fakelog" GUARDIAN_SHUTDOWN_BIN="$T/bin/fakeshutdown"   # /usr/bin/log and /sbin/shutdown are ALWAYS faked (2.4 d')
  export CANARY_AFPLAY="$T/bin/afplay" CANARY_SAMPLE_S=0 CANARY_PLAY_GAP_S=0   # afplay is always faked; no real sound
  export CALLS="$T/calls.log"; : >"$CALLS"
  : >"$T/pub.log"; printf 'fleet=off\n' >"$T/flagout"; echo 0 >"$T/flagrc"
  echo 4242 >"$T/rec_pid"; echo 9999 >"$T/ca_pid"; : >"$T/tapewriters"
  printf 'USB Audio C270 HD\n' >"$T/usb.txt"; printf 'C270 engine\n' >"$T/engine.txt"; echo 1000000000000 >"$T/hid"
  printf 'sleep 0\nautorestart 1\n' >"$T/pmset"
  export PATH="$T/bin:$PATH"
  mk_fakes
  mkdir -p "$GUARDIAN_HOME"
  write_status
  : >"$RR_ROOT/launchd.log"
}

mk_fakes() {
  local b="$T/bin"
  cat >"$b/fakesudo" <<'F'
#!/bin/bash
echo "SUDO $*" >>"$CALLS"; exec "$@"
F
  cat >"$b/launchctl" <<'F'
#!/bin/bash
echo "launchctl $*" >>"$CALLS"
case "$1" in
  print) [ -s "$T/rec_pid" ] && { echo "	pid = $(cat "$T/rec_pid")"; exit 0; } ; [ -e "$T/agent_loaded" ] && exit 0; exit 113 ;;
  bootstrap) [ -e "$T/boot_ok" ] && echo "microphone authorized" >>"$RR_ROOT/launchd.log"
             [ -e "$T/boot_fixes_mic" ] && sed -i '' -e 's/"mic_state":"denied"/"mic_state":"authorized"/' -e 's/"state":"mic_denied"/"state":"recording"/' "$RR_ROOT/status.json"
             [ -e "$T/boot_marks_loaded" ] && : >"$T/agent_loaded"; exit 0 ;;
esac
exit 0
F
  for n in killall pkill open; do printf '#!/bin/bash\necho "%s $*" >>"$CALLS"\nexit 0\n' "$n" >"$b/$n"; done
  cat >"$b/pgrep" <<'F'
#!/bin/bash
case "$*" in
  *coreaudiod*) cat "$T/ca_pid" ;;
  *"Google Chrome"*) [ -e "$T/chrome" ] && echo 777 || exit 1 ;;
  *tapewriter*) cat "$T/tapewriters" ;;
esac
exit 0
F
  cat >"$b/ps" <<'F'
#!/bin/bash
echo "   01:00"
F
  cat >"$b/ioreg" <<'F'
#!/bin/bash
case "$*" in
  *IOUSBHostDevice*) cat "$T/usb.txt" ;;
  *IOAudioEngine*) cat "$T/engine.txt" ;;
  *IOHIDSystem*) echo "    | |   \"HIDIdleTime\" = $(cat "$T/hid")" ;;
esac
F
  printf '#!/bin/bash\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/x 100 40 60 40%% /\\n"\n' >"$b/df"
  cat >"$b/sysctl" <<'F'
#!/bin/bash
echo "{ sec = $(( GUARDIAN_FAKE_NOW - ${FAKE_BOOT_AGE:-100000} )), usec = 0 }"
F
  cat >"$b/pmset" <<'F'
#!/bin/bash
echo "pmset $*" >>"$CALLS"; [ "$1" = "-g" ] && cat "$T/pmset"; exit 0
F
  printf '#!/bin/bash\nexit 1\n' >"$b/defaults"
  cat >"$b/system_profiler" <<'F'
#!/bin/bash
[ -n "$FAKE_SP_SLEEP" ] && sleep "$FAKE_SP_SLEEP"
if [ -e "$T/sp_no_out" ]; then echo '{"SPAudioDataType":[{"coreaudio_default_audio_input_device":"yes"}]}'; else echo '{"SPAudioDataType":[{"coreaudio_default_audio_input_device":"yes","coreaudio_default_audio_output_device":"yes"}]}'; fi
F
  printf '#!/bin/bash\necho "line from log"\n' >"$b/log"
  cat >"$b/fakelog" <<'F'
#!/bin/bash
echo "LOG $*" >>"$CALLS"
[ -s "$T/log_sleep" ] && sleep "$(cat "$T/log_sleep")"
[ -r "$T/log.txt" ] && cat "$T/log.txt"
exit "$(cat "$T/log_rc" 2>/dev/null || echo 0)"
F
  cat >"$b/fakeshutdown" <<'F'
#!/bin/bash
echo "SHUTDOWN $*" >>"$CALLS"
[ -s "$GUARDIAN_HOME/state/usb-reboot" ] && echo "SHUTDOWN_STATE_WRITTEN=yes" >>"$CALLS"
exit 0
F
  cat >"$b/afplay" <<'F'
#!/bin/bash
echo "afplay $*" >>"$CALLS"
# the tone is a 1 kHz sine whose RMS is the amp (peak amp*sqrt2), then 6 s of quiet at 100 RMS (the 10 s between plays); the quiet bed is the same 1 kHz sine at RMS 100
TAPE="$(ls -t "$RR_ROOT"/captures/*/seg_*/tape.pcm | head -n1)"
PERL_S='sub sn { my($r,$i)=@_; return int($r*1.41421356*sin(6.28318530718*$i/16)+($r>=0?0.5:-0.5)); }'
if [ -s "$T/afplay_lag" ]; then perl -e "$PERL_S"'my($lag,$a)=@ARGV; my $i=0; my @s; push @s,sn(100,$i++) for 1..($lag*16000); for my $b (1..3){ push @s,sn($a,$i++) for 1..8000; if ($b<3) { push @s,sn(100,$i++) for 1..8000 } } push @s,sn(100,$i++) for 1..8000; push @s,sn(100,$i++) for 1..96000; print pack("s<*",@s)' "$(cat "$T/afplay_lag")" "$(cat "$T/afplay_amp")" >>"$TAPE"
elif [ -s "$T/afplay_amp" ]; then perl -e "$PERL_S"'my $i=0; my @s; push @s,sn($ARGV[0],$i++) for 1..40000; push @s,sn(100,$i++) for 1..96000; print pack("s<*",@s)' "$(cat "$T/afplay_amp")" >>"$TAPE"; fi
exit "$(cat "$T/afplay_rc" 2>/dev/null || echo 0)"
F
  printf '#!/bin/bash\necho "room-recorder $*" >>"$CALLS"; exit 0\n' >"$T/app/Contents/MacOS/room-recorder"
  chmod +x "$b"/* "$T/app/Contents/MacOS/room-recorder"
}

# write_status [key=value ...]  (strings quoted unless true/false/number)
write_status() {
  local now="$GUARDIAN_FAKE_NOW" j k v
  declare_defaults() { :; }
  local now_poll="" s_state=recording s_mic=authorized s_cap=true s_pend=0 s_helper=true s_http=200 s_err="" s_extra=""
  for kv in "$@"; do
    k="${kv%%=*}"; v="${kv#*=}"
    case "$k" in state) s_state="$v" ;; mic_state) s_mic="$v" ;; capture_open) s_cap="$v" ;; pending) s_pend="$v" ;; helper) s_helper="$v" ;; http) s_http="$v" ;; err) s_err="$v" ;; extra) s_extra="$v" ;; poll_age) now_poll=$((GUARDIAN_FAKE_NOW - v)) ;; esac
  done
  j="{\"state\":\"$s_state\",\"mic_state\":\"$s_mic\",\"capture_open\":$s_cap,\"pending_piece_count\":$s_pend,\"helper_xpc_ok\":$s_helper,\"last_http\":$s_http,\"last_poll_ok_at\":${now_poll:-$((now - 5))},\"updated_at\":$now,\"last_error\":\"$s_err\"$s_extra}"
  printf '%s\n' "$j" >"$RR_ROOT/status.json"
  printf '{"install_id":"install_test123"}\n' >"$RR_ROOT/config.json"
}

# scratch TCC.db shaped like the real one; $1 = auth_value for the recorder row
mk_tcc() {
  rm -f "$T/TCC.db" "$GUARDIAN_HOME/state/tcc_row"
  sqlite3 "$T/TCC.db" "CREATE TABLE access (service TEXT, client TEXT, client_type INTEGER, auth_value INTEGER, auth_reason INTEGER, auth_version INTEGER, csreq BLOB, policy_id INTEGER, indirect_object_identifier_type INTEGER, indirect_object_identifier TEXT, indirect_object_code_identity BLOB, flags INTEGER, last_modified INTEGER);
    INSERT INTO access (service,client,client_type,auth_value,auth_reason,auth_version,last_modified) VALUES ('kTCCServiceMicrophone','com.evenscribe.room-recorder',0,$1,4,1,1000);
    INSERT INTO access (service,client,client_type,auth_value,auth_reason,auth_version,last_modified) VALUES ('kTCCServiceMicrophone','com.other.app',0,2,2,1,1000);"
}
tcc_val() { sqlite3 "$T/TCC.db" "SELECT auth_value FROM access WHERE client='com.evenscribe.room-recorder';"; }
other_val() { sqlite3 "$T/TCC.db" "SELECT auth_value||'|'||last_modified FROM access WHERE client='com.other.app';"; }

# heal mode: Mini says fleet=on, mode=heal, cache fresh
go_heal() { printf 'fleet=on\nmode=heal\n' >"$T/flagout"; echo 0 >"$T/flagrc"; flag_fetch; }
go_shadow() { printf 'fleet=on\nmode=shadow\n' >"$T/flagout"; echo 0 >"$T/flagrc"; flag_fetch; }

load_libs() {
  # shellcheck source=../lib/common.sh
  . "$KDIR/lib/common.sh"
  . "$KDIR/lib/collect.sh"
  . "$KDIR/lib/killswitch.sh"
  . "$KDIR/lib/faulttree.sh"
  . "$KDIR/lib/heal.sh"
  . "$KDIR/lib/probe.sh"
  . "$KDIR/lib/canary.sh"
  mkdir -p "$STATE_DIR" "$FLAG_DIR"
}

# 16 kHz mono s16le PCM of N samples at constant amplitude A, written fresh. perl is test-only.
mk_pcm() { # amplitude seconds
  local d="$RR_ROOT/captures/c1/seg_001"
  mkdir -p "$d"
  perl -e 'my($a,$s)=@ARGV; print pack("s<*", ($a) x ($s*16000))' "$1" "$2" >"$d/tape.pcm"
  touch -t "$(date -j -f %s "$GUARDIAN_FAKE_NOW" +%Y%m%d%H%M.%S)" "$d/tape.pcm"
}

# canary tape bed: a 1 kHz sine of RMS amplitude $1 (the same level as mk_pcm DC $1) for $2 s, so the band statistic has something to read
mk_pcm_tone() { # rms seconds
  local d="$RR_ROOT/captures/c1/seg_001"
  mkdir -p "$d"
  perl -e 'my($a,$s)=@ARGV; print pack("s<*", map { int($a*1.41421356*sin(6.28318530718*$_/16)+0.5) } 0..($s*16000-1))' "$1" "$2" >"$d/tape.pcm"
  touch -t "$(date -j -f %s "$GUARDIAN_FAKE_NOW" +%Y%m%d%H%M.%S)" "$d/tape.pcm"
}

# R16 (GR15-10): the Chrome day rule needs the consult hold CLEAR. consult_clear [age_s]: store a fresh new-form control payload with consult_open false for this room, as the control subscriber would.
consult_clear() {
  local age="${1:-1}"
  mkdir -p "$STATE_DIR"
  { printf '%s\n' "$((GUARDIAN_FAKE_NOW - age))"; printf '{"consult_open": {"%s": false}, "kill": false, "modes": {"%s": "heal"}, "ts": %s}\n' "$GUARDIAN_ROOM" "$GUARDIAN_ROOM" "$GUARDIAN_FAKE_NOW"; } >"$STATE_DIR/control.last"
  rm -f "$STATE_DIR/control_latch" "$STATE_DIR/control_state"
  export GUARDIAN_CONTROL_SUB_CMD='true'
}
events() { grep "^kiosk/$GUARDIAN_ROOM/heal$(printf '\t')" "$T/pub.log" 2>/dev/null; }

# reap_tracked <sandbox>: kill only the pids a test recorded in <sandbox>/*.pid, and only while they still look like what the test started
# (a sleep, or a guardian.sh). Never a pattern kill.
reap_tracked() {
  local f p c
  for f in "$1"/*.pid; do
    [ -e "$f" ] || continue
    for p in $(cat "$f" 2>/dev/null); do
      c="$(/bin/ps -o command= -p "$p" 2>/dev/null)"
      case "$c" in "sleep "*|*guardian.sh*) kill "$p" 2>/dev/null ;; esac
    done
  done
}

# teardown_sandbox <sandbox>: reap the test's own pids, give orphaned loops the 2 s they need to notice (they audit, and an audit recreates
# the sandbox path), then remove it. Retries until it stays gone (R11: no sandbox may be left behind).
teardown_sandbox() {
  local d="$1" i=0
  reap_tracked "$d"
  if ls "$d"/*.pid >/dev/null 2>&1; then sleep 3; fi
  while [ -e "$d" ] && [ "$i" -lt 10 ]; do rm -rf "$d"; [ -e "$d" ] && sleep 0.3; i=$((i + 1)); done
}
