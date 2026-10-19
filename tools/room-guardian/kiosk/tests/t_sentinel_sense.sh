#!/bin/bash
# shellcheck disable=SC2154,SC2059
# S2 Sense (read-only): zero_ratio_2s and peak_2s from the same pass as the rms, GUARDIAN_MIC_CLASS, install.sh --mic-class, and the three new health keys.
# PCM fixtures are generated here by bash/printf, no perl and no committed blobs.

# s16le_esc <value>: the two printf escapes of one signed 16-bit little-endian sample
s16le_esc() { local v=$(( $1 & 65535 )); printf '\\%03o\\%03o' $((v & 255)) $((v >> 8)); }

# mk_pcm_pat <seconds> <v1> <v2> ...: the pattern repeated to fill <seconds> of 16 kHz mono s16le, written fresh (mtime = the fake now)
mk_pcm_pat() {
  local secs="$1" pat="" v n reps unit="" i d="$RR_ROOT/captures/c1/seg_001"; shift
  n=$#
  for v in "$@"; do pat="$pat$(s16le_esc "$v")"; done
  reps=$((secs * 16000 / n))
  for ((i = 0; i < 100; i++)); do unit="$unit$pat"; done       # 100 patterns per chunk, then the chunk repeated
  mkdir -p "$d"; : >"$d/tape.pcm"
  for ((i = 0; i < reps / 100; i++)); do printf "$unit" >>"$d/tape.pcm"; done
  set_mtime "$d/tape.pcm" "$GUARDIAN_FAKE_NOW"
}
set_mtime() { touch -d "@$2" "$1" 2>/dev/null || touch -t "$(date -j -f %s "$2" +%Y%m%d%H%M.%S)" "$1"; }

# sense_env: on a host without BSD stat/date (Linux CI), a stat shim in the sandbox bin answers "-f %m" and "-f %z" as GNU stat would, and the fake clock is set directly.
# On macOS this does nothing.
sense_env() {
  if ! stat -f %m / >/dev/null 2>&1 || stat -f %m / 2>/dev/null | grep -q -v '^[0-9]*$'; then
    cat >"$T/bin/stat" <<'F'
#!/bin/bash
real=/usr/bin/stat
if [ "$1" = "-f" ] && [ "$2" = "%m" ]; then shift 2; exec $real -c %Y "$@"; fi
if [ "$1" = "-f" ] && [ "$2" = "%z" ]; then shift 2; exec $real -c %s "$@"; fi
exec $real "$@"
F
    chmod +x "$T/bin/stat"; hash -r
  fi
  case "${GUARDIAN_FAKE_NOW:-}" in ''|*[!0-9]*) GUARDIAN_FAKE_NOW=1792000000; export GUARDIAN_FAKE_NOW; write_status ;; esac
}

ZERO10="0 0 0 0 0 0 0 0 0 0"
NEAR10="0 0 0 0 0 0 0 0 30 -12"
SPEECH8="1000 -2000 3000 -1500 500 -4000 2500 -700"

test_stats_all_zero() {
  sense_env; load_libs
  # shellcheck disable=SC2086
  mk_pcm_pat 2 $ZERO10
  assert_eq "$(tape_stats_2s)" "-120.0 1.000 0.0000" "all-zero tape: -120 dBFS, zr 1.000, peak 0"
  assert_eq "$(rms_dbfs_2s)" "-120.0" "rms alone is unchanged"
}

test_stats_near_zero() {
  sense_env; load_libs
  # shellcheck disable=SC2086
  mk_pcm_pat 2 $NEAR10
  assert_eq "$(tape_stats_2s)" "-70.1 0.800 0.0009" "near-zero: zr 0.8, peak 30/32768"
}

test_stats_speech_like() {
  sense_env; load_libs
  # shellcheck disable=SC2086
  mk_pcm_pat 2 $SPEECH8
  assert_eq "$(tape_stats_2s)" "-23.4 0.000 0.1221" "speech-like: no exact zero, peak 4000/32768"
  assert_eq "$(rms_dbfs_2s)" "-23.4" "rms alone is unchanged"
}

test_stats_only_exact_zero_counts_as_zero() {
  sense_env; load_libs
  # +-1 dither is not digital silence: zr counts samples that are exactly 0 and nothing else
  # shellcheck disable=SC2086
  mk_pcm_pat 2 0 0 0 0 0 0 0 0 1 -1
  assert_eq "$(tape_stats_2s)" "-97.3 0.800 0.0000" "8 zeros of 10, the others are +-1"
}

test_stats_peak_divides_by_32768() {
  sense_env; load_libs
  # 444/32768 = 0.01355 rounds to 0.0135; 444/32767 would print 0.0136
  mk_pcm_pat 2 444 0 0 0 0 0 0 0 0 0
  assert_eq "$(tape_stats_2s)" "-47.4 0.900 0.0135" "peak is abs max over 32768"
}

test_stats_single_sample_edge() {
  sense_env; load_libs
  # one sample of exactly -32768: peak is 1.0000, never above
  mk_pcm_pat 1 -32768 -32768
  assert_eq "$(tape_stats_2s)" "0.0 0.000 1.0000" "full-scale negative"
}

test_stats_stale_missing_future_are_all_empty() {
  sense_env; load_libs
  # shellcheck disable=SC2086
  mk_pcm_pat 2 $NEAR10
  local f="$RR_ROOT/captures/c1/seg_001/tape.pcm"
  set_mtime "$f" $((GUARDIAN_FAKE_NOW - 60))
  assert_eq "$(tape_stats_2s)" "" "stale tape: all three empty"
  assert_eq "$(rms_dbfs_2s)" "" "stale tape: rms empty"
  set_mtime "$f" $((GUARDIAN_FAKE_NOW + 60))
  assert_eq "$(tape_stats_2s)" "" "future mtime: all three empty"
  rm -rf "$RR_ROOT/captures"; mkdir -p "$RR_ROOT/captures"
  assert_eq "$(tape_stats_2s)" "" "no capture: all three empty"
  collect_all
  assert_eq "$S_rms|$S_zr|$S_peak" "||" "collect_all keeps all three empty"
}

# the exact health line for a fixed snapshot; only the three new keys differ between cases
# sense_health: sets H to the health line of the sandbox snapshot (called in the test's own shell, so GUARDIAN_VERSION from the libs is visible to the caller)
sense_health() { sense_env; load_libs; go_shadow; collect_all; H="$(health_line)"; }
OLD_HEAD='{"room_id":"opd9","install_id":"install_test123","ts":__TS__,"state":"recording","mic_state":"authorized","capture_open":true,"pending_piece_count":0,'

test_health_line_exact_with_new_keys() {
  sense_env
  # shellcheck disable=SC2086
  mk_pcm_pat 2 $NEAR10
  sense_health; local h="$H"
  assert_has "$h" '"rms_dbfs_2s":-70.1,"usb_mic_present":true,"audio_engine_present":true,' "rms key and its neighbours unchanged"
  assert_eq "${h#*\"guardian\":}" "\"$GUARDIAN_VERSION\",\"zr\":0.800,\"peak\":0.0009,\"mic_class\":null}" "new keys sit last, after guardian"
  assert_eq "${h%%\"rms_dbfs_2s\"*}" "${OLD_HEAD/__TS__/$GUARDIAN_FAKE_NOW}" "keys before rms unchanged"
  assert_eq "$h" "$(printf '{"room_id":"opd9","install_id":"install_test123","ts":%s,"state":"recording","mic_state":"authorized","capture_open":true,"pending_piece_count":0,"rms_dbfs_2s":-70.1,"usb_mic_present":true,"audio_engine_present":true,"coreaudiod_age_s":60,"recorder_pid_age_s":60,"helper_xpc_ok":true,"last_poll_ok_age_s":5,"last_http":200,"disk_free_pct_root":60,"disk_free_pct_home":60,"boot_age_s":100000,"presence_heartbeat_age_s":null,"mode":"shadow","guardian":"%s","zr":0.800,"peak":0.0009,"mic_class":null}' "$GUARDIAN_FAKE_NOW" "$GUARDIAN_VERSION")" "exact health line"
}

test_health_line_stale_tape_gives_null_new_keys() {
  sense_env
  # shellcheck disable=SC2086
  mk_pcm_pat 2 $NEAR10
  set_mtime "$RR_ROOT/captures/c1/seg_001/tape.pcm" $((GUARDIAN_FAKE_NOW - 60))
  sense_health; local h="$H"
  assert_has "$h" '"rms_dbfs_2s":null,' "rms null"
  assert_eq "${h#*\"guardian\":}" "\"$GUARDIAN_VERSION\",\"zr\":null,\"peak\":null,\"mic_class\":null}" "zr and peak null on a stale tape"
}

test_health_line_zero_and_class() {
  sense_env
  # shellcheck disable=SC2086
  mk_pcm_pat 2 $ZERO10
  GUARDIAN_MIC_CLASS=tonor
  sense_health; local h="$H"
  assert_eq "${h#*\"guardian\":}" "\"$GUARDIAN_VERSION\",\"zr\":1.000,\"peak\":0.0000,\"mic_class\":\"tonor\"}" "all-zero tonor"
}

# ---- mic class in the conf ----
mc_conf() { # <line or empty>
  mkdir -p "$GUARDIAN_HOME"
  { printf 'GUARDIAN_ROOM="opd9"\n'; [ -z "${1:-}" ] || printf '%s\n' "$1"; [ -z "${2:-}" ] || printf '%s\n' "$2"; } >"$T/mc.conf"
}
mc_load() { . "$KDIR/lib/conf.sh"; GUARDIAN_MIC_CLASS=unknown; USB_MIC_PATTERN=C270; conf_load "$T/mc.conf" noperm; MC_RC=$?; }

test_conf_mic_class_values() {
  sense_env; load_libs
  mc_conf 'GUARDIAN_MIC_CLASS="webcam"'; mc_load
  assert_eq "$GUARDIAN_MIC_CLASS|$USB_MIC_PATTERN|$MC_RC" "webcam|C270|0" "webcam keeps C270"
  mc_conf 'GUARDIAN_MIC_CLASS=tonor'; mc_load
  assert_eq "$GUARDIAN_MIC_CLASS|$USB_MIC_PATTERN|$MC_RC" "tonor|TONOR|0" "tonor uses TONOR"
  mc_conf 'GUARDIAN_MIC_CLASS="tonor"' 'USB_MIC_PATTERN="X1"'; mc_load
  assert_eq "$GUARDIAN_MIC_CLASS|$USB_MIC_PATTERN|$MC_RC" "tonor|X1|0" "an explicit USB_MIC_PATTERN wins"
  mc_conf 'GUARDIAN_MIC_CLASS="tonor"' 'USB_MIC_PATTERN="C270"'; mc_load
  assert_eq "$GUARDIAN_MIC_CLASS|$USB_MIC_PATTERN|$MC_RC" "tonor|C270|0" "an explicit USB_MIC_PATTERN equal to the default still wins"
  mc_conf ''; mc_load
  assert_eq "$GUARDIAN_MIC_CLASS|$USB_MIC_PATTERN|$MC_RC" "unknown|C270|0" "missing is unknown"
  mc_conf 'GUARDIAN_MIC_CLASS="mixer"'; mc_load
  assert_eq "$GUARDIAN_MIC_CLASS|$USB_MIC_PATTERN|$MC_RC" "unknown|C270|0" "bad value is unknown and does not make the conf bad"
  mc_conf 'GUARDIAN_MIC_CLASS="Tonor"'; mc_load
  assert_eq "$GUARDIAN_MIC_CLASS|$MC_RC" "unknown|0" "the match is exact, case included"
  mc_conf 'GUARDIAN_MIC_CLASS=""'; mc_load
  assert_eq "$GUARDIAN_MIC_CLASS|$MC_RC" "unknown|0" "empty is unknown"
}

# ---- install.sh --mic-class ----
sense_inst() { GUARDIAN_ROOT_HELPER="$T/libexec/eta-guardian-root" LA_DIR="$HOME/Library/LaunchAgents" bash "$KDIR/install.sh" --room opd9 --sudo "$T/bin/fakesudo" "$@"; }

test_install_refuses_bad_mic_class() {
  rm -rf "$GUARDIAN_HOME"
  sense_inst --mic-class mixer >"$T/out" 2>&1; assert_rc $? 2 "bad class refused"
  assert_has "$(cat "$T/out")" "must be webcam or tonor" "clear error"
  sense_inst --mic-class >"$T/out" 2>&1; assert_rc $? 2 "missing class refused"
  sense_inst --mic-class "" >"$T/out" 2>&1; assert_rc $? 2 "empty class refused"
  [ ! -e "$GUARDIAN_HOME" ] && ok || fail "nothing installed after a refusal"
}

test_install_writes_mic_class() {
  # install.sh walks BSD ACLs and uses stat -f: it only runs on macOS
  [ "$(uname)" = Darwin ] || { echo "  SKIP install write (needs macOS)"; return 0; }
  rm -rf "$GUARDIAN_HOME"
  sense_inst --mic-class tonor >"$T/out" 2>&1; assert_rc $? 0 "install with tonor"
  assert_eq "$(grep -c '^GUARDIAN_MIC_CLASS=' "$GUARDIAN_HOME/guardian.conf")" "1" "one class line"
  assert_has "$(cat "$GUARDIAN_HOME/guardian.conf")" '^GUARDIAN_MIC_CLASS="tonor"$' "tonor written"
  sense_inst --mic-class webcam >"$T/out" 2>&1; assert_rc $? 0 "re-install with webcam"
  assert_eq "$(grep -c '^GUARDIAN_MIC_CLASS=' "$GUARDIAN_HOME/guardian.conf")" "1" "still one class line"
  assert_has "$(cat "$GUARDIAN_HOME/guardian.conf")" '^GUARDIAN_MIC_CLASS="webcam"$' "webcam replaced tonor"
  ( load_libs; . "$KDIR/lib/conf.sh"; audit() { :; }; conf_load "$GUARDIAN_HOME/guardian.conf" noperm ) && ok || fail "installed conf parses"
}

# ---- R2 fixes (F1 example conf, F2 unreadable conf, F3 temp cleanup, one class line) ----
test_example_conf_has_no_active_usb_pattern() {
  assert_eq "$(grep -c -E '^[[:space:]]*USB_MIC_PATTERN=' "$KDIR/guardian.conf.example")" "0" "no active USB_MIC_PATTERN in the example"
  sed "s/<room-slug>/opd9/" "$KDIR/guardian.conf.example" >"$T/mc.conf"; printf 'GUARDIAN_MIC_CLASS="tonor"\n' >>"$T/mc.conf"
  sense_env; load_libs; mc_load
  assert_eq "$GUARDIAN_MIC_CLASS|$USB_MIC_PATTERN|$MC_RC" "tonor|TONOR|0" "stub + tonor resolves to TONOR"
  sed "s/<room-slug>/opd9/" "$KDIR/guardian.conf.example" >"$T/mc.conf"; printf 'GUARDIAN_MIC_CLASS="webcam"\n' >>"$T/mc.conf"
  mc_load
  assert_eq "$GUARDIAN_MIC_CLASS|$USB_MIC_PATTERN|$MC_RC" "webcam|C270|0" "stub + webcam resolves to C270"
  sed "s/<room-slug>/opd9/" "$KDIR/guardian.conf.example" >"$T/mc.conf"; printf 'GUARDIAN_MIC_CLASS="tonor"\nUSB_MIC_PATTERN="X1"\n' >>"$T/mc.conf"
  mc_load
  assert_eq "$GUARDIAN_MIC_CLASS|$USB_MIC_PATTERN|$MC_RC" "tonor|X1|0" "an explicit pattern in a real conf still wins"
}

test_install_mic_class_refuses_unreadable_existing_conf() {
  rm -rf "$GUARDIAN_HOME"; mkdir -p "$GUARDIAN_HOME/guardian.conf"   # exists, not a readable file
  sense_inst --mic-class tonor >"$T/out" 2>&1; assert_rc $? 2 "directory conf refused"
  assert_has "$(cat "$T/out")" "not a readable file" "refusal names the conf"
  rm -rf "$GUARDIAN_HOME"; mkdir -p "$GUARDIAN_HOME"; ln -s "$T/nonexistent" "$GUARDIAN_HOME/guardian.conf"   # dangling link
  sense_inst --mic-class webcam >"$T/out" 2>&1; assert_rc $? 2 "dangling link conf refused"
  assert_has "$(cat "$T/out")" "not a readable file" "refusal names the conf (link)"
  [ -L "$GUARDIAN_HOME/guardian.conf" ] && [ ! -e "$GUARDIAN_HOME/bin" ] && ok || fail "nothing installed after the refusal"
}

test_install_mic_class_temp_removed_on_refusal() {
  rm -rf "$GUARDIAN_HOME"; mkdir -p "$T/tmpd"
  printf 'NOT_A_KEY=1\n' >"$T/bad.conf"
  TMPDIR="$T/tmpd" sense_inst --config "$T/bad.conf" --mic-class tonor >"$T/out" 2>&1; assert_rc $? 2 "bad config refused after the temp was made"
  assert_has "$(cat "$T/out")" "refusing: --config is not valid" "refused at the config check"
  assert_eq "$(find "$T/tmpd" -mindepth 1 | wc -l | tr -d ' ')" "0" "no temp file left in TMPDIR"
}

test_mic_class_set_leaves_exactly_one_line() {
  load_libs; . "$KDIR/lib/conf.sh"
  printf 'GUARDIAN_ROOM="opd9"\n# GUARDIAN_MIC_CLASS="webcam"\n' >"$T/a.conf"
  mic_class_set tonor <"$T/a.conf" >"$T/b.conf"
  mic_class_set webcam <"$T/b.conf" >"$T/c.conf"
  mic_class_set tonor <"$T/c.conf" >"$T/d.conf"
  assert_eq "$(grep -c -E '^GUARDIAN_MIC_CLASS=' "$T/d.conf")" "1" "one active class line after three installs"
  assert_has "$(cat "$T/d.conf")" '^GUARDIAN_MIC_CLASS="tonor"$' "the last class wins"
  assert_has "$(cat "$T/d.conf")" '^# GUARDIAN_MIC_CLASS="webcam"$' "comments are kept"
  printf 'GUARDIAN_MIC_CLASS="webcam"\nexport GUARDIAN_MIC_CLASS=tonor\n' | mic_class_set tonor >"$T/e.conf"
  assert_eq "$(grep -c 'GUARDIAN_MIC_CLASS=' "$T/e.conf")" "1" "active and exported lines both replaced"
}

# ---- R3: refuter R2 findings N1, M3, M9, M10 ----
r3_stub() { sed "s/<room-slug>/opd9/" "$KDIR/guardian.conf.example" >"$1"; }

test_install_config_dir_with_flag_refused() {   # N1: -r passes for a directory, cat fails; no class-only conf may reach the R12 check
  rm -rf "$GUARDIAN_HOME"; mkdir -p "$T/cdir" "$T/tmpd"
  TMPDIR="$T/tmpd" sense_inst --config "$T/cdir" --mic-class tonor >"$T/out" 2>&1; assert_rc $? 2 "--config directory with the flag refused"
  assert_has "$(cat "$T/out")" "cannot read --config" "the same refusal as without the flag"
  [ ! -e "$GUARDIAN_HOME/bin" ] && [ ! -e "$GUARDIAN_HOME/guardian.conf" ] && ok || fail "nothing installed"
  assert_eq "$(find "$T/tmpd" -mindepth 1 | wc -l | tr -d ' ')" "0" "no temp left"
  TMPDIR="$T/tmpd" sense_inst --config "$T/cdir" >"$T/out" 2>&1; assert_rc $? 2 "flag off: refused too"
}

test_install_level_class_dedup() {   # M3: install.sh itself must leave one class line (a duplicate would fail its own conf check)
  rm -rf "$GUARDIAN_HOME"; mkdir -p "$T/tmpd"
  r3_stub "$T/c.conf"; printf 'GUARDIAN_MIC_CLASS="webcam"\n' >>"$T/c.conf"
  TMPDIR="$T/tmpd" sense_inst --config "$T/c.conf" --mic-class tonor --dry-run >"$T/out" 2>&1
  assert_not "$(cat "$T/out")" "refusing: --config is not valid" "no duplicate class line"
  printf 'export GUARDIAN_MIC_CLASS=tonor\n' >>"$T/c.conf"   # the source itself has two class lines: the flag repairs it
  TMPDIR="$T/tmpd" sense_inst --config "$T/c.conf" --mic-class webcam --dry-run >"$T/out" 2>&1
  assert_not "$(cat "$T/out")" "refusing: --config is not valid" "no duplicate after two source lines"
  assert_eq "$(find "$T/tmpd" -mindepth 1 | wc -l | tr -d ' ')" "0" "TMPDIR empty after a dry run"
}

test_mic_class_set_indented_and_exported_lines() {   # M9: indented, tab and export class lines are replaced; a longer key is kept
  load_libs; . "$KDIR/lib/conf.sh"
  assert_eq "$(mic_class_set tonor </dev/null)" 'GUARDIAN_MIC_CLASS="tonor"' "empty input -> one line"
  assert_eq "$(printf 'GUARDIAN_ROOM="x"' | mic_class_set webcam | wc -l | tr -d ' ')" "2" "no trailing newline: the class line is kept apart"
  local o; o="$(printf 'GUARDIAN_MIC_CLASSX=1\n  GUARDIAN_MIC_CLASS=a\n\texport  GUARDIAN_MIC_CLASS=b\n' | mic_class_set tonor)"
  assert_eq "$(printf '%s\n' "$o" | grep -c 'GUARDIAN_MIC_CLASS=')" "1" "indented, tab and export lines removed"
  assert_has "$o" '^GUARDIAN_MIC_CLASSX=1$' "a longer key is kept"
}

test_install_mic_class_unreadable_regular_conf_refused() {   # M10: a regular file with mode 000 is refused; a readable conf and a readable link are accepted
  [ "$(id -u)" != 0 ] || { echo "  SKIP root reads anything"; return 0; }
  rm -rf "$GUARDIAN_HOME"; mkdir -p "$GUARDIAN_HOME" "$T/tmpd"; printf 'GUARDIAN_ROOM="real"\n' >"$GUARDIAN_HOME/guardian.conf"; chmod 000 "$GUARDIAN_HOME/guardian.conf"
  TMPDIR="$T/tmpd" sense_inst --mic-class tonor >"$T/out" 2>&1; assert_rc $? 2 "mode-000 conf refused with the flag"
  assert_has "$(cat "$T/out")" "not a readable file" "named"
  chmod 600 "$GUARDIAN_HOME/guardian.conf"; assert_eq "$(cat "$GUARDIAN_HOME/guardian.conf")" 'GUARDIAN_ROOM="real"' "conf untouched"
  [ ! -e "$GUARDIAN_HOME/bin" ] && ok || fail "nothing installed"
  assert_eq "$(find "$T/tmpd" -mindepth 1 | wc -l | tr -d ' ')" "0" "no temp left"
  rm -rf "$GUARDIAN_HOME"; mkdir -p "$GUARDIAN_HOME"; r3_stub "$GUARDIAN_HOME/guardian.conf"   # readable regular conf: accepted
  TMPDIR="$T/tmpd" sense_inst --mic-class tonor --dry-run >"$T/out" 2>&1; assert_not "$(cat "$T/out")" "not a readable file" "readable conf accepted"
  rm -rf "$GUARDIAN_HOME"; mkdir -p "$GUARDIAN_HOME"; r3_stub "$T/real.conf"; ln -s "$T/real.conf" "$GUARDIAN_HOME/guardian.conf"   # readable link: accepted
  TMPDIR="$T/tmpd" sense_inst --mic-class tonor --dry-run >"$T/out" 2>&1; assert_not "$(cat "$T/out")" "not a readable file" "readable link accepted"
}
