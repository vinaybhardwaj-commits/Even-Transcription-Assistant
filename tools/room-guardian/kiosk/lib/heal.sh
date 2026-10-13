#!/bin/bash
# shellcheck disable=SC2034,SC2154
# Kiosk Guardian: self-heal ladder (spec 2.4 a-g) with the G-rules in code.
#  G1 no launchctl kickstart anywhere in this file; restart is bootout + bootstrap only.
#  G2 Chrome restart by day only when HID idle >= IDLE_MIN_S AND no speech on the tape in SPEECH_QUIET_S AND no unproven-quiet open capture; else only in the night window.
#  G3 nothing here stops or pauses recording; restarts need a confirmed idle capture.
#  G4 no deletes, no Chrome cookie or Preferences reads.
#  G5 root only through root_do (the kiosk-sudo path) and only the whitelisted helper verbs.
#  G6 3 heal actions per room per hour, then escalate once and stop.
#  G8 kill switch is checked before an action begins (act_begin) and before each step that can still be skipped safely.
#     Never inside bootout..bootstrap or pkill..open: once the first half ran, the second half always runs.
#  G9 events carry ids, counts, levels and verdict names only.

HEAL_CHANGED=0
ACTIONS_FILE="$STATE_DIR/actions"

actions_last_hour() {
  local cut
  cut=$(( $(now_epoch) - 3600 ))
  [ -r "$ACTIONS_FILE" ] || { echo 0; return; }
  awk -v c="$cut" '$1 >= c { n++ } END { print n + 0 }' "$ACTIONS_FILE"
}

# heal_event <action> <layer> <reason> <before> <after> <result> <shadow> [target] [severity]
heal_event() {
  local line
  line="$(printf '{"room_id":%s,"ts":%s,"action":%s,"layer":%s,"reason":%s,"before":%s,"after":%s,"result":%s,"shadow":%s,"target":%s,"severity":%s}' \
    "$(jstr "$GUARDIAN_ROOM")" "$(now_epoch)" "$(jstr "$1")" "$(jstr "$2")" "$(jstr "$3")" "$(jstr "$4")" "$(jstr "$5")" "$(jstr "$6")" \
    "$(jbool "$7")" "$(jstr "${8:-}")" "$(jstr "${9:-}")")"
  printf '%s\n' "$line" >>"$AUDIT_LOG" 2>/dev/null
  publish "kiosk/$GUARDIAN_ROOM/heal" "$line"
}

target_for() {
  case "$1" in
    usb_device_missing|helper_xpc_down|disk_low|mic_restricted|recorder_crash_loop|recorder_capture_stalled|recorder_needs_enrol|coreaudio_rms_dead|autologin_changed) echo "fleet" ;;
    server_retired|server_disabled|mic_row_missing|mic_flip_regranted|heal_rate_limited) echo "gating-lead,fleet" ;;
    presence_stale) echo "consult-lead" ;;
    *) echo "fleet" ;;
  esac
}

# Escalate = publish only (the C4 router pages). Not a heal action, so no kill switch; deduped 10 min.
escalate() { # verdict layer evidence
  local sev=page
  once_per "esc:$1" 600 || return 0
  in_clinic_hours || sev=info
  heal_event escalate "$2" "$1" "$3" "" escalated "$([ "$(current_mode)" = heal ] && echo false || echo true)" "$(target_for "$1")" "$sev"
}

# 0 = proceed with real actions. 1 = blocked or shadow (already reported).
act_begin() { # layer reason before
  ACT_LAYER="$1"; ACT_REASON="$2"; ACT_BEFORE="$3"
  if killswitch_engaged; then
    once_per "would:$ACT_LAYER:$ACT_REASON:ks" 300 && heal_event would_do "$ACT_LAYER" "$ACT_REASON" "$ACT_BEFORE" "" "WOULD-DO blocked=killswitch" true
    return 1
  fi
  if [ "$(current_mode)" != "heal" ]; then
    once_per "would:$ACT_LAYER:$ACT_REASON" 300 && heal_event would_do "$ACT_LAYER" "$ACT_REASON" "$ACT_BEFORE" "" "WOULD-DO" true
    return 1
  fi
  if [ "$(actions_last_hour)" -ge "$HEAL_MAX_PER_HOUR" ]; then
    once_per "ratelimit" 3600 && heal_event escalate "$ACT_LAYER" heal_rate_limited "actions_last_hour=$(actions_last_hour)" "" "stopped" false "$(target_for heal_rate_limited)" page
    return 1
  fi
  mkdir -p "$STATE_DIR" 2>/dev/null
  printf '%s %s\n' "$(now_epoch)" "$ACT_LAYER:$ACT_REASON" >>"$ACTIONS_FILE"
  return 0
}

# Re-check the kill switch before each mutating command inside an action.
act_step() {
  if killswitch_engaged; then
    audit "act_step aborted by kill switch layer=$ACT_LAYER"
    heal_event abort "$ACT_LAYER" "$ACT_REASON" "$ACT_BEFORE" "" "aborted_killswitch" false
    return 1
  fi
  return 0
}

tapewriter_count() { pgrep -f 'tapewriter record' 2>/dev/null | wc -l | tr -d ' '; }

# True only when it is safe to restart the recorder: no tapewriter, and (recorder dead or its status says capture_open=false).
capture_idle() {
  [ "$(tapewriter_count)" = "0" ] || return 1
  if [ "$S_rec_running" = "false" ]; then return 0; fi
  [ "$(json_get "$STATUS_JSON" capture_open)" = "false" ]
}

# bootout then bootstrap. Never kickstart (G1). Caller has checked capture_idle; checked again here.
recorder_restart() {
  local uid; uid="$(id -u)"
  capture_idle || { audit "recorder_restart refused: capture not idle"; return 2; }
  RESTART_OFFSET="$(wc -c <"$LAUNCHD_LOG" 2>/dev/null | tr -d ' ')"; : "${RESTART_OFFSET:=0}"
  act_step || return 1
  # point of no return: bootout is followed by bootstrap whatever the kill switch says (an unloaded agent is not reloaded by KeepAlive)
  launchctl bootout "gui/$uid/$RR_LABEL" 2>/dev/null
  gsleep "${GUARDIAN_SETTLE_S:-1}"
  launchctl bootstrap "gui/$uid" "$RR_PLIST" 2>/dev/null && return 0
  gsleep "${GUARDIAN_SETTLE_S:-1}"
  launchctl bootstrap "gui/$uid" "$RR_PLIST" 2>/dev/null
}

# a. mic permission
heal_tcc() {
  local before res stamp user
  user="$(id -un)"
  before="mic_state=${S_mic_state:-null} tcc_row=${S_tcc_row:-null}"
  if ! capture_idle; then
    once_per "tcc:logonly" 300 && heal_event log_only tcc mic_not_authorized "$before" "" "capture_open_no_restart" "$([ "$(current_mode)" = heal ] && echo false || echo true)"
    return 0
  fi
  act_begin tcc mic_not_authorized "$before" || return 1
  stamp="$(now_epoch)"
  act_step || return 1
  res="$(root_do tcc-heal "$user" "$stamp" 2>/dev/null)"; res="${res:-no_result}"
  case "$res" in
    ok|already_authorized) ;;
    *) heal_event heal tcc mic_not_authorized "$before" "" "tcc_heal_failed:$res" false "$(target_for mic_row_missing)" page; return 1 ;;
  esac
  act_step || return 1
  killall -u "$user" tccd 2>/dev/null
  recorder_restart || { heal_event heal tcc mic_not_authorized "$before" "" "restart_failed" false "$(target_for mic_row_missing)" page; return 1; }
  if tcc_confirmed "$user"; then
    local lines
    lines="$(root_do log-grab 2 2>/dev/null | tee -a "$AUDIT_LOG" | wc -l | tr -d ' ')"
    heal_event heal tcc mic_not_authorized "$before" "$CONFIRM_HOW" "ok" false
    heal_event alert tcc mic_flip_regranted "$before" "audit_lines=${lines:-0}" "regranted" false "$(target_for mic_flip_regranted)" page
    : >"$STATE_DIR/tcc_row"   # drop the 60 s cache so the next pass re-reads the row
    HEAL_CHANGED=1
    return 0
  fi
  # No revert here. The helper already restored the backup when changes() was not 1; a working grant is never put back to denied.
  heal_event heal tcc mic_not_authorized "$before" "not confirmed in ${CONFIRM_TIMEOUT_S}s: $CONFIRM_HOW" "unconfirmed_escalated" false "$(target_for mic_row_missing)" page
  return 1
}

# After the restart: the log line or status.json mic_state=authorized (polled), then a last read of the row. Sets CONFIRM_HOW.
tcc_confirmed() { # user
  local waited=0 row
  while [ "$waited" -le "$CONFIRM_TIMEOUT_S" ]; do
    if tail -c "+$((RESTART_OFFSET + 1))" "$LAUNCHD_LOG" 2>/dev/null | grep -q -- "microphone authorized"; then CONFIRM_HOW="log:microphone authorized"; return 0; fi
    if [ "$(json_get "$STATUS_JSON" mic_state)" = "authorized" ]; then CONFIRM_HOW="status:mic_state=authorized"; return 0; fi
    gsleep 1; waited=$((waited + 1))
  done
  row="$(root_do tcc-row "$1" 2>/dev/null)"; row="${row%%|*}"
  if [ "$row" = "2" ]; then CONFIRM_HOW="row:auth_value=2"; return 0; fi
  CONFIRM_HOW="mic_state=$(json_get "$STATUS_JSON" mic_state) row=${row:-null}"
  return 1
}

# b. coreaudiod wedged: only with no capture open
heal_coreaudiod() {
  local before="usb=true engine=false coreaudiod_pid=${S_ca_pid:-none}" waited=0 newpid
  if ! capture_idle; then escalate coreaudio_rms_dead coreaudio "$before capture_open=true"; return 0; fi
  act_begin coreaudio coreaudiod_wedged "$before" || return 1
  act_step || return 1
  root_do coreaudiod-kill >/dev/null 2>&1
  while [ "$waited" -lt "$CONFIRM_TIMEOUT_S" ]; do
    newpid="$(pgrep -x coreaudiod 2>/dev/null | head -n1)"
    if [ -n "$newpid" ] && [ "$newpid" != "$S_ca_pid" ]; then
      heal_event heal coreaudio coreaudiod_wedged "$before" "coreaudiod_pid_changed=true" ok false
      HEAL_CHANGED=1; return 0
    fi
    gsleep 1; waited=$((waited + 1))
  done
  heal_event heal coreaudio coreaudiod_wedged "$before" "coreaudiod_pid_changed=false" "no_restart_seen" false "$(target_for coreaudio_rms_dead)" page
  return 1
}

# c. recorder not running, hung, or needs_enrol
heal_recorder() { # verdict
  local before="state=${S_state:-null} pid=${S_rec_pid:-none}"
  if ! capture_idle; then escalate "$1" recorder "$before capture_not_idle"; return 0; fi
  act_begin recorder "$1" "$before" || return 1
  recorder_restart || { heal_event heal recorder "$1" "$before" "" "restart_failed" false "$(target_for "$1")" page; return 1; }
  heal_event heal recorder "$1" "$before" "restarted" ok false
  HEAL_CHANGED=1
  [ "$1" = "recorder_needs_enrol" ] && escalate recorder_needs_enrol recorder "$before"
  return 0
}

# f. Chrome: G2. By day BOTH: HID idle >= IDLE_MIN_S AND nobody present (no speech on the tape in SPEECH_QUIET_S,
# and no open capture we cannot show is quiet). Kiosks are unattended, so HID idle alone proves nothing. Else only in the night window.
chrome_restart_allowed() {
  local idle; idle="$(hid_idle_s)"
  in_night_window && return 0
  [ -n "$idle" ] && [ "$idle" -ge "$IDLE_MIN_S" ] 2>/dev/null || return 1
  speech_recent && return 1
  return 0
}

heal_chrome() {
  local before idle
  idle="$(hid_idle_s)"; before="presence_heartbeat_age_s=${S_presence_age:-null} hid_idle_s=${idle:-null}"
  if ! chrome_restart_allowed; then
    once_per "chrome:deferred" 600 && heal_event deferred presence chrome_restart_deferred "$before" "" "not_idle_not_night" "$([ "$(current_mode)" = heal ] && echo false || echo true)"
    return 0
  fi
  act_begin presence presence_stale "$before" || return 1
  act_step || return 1
  # point of no return: once Chrome is killed it is always reopened
  pkill -x "Google Chrome" 2>/dev/null
  gsleep "${GUARDIAN_SETTLE_S:-1}"
  open -a "Google Chrome" 2>/dev/null
  heal_event heal presence presence_stale "$before" "chrome_restarted" ok false
  HEAL_CHANGED=1
}

# g. drift
heal_drift() { # verdict
  local before="$1"
  case "$1" in
    pmset_drift)
      act_begin drift pmset_drift "$before" || return 1
      act_step || return 1
      root_do pmset-baseline >/dev/null 2>&1
      heal_event heal drift pmset_drift "$before" "pmset sleep=0 autorestart=1" ok false
      heal_event alert drift pmset_drift "$before" "repaired" repaired false "fleet" info
      HEAL_CHANGED=1 ;;
    launchagent_missing)
      if ! capture_idle; then escalate launchagent_missing drift "$before capture_not_idle"; return 0; fi
      act_begin drift launchagent_missing "$before" || return 1
      act_step || return 1
      "$RR_APP/Contents/MacOS/room-recorder" install-launch-agent >/dev/null 2>&1
      recorder_restart || { heal_event heal drift launchagent_missing "$before" "" "restart_failed" false "fleet" page; return 1; }
      heal_event heal drift launchagent_missing "$before" "agent rewritten and bootstrapped" ok false
      heal_event alert drift launchagent_missing "$before" "repaired" repaired false "fleet" info
      HEAL_CHANGED=1 ;;
    autologin_changed) escalate autologin_changed drift "$before" ;;
  esac
}

# Walk the tree; act on each fault in order; after a real fix re-collect and start over (faults stack).
heal_cycle() {
  local pass=0 faults layer verdict evidence
  while [ "$pass" -lt 3 ]; do
    pass=$((pass + 1)); HEAL_CHANGED=0; HEAL_PASSES=$pass
    faults="$(fault_tree)"
    while IFS='|' read -r layer verdict evidence; do
      [ -n "$verdict" ] || continue
      case "$verdict" in
        mic_denied) heal_tcc ;;
        coreaudio_no_device) heal_coreaudiod ;;
        recorder_not_running|recorder_hung|recorder_needs_enrol) heal_recorder "$verdict" ;;
        presence_stale) heal_chrome ;;
        pmset_drift|launchagent_missing|autologin_changed) heal_drift "$verdict" ;;
        usb_device_missing|mic_restricted|mic_row_missing|recorder_crash_loop|recorder_capture_stalled|helper_xpc_down|disk_low|server_retired|server_disabled|coreaudio_rms_dead)
          escalate "$verdict" "$layer" "$evidence" ;;
        power_rebooted) once_per "info:power_rebooted" 3600 && heal_event info "$layer" "$verdict" "$evidence" "" noted "$([ "$(current_mode)" = heal ] && echo false || echo true)" ;;
        *) : ;; # network_offline, upload_pending: the recorder retries itself
      esac
      [ "$HEAL_CHANGED" -eq 1 ] && break
    done <<EOF
$faults
EOF
    [ "$HEAL_CHANGED" -eq 1 ] || break
    collect_all
  done
}
