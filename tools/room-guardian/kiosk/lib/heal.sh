#!/bin/bash
# shellcheck disable=SC2034,SC2154,SC2153
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
HEAL_EXTRA=""   # S2: never inherited from the environment
ACTIONS_FILE="$STATE_DIR/actions"

# Actions in the last hour. Fails closed (R12): an actions file that exists but is not a readable regular file counts as the cap REACHED,
# and a line whose first field is not an epoch counts as one recent action.
actions_last_hour() {
  local cut
  cut=$(( $(now_epoch) - 3600 ))
  [ -e "$ACTIONS_FILE" ] || { echo 0; return; }
  if [ ! -f "$ACTIONS_FILE" ] || [ ! -r "$ACTIONS_FILE" ]; then echo "$HEAL_MAX_PER_HOUR"; return; fi
  awk -v c="$cut" '{ if ($1 !~ /^[0-9]+$/) n++; else if ($1 + 0 >= c) n++ } END { print n + 0 }' "$ACTIONS_FILE"
}

# heal_event <action> <layer> <reason> <before> <after> <result> <shadow> [target] [severity]
heal_event() {
  local line
  line="$(printf '{"room_id":%s,"ts":%s,"action":%s,"layer":%s,"reason":%s,"before":%s,"after":%s,"result":%s,"shadow":%s,"target":%s,"severity":%s}' \
    "$(jstr "$GUARDIAN_ROOM")" "$(now_epoch)" "$(jstr "$1")" "$(jstr "$2")" "$(jstr "$3")" "$(jstr "$4")" "$(jstr "$5")" "$(jstr "$6")" \
    "$(jbool "$7")" "$(jstr "${8:-}")" "$(jstr "${9:-}")")"
  # 2.4 d': HEAL_EXTRA holds pre-built JSON members (guards, boot_age_s, recorder_pid) for the d' events
  [ -z "${HEAL_EXTRA:-}" ] || line="${line%\}},${HEAL_EXTRA}}"
  printf '%s\n' "$line" >>"$AUDIT_LOG" 2>/dev/null
  publish "kiosk/$GUARDIAN_ROOM/heal" "$line"
}

target_for() {
  case "$1" in
    usb_device_missing|usb_power_off|usb_reboot_failed|usb_power_off_recurring|helper_xpc_down|disk_low|mic_restricted|recorder_crash_loop|recorder_capture_stalled|recorder_needs_enrol|recorder_failed|coreaudio_rms_dead|autologin_changed) echo "fleet" ;;
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
  # act_begin gates on heal mode too; act_step repeats it so a direct caller in SHADOW cannot act.
  if [ "$(current_mode)" != "heal" ]; then
    audit "act_step refused: mode is not heal layer=${ACT_LAYER:-none}"
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
  gsleep "$GUARDIAN_SETTLE_S"
  launchctl bootstrap "gui/$uid" "$RR_PLIST" 2>/dev/null && return 0
  gsleep "$GUARDIAN_SETTLE_S"
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
  # R16 (GR15-10): by day a third, independent guard. The consult hold must be CLEAR: a fresh control payload that says consult_open=false for this room, explicitly. A missing,
  # stale, old-form, true or malformed signal = defer (consult_hold_clear fails closed). HID idle and speech are never the only day guard once the recorder is dead.
  consult_hold_clear || return 1
  [ -n "$idle" ] && [ "$idle" -ge "$IDLE_MIN_S" ] 2>/dev/null || return 1
  speech_recent && return 1
  return 0
}

heal_chrome() {
  local before idle
  idle="$(hid_idle_s)"; before="presence_heartbeat_age_s=${S_presence_age:-null} hid_idle_s=${idle:-null}"
  if ! chrome_restart_allowed; then
    local why=not_idle_not_night
    # R16d NIT-2: outside the night window a consult hold that is not clear is its own reason
    in_night_window || consult_hold_clear || why=consult_hold
    once_per "chrome:deferred" 600 && heal_event deferred presence chrome_restart_deferred "$before" "" "$why" "$([ "$(current_mode)" = heal ] && echo false || echo true)"
    return 0
  fi
  act_begin presence presence_stale "$before" || return 1
  act_step || return 1
  # point of no return: once Chrome is killed it is always reopened
  pkill -x "Google Chrome" 2>/dev/null
  gsleep "$GUARDIAN_SETTLE_S"
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

# ---- 2.4 d' USB-C port power-off -> reboot (the C270 left the bus because the port lost power; a reboot re-enumerates it) ----
# The kiosk reboots through ONE root-helper verb and never sends the day-start command or any room command (the Mini router sends it, on the post-boot healed_pending event).
# State: $STATE_DIR/usb-reboot (key=value lines: date = IST YYYYMMDD, epoch, recorder_pid, coreaudiod_pid, boot_age_s, port, verify). It survives the reboot it causes.
USB_STATE="$STATE_DIR/usb-reboot"
USB_LOCK="$STATE_DIR/usb-reboot-lock"        # first line = epoch of the failed verify
USB_RESET="$STATE_DIR/usb-reboot-reset"      # the fleet hand-reset file: its mtime newer than the lock epoch clears the lock (audited)
USB_REBOOT_ISSUED=0
if [ "${G_RUNMODE:-}" = 1 ]; then readonly USB_STATE USB_LOCK USB_RESET; fi

usb_state_get() { # key -> value from the state file
  "$G_SED" -n "s/^$1=//p" "$USB_STATE" 2>/dev/null | "$G_HEAD" -n1
}

# none | today | bad. "bad" = the file exists but is not a readable regular file with an IST date, or it is dated in the future (date after today, epoch more than 300 s ahead):
# the budget cannot be shown to be unspent, so no reboot. usb_budget_state [today]: today defaults to ist_date.
usb_budget_state() {
  local d ep today="${1:-}"
  [ -n "$today" ] || today="$(ist_date)"
  { [ -e "$USB_STATE" ] || [ -L "$USB_STATE" ]; } || { echo none; return; }
  if [ ! -f "$USB_STATE" ] || [ -L "$USB_STATE" ] || [ ! -r "$USB_STATE" ]; then echo bad; return; fi
  d="$(usb_state_get date)"
  case "$d" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) echo bad; return ;; esac
  case "$today" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) if [ "$((10#$d))" -gt "$((10#$today))" ]; then echo bad; return; fi ;;
  esac
  ep="$(usb_state_get epoch)"
  case "$ep" in
    ''|*[!0-9]*)
      # R15b (N1): the file exists, so an empty or non-digit epoch (abc, 12x, " 5", +5, 1e9) is a planted or damaged file: the budget cannot be shown to be unspent.
      # The one file without an epoch line is the void marker usb_state_restore writes (date=00000000, verify=void, no epoch line at all).
      if [ -z "$ep" ] && [ "$(usb_state_get verify)" = void ] && ! "$G_GREP" -q '^epoch' "$USB_STATE" 2>/dev/null; then :; else echo bad; return; fi ;;
    0*) echo bad; return ;;   # R15 S-1: a leading zero is octal to bash arithmetic (or an error): the budget cannot be shown to be unspent
    *) if [ "${#ep}" -gt 15 ]; then echo bad; return; fi
       if [ "$((10#$ep))" -gt "$(( $(now_epoch) + 300 ))" ]; then echo bad; return; fi
       # B: spent when the epoch is later than now, or less than USB_BUDGET_S ago (stricter than "1 per IST day")
       if [ "$((10#$ep))" -gt "$(now_epoch)" ] || [ "$(( $(now_epoch) - 10#$ep ))" -lt "$USB_BUDGET_S" ]; then echo today; return; fi ;;
  esac
  if [ "$d" = "$today" ]; then echo today; else echo none; fi
}

# A fresh temp file inside the state dir (S6): mktemp creates it O_EXCL, so a planted name or symlink is never followed. Prints the path. Refuses a symlinked state dir or state path,
# and any leftover "$USB_STATE.tmp" (the old fixed name: something put it there).
usb_state_tmp() {
  local t
  [ ! -L "$STATE_DIR" ] && [ ! -L "$USB_STATE" ] || return 1
  [ ! -e "$USB_STATE.tmp" ] && [ ! -L "$USB_STATE.tmp" ] || return 1
  t="$("$G_MKTEMP" "$STATE_DIR/usb-reboot.XXXXXX" 2>/dev/null)" || return 1
  [ -f "$t" ] && [ ! -L "$t" ] || return 1
  printf '%s' "$t"
}

# usb_state_write <date> <epoch> <recorder_pid> <coreaudiod_pid> <boot_age_s> <port>: write via a temp file, then read it back. 0 only when USB_STATE is a regular,
# non-symlink file owned by the agent and the read-back is identical.
usb_state_write() {
  local tmp want got
  want="$(printf 'date=%s\nepoch=%s\nrecorder_pid=%s\ncoreaudiod_pid=%s\nboot_age_s=%s\nport=%s\nverify=pending' "$1" "$2" "$3" "$4" "$5" "$6")"
  mkdir -p "$STATE_DIR" 2>/dev/null
  tmp="$(usb_state_tmp)" || return 1
  printf '%s\n' "$want" >"$tmp" 2>/dev/null || return 1
  "$G_MV" -f "$tmp" "$USB_STATE" 2>/dev/null || return 1
  [ -f "$USB_STATE" ] && [ ! -L "$USB_STATE" ] && [ -O "$USB_STATE" ] || return 1
  got="$("$G_CAT" "$USB_STATE" 2>/dev/null)"
  [ "$got" = "$want" ]
}

# Put the previous state back after an abort between the write and the call (no delete: overwrite). Nothing before = a void marker with a date that is never today.
usb_state_restore() { # previous content (may be empty)
  local tmp
  tmp="$(usb_state_tmp)" || return 1
  if [ -n "$1" ]; then printf '%s\n' "$1" >"$tmp"; else printf 'date=00000000\nverify=void\n' >"$tmp"; fi 2>/dev/null
  "$G_MV" -f "$tmp" "$USB_STATE" 2>/dev/null
}

usb_state_set_verify() { # value
  local tmp
  tmp="$(usb_state_tmp)" || return 1
  "$G_SED" "s/^verify=.*/verify=$1/" "$USB_STATE" >"$tmp" 2>/dev/null && "$G_MV" -f "$tmp" "$USB_STATE" 2>/dev/null
}

# 0 while the rung is locked: 24 h after a failed verify, or until the fleet hand-reset file is newer than the lock. An unreadable lock counts as locked.
usb_lock_active() {
  local le now rm
  { [ -e "$USB_LOCK" ] || [ -L "$USB_LOCK" ]; } || return 1
  if [ ! -f "$USB_LOCK" ] || [ ! -r "$USB_LOCK" ]; then return 0; fi
  le="$("$G_SED" -n '1p' "$USB_LOCK" 2>/dev/null)"
  case "$le" in ''|*[!0-9]*) return 0 ;; esac
  if [ -f "$USB_RESET" ]; then
    rm="$("$G_STAT" -f %m "$USB_RESET" 2>/dev/null)"
    case "$rm" in ''|*[!0-9]*) ;; *) if [ "$rm" -gt "$le" ]; then audit "usb-reboot lock cleared by the hand-reset file"; return 1; fi ;; esac
  fi
  now="$(now_epoch)"
  [ "$((now - le))" -lt "$USB_LOCK_S" ]
}

# the guards / boot_age_s / recorder_pid members every d' heal event carries: usb_extra <ticks> <cc_age> <hid_idle> <hold> <port> <boot_before> <boot_after> <pid_before> <pid_after>
usb_extra() {
  printf '"guards":{"usb_absent_ticks":%s,"cc_power_off_age_s":%s,"hid_idle_s":%s,"consult_hold":%s,"port":%s},"boot_age_s":{"before":%s,"after":%s},"recorder_pid":{"before":%s,"after":%s}' \
    "$(jnum "$1")" "$(jnum "$2")" "$(jnum "$3")" "$(jstr "$4")" "$(jstr "$5")" "$(jnum "$6")" "$(jnum "$7")" "$(jnum "$8")" "$(jnum "$9")"
}

# A d' exit that does not reboot (M1): the C270 is off the bus and the power-off line is in the log, so the rung d page must not be lost.
# usb_noreboot <why>: escalate usb_device_missing (the shared 600 s dedupe) and clear HEAL_EXTRA. The would_do / abort / failure event, if any, was already published.
usb_noreboot() { # before why
  escalate usb_device_missing usb "$1 $2"
  HEAL_EXTRA=""
}

heal_usb_power_off() { # evidence (unused: the guards are re-read here)
  local idle hold port ticks age before bstate prior now rc idate t_act
  HEAL_EXTRA=""
  now="$(now_epoch)"
  ticks="${S_usb_ticks:-0}"; age="${S_cc_age:-}"; port="${S_cc_port:-unknown}"
  idle="$(hid_idle_s)"; case "$idle" in ''|*[!0-9]*) idle="" ;; esac
  hold="set"; consult_hold_clear && hold="clear"
  before="usb_mic_present=false usb_absent_ticks=$ticks cc_power_off_age_s=${age:-null} hid_idle_s=${idle:-null} consult_hold=$hold port=$port"
  HEAL_EXTRA="$(usb_extra "$ticks" "$age" "$idle" "$hold" "$port" "$S_boot_age" "" "$S_rec_pid" "")"
  # G3: this rung runs only while the capture device is off the bus
  if [ "$S_usb" != "false" ]; then HEAL_EXTRA=""; return 0; fi
  # HID idle unreadable or under 600 s: no action. A person may be at the screen; it stays rung d (escalate only).
  if [ -z "$idle" ] || [ "$idle" -lt "$USB_HID_IDLE_MIN_S" ]; then usb_noreboot "$before" hid_busy; return 0; fi
  if usb_lock_active; then usb_noreboot "$before" rung_locked; return 0; fi
  # S5: the IST date must be exactly 8 digits, read once; no reboot without it
  idate="$(ist_date)"
  case "$idate" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) usb_noreboot "$before" ist_date_failed; return 1 ;; esac
  # C: while the post-boot verify is pending the reboot is still being proven: no d' at all (the verify path rules)
  if [ -f "$USB_STATE" ] && [ "$(usb_state_get verify)" = "pending" ]; then usb_noreboot "$before" verify_pending; return 0; fi
  bstate="$(usb_budget_state "$idate")"
  # R15 S-1: exactly "none" may go on. today = recurring page; anything else (bad, or an empty or unknown answer from a failed read) = no reboot.
  case "$bstate" in
    none) ;;
    today) escalate usb_power_off_recurring usb "$before"; HEAL_EXTRA=""; return 0 ;;
    *) usb_noreboot "$before" state_unreadable; return 0 ;;
  esac
  # the consult hold: set, missing, unreadable or true = no reboot (would_do only, and not counted against the G6 cap)
  if [ "$hold" != "clear" ]; then
    once_per "would:usb:usb_power_off:hold" 300 && heal_event would_do usb usb_power_off "$before" "" "WOULD-DO blocked=consult_hold" true
    usb_noreboot "$before" consult_hold; return 1
  fi
  # A: the shipped build keeps d' in SHADOW whatever the mode: would_do + the rung d page, no act_begin, no state, no reboot
  if [ "$USB_DPRIME_HEAL" != 1 ]; then
    once_per "would:usb:usb_power_off:dprime" 300 && heal_event would_do usb usb_power_off "$before" "" "WOULD-DO blocked=dprime_shadow" true
    usb_noreboot "$before" dprime_shadow; return 1
  fi
  act_begin usb usb_power_off "$before" || { usb_noreboot "$before" not_acting; return 1; }
  prior="$("$G_CAT" "$USB_STATE" 2>/dev/null)"
  if ! usb_state_write "$idate" "$now" "$S_rec_pid" "$S_ca_pid" "$S_boot_age" "$port"; then
    audit "usb-reboot state write failed: no reboot"
    heal_event heal usb usb_power_off "$before" "" "state_write_failed" false "$(target_for usb_reboot_failed)" page
    usb_noreboot "$before" state_write_failed; return 1
  fi
  # second kill-switch read, immediately before the root call (spec: < 2 s). Nothing slow sits between here and root_do.
  if ! act_step || ! consult_hold_clear; then
    usb_state_restore "$prior"
    heal_event abort usb usb_power_off "$before" "" "aborted_before_reboot" false
    usb_noreboot "$before" aborted; return 1
  fi
  t_act="$(now_epoch)"
  # S3: the C270 may have been replugged since the collector read it (up to ~10 s ago). Present, or the read failing, = no reboot.
  # R15 S-2: the re-read runs under run_capped 1; a timeout (rc 124) is not "absent", so it aborts as device_back. It sits between the second kill read and root_do.
  run_capped 1 "$STATE_DIR/usb_present.out" usb_present_now; rc=$?
  : >"$STATE_DIR/usb_present.out" 2>/dev/null
  if [ "$rc" -ne 1 ]; then
    usb_state_restore "$prior"
    heal_event abort usb usb_power_off "$before" "" "aborted_device_back" false
    usb_noreboot "$before" device_back; return 1
  fi
  # R15 S-2: the kill read is only good for about a second. More than 1 s from the second kill read to the root call = abort and escalate.
  if [ "$(( $(now_epoch) - t_act ))" -gt 1 ]; then
    usb_state_restore "$prior"
    heal_event abort usb usb_power_off "$before" "" "aborted_before_reboot" false
    usb_noreboot "$before" slow_to_root; return 1
  fi
  root_do reboot >/dev/null 2>&1; rc=$?
  if [ "$rc" -eq 0 ]; then
    USB_REBOOT_ISSUED=1
    audit "usb-reboot: reboot verb issued port=$port"
    heal_event kiosk_reboot usb usb_power_off "$before" "reboot_issued" "reboot_issued" false "$(target_for usb_power_off)" info
  else
    # the budget stays spent and the state stays verify=pending: the verify path times it out (usb_reboot_failed + lock)
    heal_event kiosk_reboot usb usb_power_off "$before" "reboot_verb_rc=$rc" "reboot_failed" false "$(target_for usb_reboot_failed)" page
    escalate usb_reboot_failed usb "$before reboot_verb_rc=$rc"
  fi
  HEAL_EXTRA=""
  return 0
}

# Post-boot verify, kiosk side (the Mini checks the day start, a fresh piece and zero_ratio). Runs every tick while the state says verify=pending. Reporting and the lock only: no action on the room.
# healed_pending: the device is back, the recorder runs with one tapewriter, and the boot is newer than the reboot. Failed: not so within 10 min of the reboot -> escalate usb_reboot_failed and lock 24 h.
usb_reboot_verify() {
  local ep now bb rp before le
  [ -f "$USB_STATE" ] && [ -r "$USB_STATE" ] || return 0
  [ "$(usb_state_get verify)" = "pending" ] || return 0
  ep="$(usb_state_get epoch)"; case "$ep" in ''|*[!0-9]*|0*) return 0 ;; esac   # R15 S-1: a leading-zero epoch is not read as octal; the state stays pending and d' stays blocked
  [ "${#ep}" -le 15 ] || return 0
  now="$(now_epoch)"
  bb="$(usb_state_get boot_age_s)"; rp="$(usb_state_get recorder_pid)"
  before="usb_mic_present=${S_usb:-null} recorder_running=${S_rec_running:-null} tapewriters=$(tapewriter_count) boot_age_s=${S_boot_age:-null} reboot_age_s=$((now - ep))"
  HEAL_EXTRA="$(usb_extra "" "" "" "" "$(usb_state_get port)" "$bb" "$S_boot_age" "$rp" "$S_rec_pid")"
  if [ -n "$S_boot_age" ] && [ "$S_boot_age" -lt "$((now - ep))" ] 2>/dev/null && [ "$S_usb" = "true" ] && [ "$S_rec_running" = "true" ] && [ "$(tapewriter_count)" = "1" ]; then
    usb_state_set_verify healed_pending
    # R15 N1: when the state cannot be rewritten (a leftover temp file) it stays pending, so this branch repeats: one healed_pending event per reboot epoch
    once_per "usb:healed_pending:$ep" "$USB_LOCK_S" && heal_event kiosk_reboot usb usb_power_off "$before" "healed_pending" "healed_pending" false "$(target_for usb_power_off)" info
  elif [ "$((now - ep))" -gt "$USB_VERIFY_S" ]; then
    usb_state_set_verify failed
    # R15 N1: the lock is written once per reboot epoch (its epoch is never refreshed by a later tick); a lock at or after this reboot's epoch is already this failure's lock
    le="$("$G_SED" -n '1p' "$USB_LOCK" 2>/dev/null)"
    case "$le" in ''|*[!0-9]*) le=0 ;; esac
    if [ "${#le}" -gt 15 ] || [ "$((10#$le))" -lt "$ep" ]; then
      printf '%s\n' "$now" >"$USB_LOCK" 2>/dev/null
      audit "usb-reboot verify failed: rung locked for ${USB_LOCK_S}s"
    fi
    escalate usb_reboot_failed usb "$before"
  fi
  HEAL_EXTRA=""
  return 0
}

# Walk the tree; act on each fault in order; after a real fix re-collect and start over (faults stack).
heal_cycle() {
  local pass=0 faults layer verdict evidence
  # S1: once a reboot is issued the machine is going down; no rung acts again for the agent's lifetime
  [ "${USB_REBOOT_ISSUED:-0}" = 1 ] && return 0
  usb_reboot_verify
  while [ "$pass" -lt 3 ]; do
    pass=$((pass + 1)); HEAL_CHANGED=0; HEAL_PASSES=$pass
    faults="$(fault_tree)"
    while IFS='|' read -r layer verdict evidence; do
      [ -n "$verdict" ] || continue
      case "$verdict" in
        mic_denied)
          # R16 (RC-4) / R16c (S4): heal_tcc runs only on a numeric row. Unreadable (error*), garbage, empty or none: escalate only, no root call, no action spent.
          case "${S_tcc_row:-}" in ''|*[!0-9]*) escalate "$verdict" "$layer" "$evidence" ;; *) heal_tcc ;; esac ;;
        coreaudio_no_device) heal_coreaudiod ;;
        usb_power_off) heal_usb_power_off "$evidence" ;;
        recorder_not_running|recorder_hung|recorder_needs_enrol) heal_recorder "$verdict" ;;
        presence_stale) heal_chrome ;;
        pmset_drift|launchagent_missing|autologin_changed) heal_drift "$verdict" ;;
        usb_device_missing|mic_restricted|mic_row_missing|recorder_failed|recorder_crash_loop|recorder_capture_stalled|helper_xpc_down|disk_low|server_retired|server_disabled|coreaudio_rms_dead)
          escalate "$verdict" "$layer" "$evidence" ;;
        power_rebooted) once_per "info:power_rebooted" 3600 && heal_event info "$layer" "$verdict" "$evidence" "" noted "$([ "$(current_mode)" = heal ] && echo false || echo true)" ;;
        *) : ;; # network_offline, upload_pending: the recorder retries itself
      esac
      [ "${USB_REBOOT_ISSUED:-0}" = 1 ] && return 0   # the machine is going down: nothing else acts this tick
      [ "$HEAL_CHANGED" -eq 1 ] && break
    done <<EOF
$faults
EOF
    [ "$HEAL_CHANGED" -eq 1 ] || break
    collect_all
  done
}
