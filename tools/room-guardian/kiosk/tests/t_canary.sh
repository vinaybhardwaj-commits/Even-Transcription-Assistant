#!/bin/bash
# FR1-C5 nightly canary. Clock and HID are injected (GUARDIAN_FAKE_NOW, the fake ioreg); afplay is the sandbox fake. No real sound, ever.
cn_events() { grep "^kiosk/$GUARDIAN_ROOM/canary$(printf '\t')" "$T/pub.log" 2>/dev/null; }
cn_plays() { grep -c '^afplay ' "$CALLS" 2>/dev/null; }

# cn_prep [HH:MM] : an eligible night, 10 s of quiet tape (amplitude 100, about -50 dBFS), HID idle 1000 s, recorder recording.
cn_prep() {
  load_libs; mk_fakes; echo 1000000000000 >"$T/hid"; rm -f "$T/afplay_amp" "$T/afplay_rc" "$T/sp_no_out"   # a clean slate: cases change fakes
  GUARDIAN_FAKE_NOW="$(ist_epoch "${1:-22:00}")"
  write_status; mk_pcm 100 10
  rm -f "$STATE_DIR/canary_night" "$STATE_DIR/actions"
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

test_confirm_plus_10_db_is_fail_capture() {
  cn_prep; go_heal; echo 316 >"$T/afplay_amp"; cn_run
  assert_has "$(cn_events)" '"result":"fail_capture"' "fail_capture"
  assert_has "$(cn_events)" '"rise_db":\(9\|10\)\.' "rise about 10 dB"
}

test_confirm_no_rise_is_fail_capture() {
  cn_prep; go_heal; echo 100 >"$T/afplay_amp"; cn_run
  assert_has "$(cn_events)" '"result":"fail_capture"' "same level = no local rise"
}

test_confirm_output_absent_is_inconclusive() {
  cn_prep; go_heal; touch "$T/sp_no_out"; echo 1778 >"$T/afplay_amp"; cn_run
  assert_has "$(cn_events)" '"result":"inconclusive:output_muted"' "no output device"
  assert_eq "$(cn_plays)" "0" "nothing played to a missing device"
  cn_prep 22:00; rm -f "$T/sp_no_out"; echo 3 >"$T/afplay_rc"; go_heal; cn_run
  assert_has "$(cn_events)" '"result":"inconclusive:output_muted"' "afplay fails"
}

test_confirm_tape_stalled_is_inconclusive() {
  cn_prep; go_heal; rm -f "$T/afplay_amp"; cn_run
  assert_has "$(cn_events)" '"result":"inconclusive:tape_stalled"' "tape did not advance"
}
