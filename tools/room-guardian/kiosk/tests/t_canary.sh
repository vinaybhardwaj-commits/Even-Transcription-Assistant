#!/bin/bash
# shellcheck disable=SC2030,SC2031
# FR1-C5 nightly canary. Clock and HID are injected (GUARDIAN_FAKE_NOW, the fake ioreg); afplay is the sandbox fake. No real sound, ever.
cn_events() { grep "^kiosk/$GUARDIAN_ROOM/canary$(printf '\t')" "$T/pub.log" 2>/dev/null; }
cn_plays() { grep -c '^afplay ' "$CALLS" 2>/dev/null; }

# cn_prep [HH:MM] : an eligible night, 10 s of quiet tape (amplitude 100, about -50 dBFS), HID idle 1000 s, recorder recording.
cn_prep() {
  load_libs; mk_fakes; echo 1000000000000 >"$T/hid"; rm -f "$T/afplay_amp" "$T/afplay_rc" "$T/sp_no_out"   # a clean slate: cases change fakes
  GUARDIAN_FAKE_NOW="$(ist_epoch "${1:-22:00}")"
  write_status; mk_pcm 100 10
  rm -rf "$STATE_DIR/once" "$STATE_DIR/canary_night" "$STATE_DIR/canary_last_play" "$STATE_DIR/actions"; rm -f "$T/afplay_lag"
  : >"$CALLS"; : >"$T/pub.log"
}
cn_run() { collect_all; canary_cycle; }

test_shadow_eligible_reports_would_do_and_never_plays() {
  cn_prep; go_shadow; cn_run
  assert_has "$(cn_events)" '"result":"would_do"' "would_do published"
  assert_has "$(cn_events)" '"action":"canary"' "action canary"
  assert_eq "$(cn_plays)" "0" "afplay never called in shadow"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" "would play canary" "audited"
  assert_eq "$(current_mode)" "shadow" "mode stays shadow"
  cn_run
  assert_eq "$(cn_events | wc -l | tr -d ' ')" "1" "one would_do per night"
}

test_kill_switch_on_never_plays_even_in_heal_mode() {
  cn_prep; go_heal; touch "$FLAG_DIR/heal-off"; cn_run
  assert_has "$(cn_events)" '"result":"would_do"' "would_do under the kill switch"
  assert_eq "$(cn_plays)" "0" "afplay never called with the kill switch on"
  cn_prep; cn_run   # no control at all = engaged
  assert_has "$(cn_events)" '"result":"would_do"' "would_do with no control"
  assert_eq "$(cn_plays)" "0" "afplay never called with no control"
}

test_heal_plays_once_per_night_at_volume_0_3() {
  cn_prep; go_heal; echo 1778 >"$T/afplay_amp"; cn_run
  assert_eq "$(cn_plays)" "1" "afplay called once"
  assert_has "$(grep '^afplay ' "$CALLS")" "-v 0.3 " "volume 0.3"
  assert_has "$(grep '^afplay ' "$CALLS")" "canary.wav" "the canary WAV"
  assert_not "$(cat "$CALLS")" "osascript" "system volume untouched"
  cn_run
  assert_eq "$(cn_plays)" "1" "second tick the same night: not called again"
  assert_eq "$(wc -l <"$STATE_DIR/actions" | tr -d ' ')" "1" "counted as one heal action (G6)"
}

test_night_key_spans_midnight() {
  cn_prep 22:00; go_heal; echo 1778 >"$T/afplay_amp"; cn_run
  assert_eq "$(cn_plays)" "1" "played at 22:00"
  GUARDIAN_FAKE_NOW="$(( $(ist_epoch 01:00) + 86400 ))"; go_heal; cn_run
  assert_eq "$(cn_plays)" "1" "01:00 is the same night"
  GUARDIAN_FAKE_NOW="$(( $(ist_epoch 22:00) + 86400 ))"; write_status; mk_pcm 100 10; go_heal; cn_run
  assert_eq "$(cn_plays)" "2" "the next evening is a new night"
}

# every D2 condition false -> not eligible, no would_do, no sound. Run in heal and shadow.
test_each_condition_false_is_not_eligible() {
  local c m
  for m in heal shadow; do
    for c in early late early_edge late_edge hid_active hid_unreadable not_recording tape_stale already_tonight heal_rate; do
      cn_prep; "go_$m"
      case "$c" in
        early) GUARDIAN_FAKE_NOW="$(ist_epoch 15:00)" ;;
        late) GUARDIAN_FAKE_NOW="$(ist_epoch 07:30)" ;;
        early_edge) GUARDIAN_FAKE_NOW="$(ist_epoch 21:34)" ;;
        late_edge) GUARDIAN_FAKE_NOW="$(ist_epoch 07:00)" ;;
        hid_active) echo 5000000000 >"$T/hid" ;;
        hid_unreadable) printf '#!/bin/bash\nexit 1\n' >"$T/bin/ioreg"; chmod +x "$T/bin/ioreg" ;;
        not_recording) write_status state=mic_denied ;;
        tape_stale) touch -t 202610140000 "$RR_ROOT"/captures/c1/seg_001/tape.pcm ;;
        already_tonight) canary_night_key >"$CANARY_NIGHT_FILE" ;;
        heal_rate) printf '%s a:b\n%s a:b\n%s a:b\n' "$GUARDIAN_FAKE_NOW" "$GUARDIAN_FAKE_NOW" "$GUARDIAN_FAKE_NOW" >"$STATE_DIR/actions" ;;
      esac
      [ "$c" = early ] || [ "$c" = late ] || [ "$c" = early_edge ] || [ "$c" = late_edge ] && { write_status; mk_pcm 100 10; }
      cn_run
      assert_eq "$(cn_events | wc -l | tr -d ' ')" "0" "$m/$c: no canary event"
      assert_eq "$(cn_plays)" "0" "$m/$c: no sound"
      canary_eligible; assert_rc $? 1 "$m/$c: not eligible"
    done
  done
  # the two window edges that are inside
  for c in 21:35 06:59; do
    cn_prep "$c"; go_shadow; cn_run
    assert_has "$(cn_events)" '"result":"would_do"' "$c is eligible"
  done
}

test_wav_is_a_48k_mono_tone_of_three_bursts() {
  load_libs
  local w="$T/c.wav" segs
  canary_make_wav "$w"
  assert_eq "$(wc -c <"$w" | tr -d ' ')" "240044" "file size 44 + 240000"
  assert_eq "$(head -c 4 "$w")" "RIFF" "RIFF"
  assert_eq "$(od -An -c -j8 -N8 "$w" | tr -d ' ')" "WAVEfmt" "WAVE fmt"
  assert_eq "$(od -An -t u4 -j4 -N4 "$w" | tr -d ' ')" "240036" "RIFF size"
  assert_eq "$(od -An -t u2 -j20 -N2 "$w" | tr -d ' ')" "1" "PCM"
  assert_eq "$(od -An -t u2 -j22 -N2 "$w" | tr -d ' ')" "1" "mono"
  assert_eq "$(od -An -t u4 -j24 -N4 "$w" | tr -d ' ')" "48000" "sample rate"
  assert_eq "$(od -An -t u4 -j28 -N4 "$w" | tr -d ' ')" "96000" "byte rate"
  assert_eq "$(od -An -t u2 -j34 -N2 "$w" | tr -d ' ')" "16" "16 bit"
  assert_eq "$(od -An -c -j36 -N4 "$w" | tr -d ' ')" "data" "data chunk"
  assert_eq "$(od -An -t u4 -j40 -N4 "$w" | tr -d ' ')" "240000" "data size"
  # five half-second segments of 24000 samples: peak per segment
  segs="$(od -An -v -t d2 -j44 "$w" | awk '{ for (i = 1; i <= NF; i++) { s = int(n / 24000); v = $i < 0 ? -$i : $i; if (v > m[s]) m[s] = v; n++ } } END { printf "%d %d %d %d %d n=%d", m[0], m[1], m[2], m[3], m[4], n }')"
  assert_eq "$segs" "16000 0 16000 0 16000 n=120000" "burst, gap, burst, gap, burst"
  # 1 kHz: one cycle is 48 samples, so sample 12 is the peak and sample 24 a zero crossing
  assert_eq "$(od -An -v -t d2 -j$((44 + 24)) -N2 "$w" | tr -d ' ')" "16000" "sample 12 is the peak"
  assert_eq "$(od -An -v -t d2 -j$((44 + 48)) -N2 "$w" | tr -d ' ')" "0" "sample 24 crosses zero"
}

test_confirm_plus_25_db_is_pass() {
  cn_prep; go_heal; echo 1778 >"$T/afplay_amp"; cn_run
  assert_has "$(cn_events)" '"result":"pass"' "pass"
  assert_has "$(cn_events)" '"rise_db":2[45]\.' "rise about 25 dB"
  assert_not "$(cn_events)" 'RIFF' "G9 no audio in the event"
}

test_confirm_plus_10_db_is_no_local_rise() {
  cn_prep; go_heal; echo 316 >"$T/afplay_amp"; cn_run
  assert_has "$(cn_events)" '"result":"no_local_rise"' "no_local_rise"
  assert_has "$(cn_events)" '"rise_db":\(9\|10\)\.' "rise about 10 dB"
}

test_confirm_no_rise_is_no_local_rise() {
  cn_prep; go_heal; echo 100 >"$T/afplay_amp"; cn_run
  assert_has "$(cn_events)" '"result":"no_local_rise"' "same level = no local rise"
}

test_confirm_output_absent_is_inconclusive() {
  cn_prep; go_heal; touch "$T/sp_no_out"; echo 1778 >"$T/afplay_amp"; cn_run
  assert_has "$(cn_events)" '"result":"inconclusive:output_absent"' "no output device"
  assert_has "$(cn_events)" '"output":"absent"' "output field"
  assert_eq "$(cn_plays)" "0" "nothing played to a missing device"
  cn_prep 22:00; rm -f "$T/sp_no_out"; echo 3 >"$T/afplay_rc"; go_heal; cn_run
  assert_has "$(cn_events)" '"result":"inconclusive:afplay_error"' "afplay fails"
  assert_has "$(cn_events)" '"output":"present"' "output field present"
}

test_confirm_tape_stalled_is_inconclusive() {
  cn_prep; go_heal; rm -f "$T/afplay_amp"; cn_run
  assert_has "$(cn_events)" '"result":"inconclusive:tape_stalled"' "tape did not advance"
}

# ---- R12 / C5 fixes ----
cn_fake_sp_sets_heal_off() { printf '#!/bin/bash\n: >"%s/flags/heal-off"\necho "{\\"SPAudioDataType\\":[{\\"coreaudio_default_audio_output_device\\":\\"yes\\"}]}"\n' "$GUARDIAN_HOME" >"$T/bin/system_profiler"; chmod +x "$T/bin/system_profiler"; }

test_direct_call_in_shadow_makes_no_afplay_call() {
  cn_prep; go_shadow; echo 1778 >"$T/afplay_amp"
  ACT_LAYER=canary; canary_play_and_confirm
  assert_eq "$(cn_plays)" "0" "canary_play_and_confirm in SHADOW: 0 plays"
  assert_has "$(cn_events)" '"result":"would_do"' "reported as would_do"
}

test_kill_engaged_during_the_output_check_makes_no_play() {
  cn_prep; go_heal; echo 1778 >"$T/afplay_amp"; cn_fake_sp_sets_heal_off
  cn_run
  [ -e "$FLAG_DIR/heal-off" ] && ok || fail "the fake output check set heal-off"
  assert_eq "$(cn_plays)" "0" "kill engaged after act_step, before afplay: 0 plays"
}

test_burst_found_at_any_tape_lag() {
  local lag
  for lag in 0 1 2 3; do
    cn_prep; go_heal; echo 1778 >"$T/afplay_amp"; echo "$lag" >"$T/afplay_lag"; cn_run
    assert_has "$(cn_events)" '"result":"pass"' "lag ${lag}s passes"
  done
}

test_volume_must_be_a_decimal_in_0_to_0_5() {
  local v
  for v in 0 0.0 0.00 0.51 0.6 1 1.0 abc "0.3 -x" "" -0.2 .3 0.123; do
    cn_prep; go_heal; echo 1778 >"$T/afplay_amp"; CANARY_VOLUME="$v"; cn_run
    assert_eq "$(cn_plays)" "0" "volume [$v]: no play"
    assert_has "$(cn_events)" 'inconclusive:bad_volume' "volume [$v]: reported"
  done
  for v in 0.3 0.5 0.05 0.1; do
    cn_prep; go_heal; echo 1778 >"$T/afplay_amp"; CANARY_VOLUME="$v"; cn_run
    assert_eq "$(cn_plays)" "1" "volume [$v]: plays"
  done
}

test_night_state_fails_closed() {
  local c
  for c in garbage empty dir unreadable future short; do
    cn_prep; go_heal; echo 1778 >"$T/afplay_amp"; rm -rf "$CANARY_NIGHT_FILE"
    case "$c" in
      garbage) echo "garbage" >"$CANARY_NIGHT_FILE" ;;
      empty) : >"$CANARY_NIGHT_FILE" ;;
      dir) mkdir "$CANARY_NIGHT_FILE" ;;
      unreadable) canary_night_key >"$CANARY_NIGHT_FILE"; echo 19990101 >"$CANARY_NIGHT_FILE"; chmod 000 "$CANARY_NIGHT_FILE" ;;
      future) echo 20991231 >"$CANARY_NIGHT_FILE" ;;
      short) echo 2026101 >"$CANARY_NIGHT_FILE" ;;
    esac
    cn_run
    assert_eq "$(cn_plays)" "0" "state $c: no play"
    assert_has "$(cn_events)" 'inconclusive:state_' "state $c: reported"
    chmod 600 "$CANARY_NIGHT_FILE" 2>/dev/null; rm -rf "$CANARY_NIGHT_FILE"
  done
  # an older night is fine
  cn_prep; go_heal; echo 1778 >"$T/afplay_amp"; echo 20200101 >"$CANARY_NIGHT_FILE"; cn_run
  assert_eq "$(cn_plays)" "1" "an older night plays"
  assert_eq "$(cat "$CANARY_NIGHT_FILE")" "$(canary_night_key)" "night written"
  assert_eq "$(cat "$CANARY_LAST_FILE")" "$GUARDIAN_FAKE_NOW" "last-play epoch written"
}

test_no_second_play_within_12_h_of_the_last() {
  cn_prep; go_heal; echo 1778 >"$T/afplay_amp"
  echo "$((GUARDIAN_FAKE_NOW - 3600))" >"$CANARY_LAST_FILE"; cn_run
  assert_eq "$(cn_plays)" "0" "1 h after a play: refused"
  assert_has "$(cn_events)" 'inconclusive:state_recent_play' "reported"
  cn_prep; go_heal; echo 1778 >"$T/afplay_amp"; echo "$((GUARDIAN_FAKE_NOW + 3600))" >"$CANARY_LAST_FILE"; cn_run
  assert_eq "$(cn_plays)" "0" "a last play in the future (clock went back): refused"
  cn_prep; go_heal; echo 1778 >"$T/afplay_amp"; echo "junk" >"$CANARY_LAST_FILE"; cn_run
  assert_eq "$(cn_plays)" "0" "garbage last-play: refused"
  cn_prep; go_heal; echo 1778 >"$T/afplay_amp"; echo "$((GUARDIAN_FAKE_NOW - 44000))" >"$CANARY_LAST_FILE"; cn_run
  assert_eq "$(cn_plays)" "1" "over 12 h: plays"
}

test_state_that_cannot_be_written_means_no_play() {
  cn_prep; go_heal; echo 1778 >"$T/afplay_amp"; mkdir "$CANARY_LAST_FILE"
  cn_run
  assert_eq "$(cn_plays)" "0" "last-play path is a directory: no play"
}

test_canary_constants_are_not_settable_from_the_environment() {
  local out
  out="$( CANARY_START=0000 CANARY_END=2359 CANARY_IDLE_MIN_S=0 HEAL_MAX_PER_HOUR=99 G_RUNMODE=1; . "$KDIR/lib/common.sh"; echo "$CANARY_START $CANARY_END $CANARY_IDLE_MIN_S $HEAL_MAX_PER_HOUR" )"
  assert_eq "$out" "2135 0700 600 3" "run mode"
  out="$( CANARY_START=0000 CANARY_END=2359 CANARY_IDLE_MIN_S=0 HEAL_MAX_PER_HOUR=99; . "$KDIR/lib/common.sh"; echo "$CANARY_START $CANARY_END $CANARY_IDLE_MIN_S $HEAL_MAX_PER_HOUR" )"
  assert_eq "$out" "2135 0700 600 3" "library tests too"
}

# run and once never honour CANARY_AFPLAY / TESTMODE: the tone goes to the pinned afplay path only. A fake /usr/bin is impossible here, so the check
# is on the code path: the variable that reaches run_capped, with G_RUNMODE=1 and with every seam set.
test_run_mode_never_uses_the_afplay_seam() {
  cn_prep; go_heal; echo 1778 >"$T/afplay_amp"
  printf '#!/bin/bash\necho "PINNED-CALL $*" >>"%s/pinned_calls"\n' "$T" >"$T/pinned_afplay"; chmod +x "$T/pinned_afplay"
  G_AFPLAY="$T/pinned_afplay"
  # every seam set, run mode on: the tone must go to the pinned path and never to the CANARY_AFPLAY fake
  ( G_RUNMODE=1; GUARDIAN_TESTMODE=1; CANARY_AFPLAY="$T/bin/afplay"; act_step() { return 0; }; canary_play_and_confirm ) >/dev/null 2>&1
  assert_eq "$(cn_plays)" "0" "the seam fake (CANARY_AFPLAY) was not called in run mode"
  assert_eq "$(grep -c PINNED-CALL "$T/pinned_calls" 2>/dev/null || echo 0)" "1" "only the pinned afplay path was used"
  # and outside run mode (the test harness) the seam is the fake, so a test can never reach the real afplay
  : >"$CALLS"; rm -f "$T/pinned_calls"
  ( GUARDIAN_TESTMODE=1; CANARY_AFPLAY="$T/bin/afplay"; act_step() { return 0; }; canary_play_and_confirm ) >/dev/null 2>&1
  assert_eq "$(cn_plays)" "1" "test mode uses the fake"
  assert_eq "$(ls "$T/pinned_calls" 2>/dev/null | wc -l | tr -d ' ')" "0" "and not the pinned path"
  assert_eq "$(grep -v '^[[:space:]]*#' "$KDIR/lib/canary.sh" | grep 'CANARY_AFPLAY' | grep -vc 'G_RUNMODE')" "0" "every CANARY_AFPLAY read has the run-mode gate"
  assert_has "$(grep -n 'unset GUARDIAN_TESTMODE' "$KDIR/bin/guardian.sh")" "CANARY_AFPLAY" "the run-mode preamble unsets it (run, check, once and handle without the test marker)"
  assert_eq "$(grep -c '/usr/bin/afplay' "$KDIR/lib/canary.sh")" "1" "one pinned afplay path"
}

test_unreadable_directory_and_garbage_actions_log_count_as_cap_reached() {
  load_libs; mkdir -p "$STATE_DIR"
  rm -rf "$ACTIONS_FILE"
  assert_eq "$(actions_last_hour)" "0" "no file: 0"
  printf '%s a:b\n' "$GUARDIAN_FAKE_NOW" >"$ACTIONS_FILE"
  assert_eq "$(actions_last_hour)" "1" "one recent line"
  chmod 000 "$ACTIONS_FILE"
  assert_eq "$(actions_last_hour)" "$HEAL_MAX_PER_HOUR" "unreadable: cap reached"
  chmod 600 "$ACTIONS_FILE"; rm -f "$ACTIONS_FILE"; mkdir "$ACTIONS_FILE"
  assert_eq "$(actions_last_hour)" "$HEAL_MAX_PER_HOUR" "directory: cap reached"
  rmdir "$ACTIONS_FILE"
  printf 'junk\n\nxx yy\n' >"$ACTIONS_FILE"
  assert_eq "$(actions_last_hour)" "3" "garbage lines count as recent actions"
  printf '1 old\n' >"$ACTIONS_FILE"
  assert_eq "$(actions_last_hour)" "0" "an old epoch does not count"
  # and the cap really stops an action
  rmdir "$ACTIONS_FILE" 2>/dev/null; rm -rf "$ACTIONS_FILE"; mkdir "$ACTIONS_FILE"
  go_heal; act_begin x y z; assert_rc $? 1 "act_begin refuses with an unreadable log"
  rmdir "$ACTIONS_FILE"
}

test_tape_with_a_future_mtime_is_not_advancing() {
  cn_prep; touch -t 203012010000 "$RR_ROOT"/captures/c1/seg_001/tape.pcm
  assert_eq "$(rms_dbfs_2s)" "" "future mtime: no rms"
}

# ---- R13 S4: the control.last / GUARDIAN_CONTROL_SUB_CMD path (the production path), not only the old flag command ----
# cn_ctl <age s> [mode] [kill]: control.last received <age> s ago at the fake clock, canonical form, then the fetch the main loop would run.
cn_ctl() {
  local recv=$((GUARDIAN_FAKE_NOW - $1))
  GUARDIAN_CONTROL_SUB_CMD=true
  rm -f "$STATE_DIR/control_latch" "$STATE_DIR/control_state"
  { printf '%s\n' "$recv"; printf '{"kill": %s, "modes": {"opd9": "%s"}, "ts": %s}\n' "${3:-false}" "${2:-heal}" "$recv"; } >"$STATE_DIR/control.last"
  flag_fetch
}

test_control_path_fresh_heal_plays_once() {
  cn_prep; echo 1778 >"$T/afplay_amp"; cn_ctl 5 heal; cn_run
  assert_eq "$(cn_plays)" "1" "control.last fresh heal: 1 play"
  assert_has "$(cn_events)" '"result":"pass"' "pass"
}

test_control_path_age_90_plays_age_91_does_not() {
  cn_prep; echo 1778 >"$T/afplay_amp"; cn_ctl 90 heal; cn_run
  assert_eq "$(cn_plays)" "1" "age 90 s: 1 play"
  cn_prep; echo 1778 >"$T/afplay_amp"; cn_ctl 91 heal; cn_run
  assert_eq "$(cn_plays)" "0" "age 91 s: 0 plays"
  assert_has "$(cn_events)" '"result":"would_do"' "age 91 s: reported as would_do"
}

test_control_path_shadow_kill_and_heal_off_never_play() {
  cn_prep; echo 1778 >"$T/afplay_amp"; cn_ctl 5 shadow; cn_run
  assert_eq "$(cn_plays)" "0" "mode shadow: 0 plays"
  assert_has "$(cn_events)" '"result":"would_do"' "shadow: would_do"
  cn_prep; echo 1778 >"$T/afplay_amp"; cn_ctl 5 heal true; cn_run
  assert_eq "$(cn_plays)" "0" "kill true: 0 plays"
  cn_prep; echo 1778 >"$T/afplay_amp"; cn_ctl 5 heal; touch "$FLAG_DIR/heal-off"; cn_run
  assert_eq "$(cn_plays)" "0" "heal-off flag: 0 plays"
  cn_prep; echo 1778 >"$T/afplay_amp"; rm -f "$STATE_DIR/control.last"; GUARDIAN_CONTROL_SUB_CMD=true; flag_fetch; cn_run
  assert_eq "$(cn_plays)" "0" "no control message at all: 0 plays"
}

test_control_path_flip_during_the_output_check_makes_no_play() {
  local flip
  # the fake output check rewrites control.last (a kill, then a message that is already 91 s old) after act_step and before afplay
  for flip in kill stale shadow; do
    cn_prep; echo 1778 >"$T/afplay_amp"; cn_ctl 5 heal
    case "$flip" in
      kill) body="printf '%s\\n{\"kill\": true, \"modes\": {\"opd9\": \"heal\"}, \"ts\": %s}\\n' $((GUARDIAN_FAKE_NOW)) $((GUARDIAN_FAKE_NOW))" ;;
      stale) body="printf '%s\\n{\"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": %s}\\n' $((GUARDIAN_FAKE_NOW - 91)) $((GUARDIAN_FAKE_NOW - 91))" ;;
      shadow) body="printf '%s\\n{\"kill\": false, \"modes\": {\"opd9\": \"shadow\"}, \"ts\": %s}\\n' $((GUARDIAN_FAKE_NOW)) $((GUARDIAN_FAKE_NOW))" ;;
    esac
    printf '#!/bin/bash\n%s >"%s/control.last"\nrm -f "%s/control_latch"\necho "{\\"SPAudioDataType\\":[{\\"coreaudio_default_audio_output_device\\":\\"yes\\"}]}"\n' "$body" "$STATE_DIR" "$STATE_DIR" >"$T/bin/system_profiler"
    chmod +x "$T/bin/system_profiler"
    cn_run
    assert_eq "$(cn_plays)" "0" "control flip ($flip) during the output check: 0 plays"
  done
}
