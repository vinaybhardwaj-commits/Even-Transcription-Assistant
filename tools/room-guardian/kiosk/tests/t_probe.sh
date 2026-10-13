#!/bin/bash
# Probe responder (spec 2.2).
test_probe_reply_and_topic() {
  load_libs; mk_tcc 2; mk_pcm 16384 3; export PROBE_CAP_S=4
  handle_message "kiosk/opd9/probe" "probe opd9 abc-123"
  local r; r="$(grep 'kiosk/opd9/probe-reply' "$T/pub.log")"
  assert_has "$r" '"probe_id":"abc-123"' "id echoed"
  assert_has "$r" '"rms_dbfs_2s":"-6.0"' "rms"
  assert_has "$r" '"usb":"present"' "usb"
  assert_has "$r" '"verdict":"ok"' "verdict"
  for k in rms_dbfs_2s tcc usb audio_engine default_input coreaudiod recorder helper upload presence disk power; do assert_has "$r" "\"$k\":" "row $k"; done
}

test_probe_timeout_is_a_verdict_within_budget() {
  load_libs; mk_tcc 2; export FAKE_SP_SLEEP=8 PROBE_CAP_S=1
  local t0 t1; t0="$(date +%s)"
  handle_message "kiosk/opd9/probe" "probe opd9 p1"
  t1="$(date +%s)"
  local r; r="$(grep 'probe-reply' "$T/pub.log")"
  assert_has "$r" '"default_input":"timeout"' "per-check cap"
  assert_has "$r" '"verdict":"coreaudio_unresponsive"' "timeout is the verdict"
  [ $((t1 - t0)) -le 4 ] && ok || fail "reply took $((t1 - t0)) s, budget 5"
}

test_probe_ignores_bad_input() {
  load_libs; mk_tcc 2
  handle_message "kiosk/opd9/probe" "probe other p1"
  handle_message "kiosk/opd9/probe" 'probe opd9 $(touch /tmp/x)'
  handle_message "kiosk/opd9/probe" "probe opd9 "
  handle_message "kiosk/opd9/other" "probe opd9 p2"
  assert_eq "$(grep -c probe-reply "$T/pub.log")" "0" "no reply to wrong room, bad id, wrong topic"
}

test_probe_via_main_entry() {
  load_libs; mk_tcc 2
  GUARDIAN_CONF=/dev/null bash "$KDIR/bin/guardian.sh" handle "kiosk/opd9/probe" "probe opd9 z9"
  assert_has "$(cat "$T/pub.log")" '"probe_id":"z9"' "guardian.sh handle"
}

# Spec 2.2: a probe is answered within 5 s. Checks are capped at 2.5 s and the reply publish at 1.5 s; process overhead is about 0.5 s, so the worst case stays under 5 s.
ms() { perl -MTime::HiRes=time -e 'printf "%d", time * 1000'; }
test_probe_reply_within_5_s_when_a_check_and_the_publish_both_hang() {
  unset PROBE_CAP_S; load_libs; mk_tcc 2
  assert_eq "$PROBE_CAP_S" "2.5" "default check cap"
  export FAKE_SP_SLEEP=30 GUARDIAN_PUBLISH_CMD='sleep 30'
  local t0 t1; t0="$(ms)"
  handle_message "kiosk/opd9/probe" "probe opd9 slow1"
  t1="$(ms)"
  [ $((t1 - t0)) -lt 5000 ] && ok || fail "probe took $((t1 - t0)) ms, budget 5000"
  [ $((t1 - t0)) -ge 2500 ] && ok || fail "the 2.5 s cap did not wait ($((t1 - t0)) ms)"
}

# A check that hits the 2.5 s default cap is a verdict in a well-formed reply, not an error and not silence.
test_probe_check_timing_out_at_the_default_cap_yields_a_verdict() {
  unset PROBE_CAP_S; load_libs; mk_tcc 2
  export FAKE_SP_SLEEP=30
  handle_message "kiosk/opd9/probe" "probe opd9 cap1"
  local r; r="$(grep 'probe-reply' "$T/pub.log")"
  assert_has "$r" '"probe_id":"cap1"' "a reply was published"
  assert_has "$r" '"default_input":"timeout"' "the slow check is recorded as timeout"
  assert_has "$r" '"verdict":"coreaudio_unresponsive"' "and the verdict names it"
  assert_has "$r" '"usb":"present"' "the other rows are intact"
  assert_eq "$(printf '%s' "$r" | cut -f2 | sed 's/[^{]//g' | wc -c | tr -d ' ')" "$(printf '%s' "$r" | cut -f2 | sed 's/[^}]//g' | wc -c | tr -d ' ')" "braces balance: well-formed JSON"
  assert_eq "$(find "$STATE_DIR" -maxdepth 1 -name 'probe.*' | wc -l | tr -d ' ')" "0" "no probe temp dir left behind"
}
