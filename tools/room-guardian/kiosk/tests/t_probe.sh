#!/bin/bash
# Probe responder (spec 2.2).
test_probe_reply_and_topic() {
  load_libs; mk_tcc 2; mk_pcm 16384 3; export PROBE_CAP_S=60 PROBE_BUDGET_MS=120000   # a content test, not a timing test: a busy host must not turn a slow check into a timeout
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
ms() { mono_ms; }
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

# ---- R3: one deadline from probe start (4.5 s), not fixed caps ----

test_probe_caps_are_computed_from_the_time_left() {
  unset PROBE_CAP_S; load_libs
  assert_eq "$PROBE_BUDGET_MS" "4500" "budget: 0.5 s under the spec's 5 s"
  assert_eq "$(probe_check_cap 4500)" "2.500" "full budget: the 2.5 s ceiling"
  assert_eq "$(probe_check_cap 3000)" "2.000" "3.0 s left: leave 1.0 s for the publish"
  assert_eq "$(probe_check_cap 2500)" "1.500" "2.5 s left"
  assert_eq "$(probe_check_cap 1100)" "0.000" "under 0.2 s for checks: none are started"
  assert_eq "$(probe_check_cap -400)" "0.000" "deadline already past"
  assert_eq "$(probe_publish_cap 1500)" "1.500" "publish gets what is left"
  assert_eq "$(probe_publish_cap 4000)" "4.000" "and more when checks finished early"
  assert_eq "$(probe_publish_cap 100)" "0.300" "never under 0.3 s"
  assert_eq "$(probe_publish_cap -2000)" "0.300" "even when the deadline is past"
}

# Artificial 2 s overhead at probe start + a hung check + a hung publish: still under 5 s, and the payload shows the timeout.
test_probe_replies_under_5_s_with_2_s_overhead_a_hung_check_and_a_hung_publish() {
  unset PROBE_CAP_S; load_libs; mk_tcc 2
  probe_start_hook() { sleep 2; }
  export FAKE_SP_SLEEP=30 GUARDIAN_PUBLISH_CMD='{ printf "%s\t" "$1"; cat; } >>"$T/pub.log"; sleep 30'
  local t0 t1; t0="$(ms)"
  handle_message "kiosk/opd9/probe" "probe opd9 ovh1"
  t1="$(ms)"
  [ $((t1 - t0)) -lt 5000 ] && ok || fail "probe took $((t1 - t0)) ms under 2 s injected overhead, budget 5000"
  local r; r="$(grep 'probe-reply' "$T/pub.log")"
  assert_has "$r" '"probe_id":"ovh1"' "the reply was handed to the transport"
  assert_has "$r" '"default_input":"timeout"' "the hung check is a timeout"
  assert_has "$r" '"usb":"present"' "fast checks still reported"
}

# Deadline already spent when the checks would start: nothing is started, every row is a timeout, the reply still goes out.
test_probe_with_the_deadline_spent_marks_every_row_timeout_and_still_replies() {
  unset PROBE_CAP_S; load_libs; mk_tcc 2
  PROBE_BUDGET_MS=1000
  probe_start_hook() { sleep 1.3; }
  export FAKE_SP_SLEEP=30
  : >"$CALLS"
  handle_message "kiosk/opd9/probe" "probe opd9 late1"
  local r; r="$(grep 'probe-reply' "$T/pub.log")"
  assert_has "$r" '"probe_id":"late1"' "a reply was published"
  assert_eq "$(printf '%s' "$r" | grep -o '"[a-z_0-9]*":"timeout"' | wc -l | tr -d ' ')" "12" "all 12 rows are timeout"
  assert_has "$r" '"verdict":"coreaudio_unresponsive"' "verdict follows the timeout rule"
  assert_not "$(cat "$CALLS")" "SUDO" "no check was started"
}
