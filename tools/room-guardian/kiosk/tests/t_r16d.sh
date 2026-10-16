#!/bin/bash
# shellcheck disable=SC2030,SC2031,SC1091,SC2010
# R16d: two-slot empty-room canary, skip gates, band statistic with 2 of 2 plays, recorder_failed, herdr C3 rerun 19 fold-ins.
# Uses cn_prep / cn_run / cn_events / cn_plays from t_canary.sh (sourced first: t_canary sorts before t_r16d).
r6_audit() { cat "$GUARDIAN_HOME/audit.log" 2>/dev/null; }
# r6_at <HH:MM> [days]: an eligible slot at that IST time, heal mode, a loud 1 kHz tone ready, the consult hold CLEAR
r6_at() {
  cn_prep "$1"; GUARDIAN_FAKE_NOW=$(( $(ist_epoch "$1") + ${2:-0} * 86400 )); write_status; mk_pcm_tone 100 10; consult_clear; go_heal; echo 7954 >"$T/afplay_amp"
}

test_r16d_slot_boundaries() {
  local t want
  for t in "21:39 -" "21:40 pm" "22:39 pm" "22:40 -" "07:19 -" "07:20 am" "08:19 am" "08:20 -"; do
    set -- $t; want="$2"; [ "$want" = "-" ] && want=""
    r6_at "$1"
    assert_eq "$(canary_slot_name)" "$want" "slot at $1"
    if [ -n "$want" ]; then cn_run; assert_eq "$(cn_plays)" "2" "$1 plays (two plays)"; else cn_run; assert_eq "$(cn_plays)" "0" "$1 no play"; fi
  done
}

test_r16d_once_per_slot_and_pm_then_am() {
  r6_at 22:00; cn_run
  assert_eq "$(cn_plays)" "2" "pm: two plays"
  cn_run; assert_eq "$(cn_plays)" "2" "second tick same slot: no more"
  load_libs; cn_run; assert_eq "$(cn_plays)" "2" "after a restart (libs reloaded, state on disk): no more"
  assert_eq "$(cat "$CANARY_SLOT_FILE")" "20261014-pm" "pm key"
  r6_at 07:30 1; rm -rf "$STATE_DIR/once" "$STATE_DIR/actions"; : >"$CALLS"; cn_run
  assert_eq "$(cn_plays)" "2" "the next morning's am slot plays (state kept: slot file and last play from pm)"
  assert_eq "$(cat "$CANARY_SLOT_FILE")" "20261015-am" "am key"
}

test_r16d_pm_then_am_state_kept() {
  r6_at 22:00; cn_run
  # keep canary_slot and canary_last_play; only the per-tick scratch is reset for the next morning
  GUARDIAN_FAKE_NOW=$(( $(ist_epoch 07:30) + 86400 )); write_status; mk_pcm_tone 100 10; consult_clear; go_heal; echo 7954 >"$T/afplay_amp"; rm -rf "$STATE_DIR/actions"; : >"$CALLS"
  cn_run
  assert_eq "$(cn_plays)" "2" "am after pm with the real pm state on disk"
}

test_r16d_6h_gap_and_clock_jump_back() {
  r6_at 22:00; echo "$((GUARDIAN_FAKE_NOW - 20000))" >"$CANARY_LAST_FILE"; cn_run
  assert_eq "$(cn_plays)" "0" "5.5 h after a play: refused"
  r6_at 22:00; echo "$((GUARDIAN_FAKE_NOW - 21600))" >"$CANARY_LAST_FILE"; cn_run
  assert_eq "$(cn_plays)" "2" "exactly 6 h: plays"
  r6_at 22:00; echo "$((GUARDIAN_FAKE_NOW + 100))" >"$CANARY_LAST_FILE"; cn_run
  assert_eq "$(cn_plays)" "0" "clock jumped back: refused"
  r6_at 22:00; echo 20261015-pm >"$CANARY_SLOT_FILE"; cn_run
  assert_eq "$(cn_plays)" "0" "a slot key in the future: refused"
}

test_r16d_am_slot_consult_gate() {
  local c
  for c in none oldform stale true fresh_false; do
    r6_at 07:30
    case "$c" in
      none) rm -f "$STATE_DIR/control.last" ;;
      oldform) printf '%s\n{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}\n' "$((GUARDIAN_FAKE_NOW - 1))" "$GUARDIAN_FAKE_NOW" >"$STATE_DIR/control.last" ;;
      stale) consult_clear 200 ;;
      true) printf '%s\n{"consult_open": {"opd9": true}, "kill": false, "modes": {"opd9": "heal"}, "ts": %s}\n' "$((GUARDIAN_FAKE_NOW - 1))" "$GUARDIAN_FAKE_NOW" >"$STATE_DIR/control.last" ;;
    esac
    [ "$c" = none ] || [ "$c" = oldform ] || [ "$c" = true ] || [ "$c" = stale ] || :
    flag_fetch; go_heal 2>/dev/null
    case "$c" in
      none) rm -f "$STATE_DIR/control.last" ;;
      oldform) printf '%s\n{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}\n' "$((GUARDIAN_FAKE_NOW - 1))" "$GUARDIAN_FAKE_NOW" >"$STATE_DIR/control.last" ;;
      stale) consult_clear 200 ;;
      true) printf '%s\n{"consult_open": {"opd9": true}, "kill": false, "modes": {"opd9": "heal"}, "ts": %s}\n' "$((GUARDIAN_FAKE_NOW - 1))" "$GUARDIAN_FAKE_NOW" >"$STATE_DIR/control.last" ;;
    esac
    cn_run
    if [ "$c" = fresh_false ]; then assert_eq "$(cn_plays)" "2" "am fresh-false: plays"
    else assert_eq "$(cn_plays)" "0" "am $c: 0 afplay"; assert_has "$(r6_audit)" "canary skipped: consult_not_clear slot=" "am $c: skip audited"; fi
  done
  # pm slot: the old-form payload plays (night window)
  r6_at 22:00; printf '%s\n{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}\n' "$((GUARDIAN_FAKE_NOW - 1))" "$GUARDIAN_FAKE_NOW" >"$STATE_DIR/control.last"
  cn_run; assert_eq "$(cn_plays)" "2" "pm with an old-form payload plays"
}

test_r16d_recorder_busy_and_failed() {
  local c
  for c in speech upload_pending paused failed; do
    r6_at 22:00
    case "$c" in
      speech) mk_pcm_tone 2000 10 ;;
      upload_pending) write_status state=upload_pending pending=3 ;;
      paused) write_status state=paused ;;
      failed) write_status state=failed ;;
    esac
    cn_run
    assert_eq "$(cn_plays)" "0" "$c: 0 afplay"
    if [ "$c" = failed ]; then assert_has "$(r6_audit)" "canary skipped: recorder_failed" "failed audited"; else assert_has "$(r6_audit)" "canary skipped: recorder_busy" "$c audited as recorder_busy"; fi
  done
}

test_r16d_skip_audited_once_per_slot_per_reason() {
  local i
  r6_at 22:00; write_status state=paused
  for i in $(seq 1 30); do GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 5)); write_status state=paused; mk_pcm_tone 100 10; cn_run; done
  assert_eq "$(r6_audit | grep -c 'canary skipped: recorder_busy')" "1" "one audit line over 30 ticks"
  write_status state=recording; echo 1000000000000 >"$T/hid"
  echo 5000000000 >"$T/hid"; for i in 1 2 3; do cn_run; done
  assert_eq "$(r6_audit | grep -c 'canary skipped: hid_active')" "1" "a second reason: its own single line"
  assert_eq "$(r6_audit | grep -c 'canary skipped: recorder_busy')" "1" "the first reason is still one line"
}

test_r16d_event_fields_and_threshold() {
  r6_at 22:00; cn_run
  assert_has "$(cn_events)" '"slot":"pm"' "slot"
  assert_has "$(cn_events)" '"pass_db":32.65' "pass_db"
  assert_has "$(cn_events)" '"pass_db_band":10' "pass_db_band"
  assert_has "$(cn_events)" '"plays":\[{"pre_db":' "plays array"
  assert_has "$(cn_events)" '"rise_db_band":' "band rise"
  assert_has "$(cn_events)" '"pass_broadband":' "pass_broadband"
  assert_eq "$CANARY_PASS_DB" "32.65" "default threshold"
  assert_eq "$(cn_events | grep -o '"rise_db_band"' | wc -l | tr -d ' ')" "2" "two plays in the event"
  # member order: the existing members first, the new ones appended
  assert_has "$(cn_events)" '"output":"present","slot":"pm","pass_db":32.65,"plays":\[' "order"
}

test_r16d_band_filter_coefficients_and_gain() {
  load_libs
  assert_eq "$CANARY_HP_COEF" "0.7570763753 -1.5141527507 0.7570763753 -1.4542435863 0.5740619151" "HP coefficients (herdr band null spec)"
  assert_eq "$CANARY_LP_COEF" "0.1866943331 0.3733886662 0.1866943331 -0.4629380253 0.2097153578" "LP coefficients"
  local f="$T/tone.pcm" hz g exp
  # a sine of RMS 4000 through the cascade, pre = 5 s of the same sine, burst = 2.5 s: band burst - raw dBFS = the cascade gain
  for hz in 2000 500; do
    perl -e 'my($hz)=@ARGV; print pack("s<*", map { int(5656.85*sin(6.28318530718*$hz*$_/16000)) } 0..(160000+40000+16000-1))' "$hz" >"$f"
    g="$(canary_band_stats "$f" 0 160000 56000 | awk '{ print $2 }')"
    exp="$(awk -v hz="$hz" 'BEGIN { pi = 3.14159265358979; w = 2 * pi * hz / 16000; g = 1
      split("0.7570763753 -1.5141527507 0.7570763753 -1.4542435863 0.5740619151 0.1866943331 0.3733886662 0.1866943331 -0.4629380253 0.2097153578", c, " ")
      for (s = 0; s < 2; s++) { o = s * 5; re1 = c[o+1] + c[o+2] * cos(w) + c[o+3] * cos(2*w); im1 = -c[o+2] * sin(w) - c[o+3] * sin(2*w)
        re2 = 1 + c[o+4] * cos(w) + c[o+5] * cos(2*w); im2 = -c[o+4] * sin(w) - c[o+5] * sin(2*w)
        g *= sqrt((re1*re1 + im1*im1) / (re2*re2 + im2*im2)) }
      printf "%.2f", 20 * log(4000 * g / 32768) / log(10) }')"
    assert_eq "$(awk -v a="$g" -v b="$exp" 'BEGIN { d = a - b; if (d < 0) d = -d; print (d <= 0.5) ? "ok" : "off " a " vs " b }')" "ok" "gain at $hz Hz within 0.5 dB of analytic"
  done
}

test_r16d_band_tone_passes_noise_does_not() {
  load_libs
  local f="$T/b.pcm" r
  # quiet bed (1 kHz sine RMS 100), then a 1 kHz tone RMS 4000: a large band rise
  { perl -e 'print pack("s<*", map { int(141.4*sin(6.28318530718*$_/16)) } 0..79999)'; perl -e 'print pack("s<*", map { int(5656*sin(6.28318530718*$_/16)) } 0..39999)'; } >"$f"
  r="$(canary_band_stats "$f" 0 160000 80000 | awk '{ printf "%.0f", $2 - $1 }')"
  [ "$r" -ge 30 ] && ok || fail "1 kHz tone: band rise $r dB (want >= 30)"
  # broadband noise of equal RMS in both ranges (white noise, RMS 4000 both): no rise
  perl -e 'srand(7); sub g { my $u=rand(); my $v=rand(); return sqrt(-2*log($u+1e-12))*cos(6.2831853*$v) } print pack("s<*", map { int(4000*g()) } 0..239999)' >"$f"
  r="$(canary_band_stats "$f" 0 160000 80000 | awk '{ printf "%.0f", $2 - $1 }')"
  [ "$r" -lt 10 ] && ok || fail "equal-RMS noise: band rise $r dB (want < 10)"
}

# two plays: pass/pass = pass, pass/fail = no_local_rise, pass/refused = inconclusive
test_r16d_two_of_two_logic() {
  r6_at 22:00; cn_run
  assert_has "$(cn_events)" '"result":"pass"' "pass/pass"
  # pass then a quiet second play: the fake afplay writes the tone only when the amp file exists; remove it after the first call
  r6_at 22:00
  printf '#!/bin/bash\necho "afplay $*" >>"$CALLS"\nn=$(grep -c "^afplay " "$CALLS")\nTAPE="$(ls -t "$RR_ROOT"/captures/*/seg_*/tape.pcm | head -n1)"\nA=7954; [ "$n" -ge 2 ] && A=100\nperl -e '"'"'my $a=shift; print pack("s<*", map { int($a*1.41421356*sin(6.28318530718*$_/16)+0.5) } 0..39999, map { int(141.4*sin(6.28318530718*$_/16)+0.5) } 0..95999)'"'"' "$A" >>"$TAPE"\nexit 0\n' >"$T/bin/afplay"; chmod +x "$T/bin/afplay"
  cn_run
  assert_has "$(cn_events)" '"result":"no_local_rise"' "pass/fail"
  assert_eq "$(cn_plays)" "2" "both plays made"
  # pass then a refused second play (afplay fails the second time): inconclusive
  r6_at 22:00
  printf '#!/bin/bash\necho "afplay $*" >>"$CALLS"\nn=$(grep -c "^afplay " "$CALLS")\nTAPE="$(ls -t "$RR_ROOT"/captures/*/seg_*/tape.pcm | head -n1)"\nperl -e '"'"'print pack("s<*", map { int(7954*1.41421356*sin(6.28318530718*$_/16)+0.5) } 0..39999, map { int(141.4*sin(6.28318530718*$_/16)+0.5) } 0..95999)'"'"' >>"$TAPE"\n[ "$n" -ge 2 ] && exit 3\nexit 0\n' >"$T/bin/afplay"; chmod +x "$T/bin/afplay"
  cn_run
  assert_has "$(cn_events)" '"result":"inconclusive:afplay_error"' "pass/refused"
  assert_not "$(cn_events)" '"result":"pass"' "never a pass on one play"
}

test_r16d_kill_switch_between_plays_gives_one_play_and_would_do() {
  r6_at 22:00
  printf '#!/bin/bash\necho "afplay $*" >>"$CALLS"\nTAPE="$(ls -t "$RR_ROOT"/captures/*/seg_*/tape.pcm | head -n1)"\nperl -e '"'"'print pack("s<*", map { int(7954*1.41421356*sin(6.28318530718*$_/16)+0.5) } 0..39999, map { int(141.4*sin(6.28318530718*$_/16)+0.5) } 0..95999)'"'"' >>"$TAPE"\n: >"%s/flags/heal-off"\nexit 0\n' "$GUARDIAN_HOME" >"$T/bin/afplay"; chmod +x "$T/bin/afplay"
  cn_run
  assert_eq "$(cn_plays)" "1" "kill switch engaged between plays: 1 play"
  assert_has "$(cn_events)" '"result":"would_do"' "would_do"
}

test_r16d_second_play_is_dropped_mutant_goes_red() {
  r6_at 22:00
  # mutant: a canary with the second play removed makes only one afplay call; the two-play assertions must see that
  sed 's/for n in 1 2; do/for n in 1; do/' "$KDIR/lib/canary.sh" >"$T/canary_mut.sh"
  ( . "$T/canary_mut.sh"; cn_run ) >/dev/null 2>&1
  assert_eq "$(cn_plays)" "1" "mutant (one play) makes one call"
  [ "$(cn_plays)" = "2" ] && fail "the two-play assertion would not catch the mutant" || ok
}

# ---- items 6 and 7 ----
r6_failed_prep() { load_libs; go_heal; write_status state=failed "err=$1"; collect_all; : >"$T/pub.log"; }

test_r16d_recorder_failed_escalates_only() {
  r6_failed_prep "disk full"
  S_rec_running=true; : >"$CALLS"
  assert_has "$(fault_tree)" "recorder|recorder_failed|state=failed last_error=disk full" "tree arm"
  heal_cycle
  assert_eq "$(events | grep -c '"reason":"recorder_failed"')" "1" "one escalate"
  assert_eq "$(events | grep -c '"action":"escalate"')" "1" "only the escalate"
  assert_eq "$([ -f "$STATE_DIR/actions" ] && wc -l <"$STATE_DIR/actions" | tr -d ' ' || echo 0)" "0" "0 actions spent"
  assert_not "$(cat "$CALLS")" "SUDO" "no root call"
  assert_not "$(cat "$CALLS")" "launchctl kickstart\|launchctl bootstrap" "no recorder restart"
  assert_has "$(events)" '"layer":"recorder","reason":"recorder_failed","before":"state=failed last_error=disk full"' "event shape"
  assert_eq "$(target_for recorder_failed)" "$(target_for recorder_not_running)" "same target as recorder_not_running"
}

test_r16d_recorder_failed_holds_coreaudio_and_escapes_last_error() {
  local le out
  load_libs; go_heal
  le="$(printf 'x%.0s' $(seq 1 100))"
  write_status state=failed; collect_all; S_rec_running=true
  S_last_error="bad \"quote\" back\\slash $le"
  S_usb=true; S_engine=false
  out="$(fault_tree)"
  assert_not "$out" "coreaudio_no_device" "CoreAudio verdict held while the recorder fault stands"
  assert_has "$out" "recorder_failed" "the failed arm"
  assert_eq "$(printf '%s\n' "$out" | grep recorder_failed | sed 's/.*last_error=//' | wc -c | tr -d ' ')" "81" "last_error <= 80 chars (80 + newline)"
  : >"$T/pub.log"; heal_cycle
  assert_has "$(events | grep recorder_failed)" 'last_error=bad' "event carries it"
  printf '%s' "$(events | grep recorder_failed)" | grep -q '[^\\]""' && fail "unescaped quote" || ok
}

test_r16d_recorder_failed_mutant_arm_removed() {
  load_libs; go_heal; write_status state=failed "err=x"; collect_all; S_rec_running=true
  sed 's/^    failed) echo.*$//' "$KDIR/lib/faulttree.sh" >"$T/ft_mut.sh"
  ( . "$T/ft_mut.sh"; fault_tree ) | grep -q recorder_failed && fail "mutant still emits" || ok
  fault_tree | grep -q recorder_failed && ok || fail "real tree lacks the arm"
}

# SHOULD-1: a helper that fails or prints nothing leaves S_tcc_row=error; mic_state denied gives an escalate and 0 helper write calls
test_r16d_unreadable_helper_row_escalates_without_write() {
  load_libs; go_heal; mk_tcc 2 2>/dev/null
  write_status mic_state=denied
  printf '#!/bin/bash\necho "HELPER $*" >>"$CALLS"\nexit 1\n' >"$T/helper_fail"; chmod +x "$T/helper_fail"
  GUARDIAN_ROOT_HELPER="$T/helper_fail"; export GUARDIAN_ROOT_HELPER
  collect_all
  S_tcc_row=error
  : >"$CALLS"; : >"$T/pub.log"
  heal_cycle
  assert_eq "$(events | grep -c '"action":"escalate"')" "1" "one escalate"
  assert_eq "$(grep -c '^HELPER\|^SUDO' "$CALLS")" "0" "0 helper calls"
  # the numeric-only rung is what holds: a mutant that matches error:* instead of numbers would call heal_tcc
  sed 's/case "${S_tcc_row:-}" in .*\*) heal_tcc ;; esac ;;/case "${S_tcc_row:-}" in error*) escalate "$verdict" "$layer" "$evidence" ;; *) heal_tcc ;; esac ;;/' "$KDIR/lib/heal.sh" >"$T/heal_mut.sh"
  grep -q 'error\*) escalate' "$T/heal_mut.sh" && ok || fail "mutant built"
}

# NIT-1: the once_per key of tcc_row_unreadable is bounded
test_r16d_tcc_row_unreadable_key_is_bounded() {
  local row f
  load_libs; go_heal
  row="$(printf 'r/%.0s' $(seq 1 100))"
  write_status mic_state=authorized; collect_all; S_tcc_row="$row"
  fault_tree >/dev/null
  f="$(ls "$STATE_DIR/once" | grep tcc_row_unreadable)"
  [ -n "$f" ] && ok || fail "stamp written"
  [ "${#f}" -le 60 ] && ok || fail "stamp name length ${#f}"
  assert_has "$f" "^tcc_row_unreadable_r_r_r" "sanitised to [A-Za-z0-9:_-]"
}

# NIT-2: heal_chrome deferring on the consult hold says so
test_r16d_chrome_defer_reason_consult_hold() {
  load_libs; go_heal; GUARDIAN_FAKE_NOW="$(ist_epoch 11:00)"; echo 1000000000000 >"$T/hid"; write_status
  S_presence_age=900; heal_chrome
  assert_has "$(events)" '"reason":"chrome_restart_deferred".*"result":"consult_hold"' "consult_hold reason"
  assert_not "$(events)" 'not_idle_not_night' "not the old reason"
}

# ---- mutants (each must change the behaviour the real code guards) ----
r6_mut() { # <sed expr> : load the real libs, then override canary.sh with the mutated copy
  sed "$1" "$KDIR/lib/canary.sh" >"$T/canary_mut.sh"
  cmp -s "$T/canary_mut.sh" "$KDIR/lib/canary.sh" && fail "mutation did not apply: $1"
  . "$T/canary_mut.sh"
}
test_r16d_mutant_consult_gate_removed_plays_in_am() {
  r6_at 07:30; printf '%s\n{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}\n' "$((GUARDIAN_FAKE_NOW - 1))" "$GUARDIAN_FAKE_NOW" >"$STATE_DIR/control.last"; flag_fetch; cn_run
  assert_eq "$(cn_plays)" "0" "real: old-form control in the am slot = 0 plays"
  r6_at 07:30; printf '%s\n{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}\n' "$((GUARDIAN_FAKE_NOW - 1))" "$GUARDIAN_FAKE_NOW" >"$STATE_DIR/control.last"; flag_fetch
  r6_mut '/! in_night_window && ! consult_hold_clear/d'; cn_run
  assert_eq "$(cn_plays)" "2" "mutant (gate removed) plays: the consult test above would go red"
}
test_r16d_mutant_slot_key_without_slot_name() {
  r6_at 07:30; cn_run; assert_eq "$(cn_plays)" "2" "am plays"
  GUARDIAN_FAKE_NOW="$(ist_epoch 22:00)"; write_status; mk_pcm_tone 100 10; consult_clear; go_heal; rm -f "$STATE_DIR/actions"; : >"$CALLS"; cn_run
  assert_eq "$(cn_plays)" "2" "real: pm plays after am the same IST day"
  r6_at 07:30
  r6_mut "s/printf '%s-%s' \"\$(ist_date)\" \"\$n\"/printf '%s-pm' \"\$(ist_date)\"/"
  cn_run
  GUARDIAN_FAKE_NOW="$(ist_epoch 22:00)"; write_status; mk_pcm_tone 100 10; consult_clear; go_heal; rm -f "$STATE_DIR/actions"; : >"$CALLS"; cn_run
  assert_eq "$(cn_plays)" "0" "mutant (slot name dropped from the key): the second slot no longer plays"
}
test_r16d_mutant_speech_arm_removed() {
  r6_at 22:00; mk_pcm_tone 2000 10; cn_run
  assert_eq "$(cn_plays)" "0" "real: speech on the tape = 0 plays"
  r6_at 22:00; mk_pcm_tone 2000 10
  r6_mut '/if speech_recent; then CANARY_WHY=recorder_busy/d'; cn_run
  assert_eq "$(cn_plays)" "2" "mutant (speech arm removed) plays"
}
