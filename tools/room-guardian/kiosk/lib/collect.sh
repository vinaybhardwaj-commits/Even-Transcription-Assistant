#!/bin/bash
# shellcheck disable=SC2034,SC2154
# Kiosk Guardian: snapshot collector (spec 2.1) and health line. Read-only on the kiosk.
# Fills S_* globals. Unknown values stay empty and print as null.

STATUS_JSON="$RR_ROOT/status.json"
RR_CONFIG_JSON="$RR_ROOT/config.json"
LAUNCHD_LOG="$RR_ROOT/launchd.log"

# dBFS of the last 2 s (64000 B of 16 kHz mono s16le) of the newest tape.pcm written < 5 s ago.
# Reads the recorder's own file; never opens a capture (A2 row 1). Prints a number, or nothing.
rms_dbfs_2s() {
  local f="" size off now mt
  # shellcheck disable=SC2012
  f="$(ls -t "$RR_ROOT"/captures/*/seg_*/tape.pcm 2>/dev/null | head -n1)"
  [ -n "$f" ] || return 0
  now="$(now_epoch)"; mt="$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null)"
  [ -n "$mt" ] || return 0
  [ "$((now - mt))" -ge -2 ] && [ "$((now - mt))" -lt 5 ] || return 0   # a tape mtime in the future is not advancing
  size="$(stat -f %z "$f" 2>/dev/null || stat -c %s "$f" 2>/dev/null)"
  [ -n "$size" ] && [ "$size" -ge 2 ] || return 0
  off=$((size - 64000)); [ "$off" -lt 0 ] && off=0
  off=$((off / 2 * 2))
  tail -c "+$((off + 1))" "$f" 2>/dev/null | head -c 64000 | od -An -v -t d2 | awk '
    { for (i = 1; i <= NF; i++) { s += $i * $i; n++ } }
    END { if (n == 0) exit; r = sqrt(s / n) / 32768; if (r <= 0) printf "-120.0\n"; else printf "%.1f\n", 20 * log(r) / log(10) }'
}

pid_age_s() { # pid -> seconds
  local e
  e="$(ps -o etime= -p "$1" 2>/dev/null)"
  [ -n "$e" ] && etime_to_s "$e"
}

recorder_pid() {
  launchctl print "gui/$(id -u)/$RR_LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = [0-9]+/ { print $3; exit }'
}

disk_free_pct() { # path
  df -Pk "$1" 2>/dev/null | awk 'NR==2 { gsub("%", "", $5); print 100 - $5 }'
}

boot_age_s() {
  local sec
  sec="$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^{ sec = \([0-9]*\).*/\1/p')"
  [ -n "$sec" ] && echo "$(( $(now_epoch) - sec ))"
}

# 2.4 d': consecutive health ticks with the capture device absent from IOUSB. File "count last_epoch". A second collect inside the same tick (heal re-collect,
# < 5 s later) does not count; a gap over 60 s breaks "consecutive" and restarts at 1. Present = 0.
usb_ticks_update() {
  local f="$STATE_DIR/usb_absent" now cnt last
  now="$(now_epoch)"
  mkdir -p "$STATE_DIR" 2>/dev/null
  cnt="$(awk 'NR==1 { print $1 }' "$f" 2>/dev/null)"; last="$(awk 'NR==1 { print $2 }' "$f" 2>/dev/null)"
  case "$cnt" in ''|*[!0-9]*) cnt=0 ;; esac
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  if [ "$S_usb" = "true" ]; then
    [ "$cnt" = 0 ] || printf '0 %s\n' "$now" >"$f"
    S_usb_ticks=0; return 0
  fi
  if [ "$cnt" -gt 0 ] && [ "$((now - last))" -gt 60 ]; then cnt=0; fi
  if [ "$cnt" -eq 0 ]; then cnt=1; last="$now"
  elif [ "$((now - last))" -ge 5 ] && [ "$cnt" -lt 1000 ]; then cnt=$((cnt + 1)); last="$now"; fi
  printf '%s %s\n' "$cnt" "$last" >"$f"
  S_usb_ticks="$cnt"
}

# 2.4 d': the cable-detect probe. Pinned log reader, fixed predicate, 4 s cap, clean environment (same path as the conf commands). Read-only.
# Sets S_cc_age (seconds since the newest matching line, empty when none) and S_cc_port (the port name only). A timeout, an error or no line = no trigger.
# A negative result is cached 50 s so a pulled cable does not run the log reader every 10 s tick.
usb_cc_probe() {
  local out="$STATE_DIR/cc_probe.out" neg="$STATE_DIR/cc_probe.neg" now line ts e age port last
  S_cc_age=""; S_cc_port=""
  now="$(now_epoch)"
  mkdir -p "$STATE_DIR" 2>/dev/null
  last="$(awk 'NR==1 { print $1 }' "$neg" 2>/dev/null)"
  case "$last" in ''|*[!0-9]*) ;; *) [ "$((now - last))" -ge 0 ] && [ "$((now - last))" -lt 50 ] && return 0 ;; esac
  if ! run_capped "$USB_LOG_CAP_S" "$out" g_clean_exec "$G_LOG" show --last 15m --style compact --predicate "$USB_LOG_PREDICATE"; then printf '%s\n' "$now" >"$neg"; return 0; fi
  line="$("$G_GREP" -F 'AppleUSBHostPort::cableChangeOccurred: powering off' "$out" 2>/dev/null | "$G_TAIL" -n1)"
  ts="${line:0:19}"
  if [ -n "$line" ] && [[ $ts =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}$ ]]; then
    e="$("$G_DATE" -j -f '%Y-%m-%d %H:%M:%S' "$ts" +%s 2>/dev/null)"
    case "$e" in ''|*[!0-9]*) e="" ;; esac
  else e=""; fi
  if [ -n "$e" ]; then
    age=$((now - e))
    if [ "$age" -ge -5 ] && [ "$age" -le "$USB_CC_MAX_AGE_S" ]; then
      [ "$age" -ge 0 ] || age=0
      port="$(printf '%s\n' "$line" | "$G_SED" -n 's/.*[[:space:]]\([A-Za-z0-9_.@-]*\): AppleUSBHostPort::cableChangeOccurred: powering off.*/\1/p' | "$G_HEAD" -n1)"
      case "$port" in ''|*[!A-Za-z0-9_.@-]*) port=unknown ;; esac
      [ "${#port}" -le 64 ] || port=unknown
      S_cc_age="$age"; S_cc_port="$port"
      return 0
    fi
  fi
  printf '%s\n' "$now" >"$neg"
}

hid_idle_s() {
  ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/ { print int($NF / 1000000000); exit }'
}

# Root TCC row, cached 60 s (spec 2.2). Sets S_tcc_row to the auth_value, "none", or "error".
tcc_row_cached() {
  local f="$STATE_DIR/tcc_row" now last
  now="$(now_epoch)"
  mkdir -p "$STATE_DIR" 2>/dev/null
  if [ -r "$f" ]; then
    last="$(sed -n '1p' "$f")"
    if [ -n "$last" ] && [ "$((now - last))" -lt 60 ]; then S_tcc_row="$(sed -n '2p' "$f")"; return 0; fi
  fi
  local out
  out="$(root_do tcc-row "$(id -un)" 2>/dev/null)" || out="error"
  S_tcc_row="${out%%|*}"
  [ -n "$S_tcc_row" ] || S_tcc_row="error"
  printf '%s\n%s\n' "$now" "$S_tcc_row" >"$f"
}

# G2 presence evidence. Kiosks are unattended, so HID idle says nothing; speech on the tape does.
rms_is_speech() { # dBFS -> 0 when at or above the speech gate
  [ -n "$1" ] && awk -v r="$1" -v g="$SPEECH_GATE_DBFS" 'BEGIN { exit !(r + 0 >= g + 0) }'
}
note_speech() { # remember when the tape last held speech
  rms_is_speech "$S_rms" || return 0
  mkdir -p "$STATE_DIR" 2>/dev/null
  printf '%s\n' "$(now_epoch)" >"$STATE_DIR/speech_seen"
}
# 0 when speech was seen in the last SPEECH_QUIET_S, or a capture is open and we cannot show it is quiet.
speech_recent() {
  local last
  rms_is_speech "$S_rms" && return 0
  last="$(cat "$STATE_DIR/speech_seen" 2>/dev/null)"
  case "$last" in ''|*[!0-9]*) ;; *) [ "$(( $(now_epoch) - last ))" -lt "$SPEECH_QUIET_S" ] && return 0 ;; esac
  [ "$S_capture_open" = "true" ] && [ -z "$S_rms" ] && return 0
  return 1
}

collect_all() {
  local now ts e
  now="$(now_epoch)"
  S_state="$(json_get "$STATUS_JSON" state)"
  S_mic_state="$(json_get "$STATUS_JSON" mic_state)"
  S_capture_open="$(json_get "$STATUS_JSON" capture_open)"
  S_pending="$(json_get "$STATUS_JSON" pending_piece_count)"
  S_helper_ok="$(json_get "$STATUS_JSON" helper_xpc_ok)"
  S_last_http="$(json_get "$STATUS_JSON" last_http)"
  S_last_error="$(json_get "$STATUS_JSON" last_error)"
  S_install_id="$(json_get "$RR_CONFIG_JSON" install_id)"
  ts="$(ts_to_epoch "$(json_get "$STATUS_JSON" last_poll_ok_at)")"
  S_poll_ok_age=""; [ -n "$ts" ] && S_poll_ok_age=$((now - ts))
  ts="$(ts_to_epoch "$(json_get "$STATUS_JSON" updated_at)")"
  S_status_age=""; [ -n "$ts" ] && S_status_age=$((now - ts))
  S_rms="$(rms_dbfs_2s)"
  note_speech

  S_usb=false; S_engine=false
  if ioreg -r -c IOUSBHostDevice -l -d 2 -w0 2>/dev/null | grep -q -- "$USB_MIC_PATTERN"; then S_usb=true; fi
  if ioreg -r -c IOAudioEngine -d 1 -w0 2>/dev/null | grep -q -- "$USB_MIC_PATTERN"; then S_engine=true; fi
  S_usb_ticks=0; S_cc_age=""; S_cc_port=""
  usb_ticks_update
  if [ "$S_usb" = "false" ] && [ "$S_usb_ticks" -ge "$USB_ABSENT_MIN_TICKS" ]; then usb_cc_probe; fi

  S_ca_pid="$(pgrep -x coreaudiod 2>/dev/null | head -n1)"
  S_ca_age=""; [ -n "$S_ca_pid" ] && S_ca_age="$(pid_age_s "$S_ca_pid")"
  S_rec_pid="$(recorder_pid)"
  S_rec_running=false; S_rec_age=""
  if [ -n "$S_rec_pid" ]; then S_rec_running=true; S_rec_age="$(pid_age_s "$S_rec_pid")"; fi
  record_pid_change

  S_disk_root="$(disk_free_pct /)"
  S_disk_home="$(disk_free_pct "$HOME")"
  S_boot_age="$(boot_age_s)"
  S_presence_age=""
  if [ -n "$PRESENCE_FILE" ] && [ -e "$PRESENCE_FILE" ]; then
    e="$(stat -f %m "$PRESENCE_FILE" 2>/dev/null || stat -c %Y "$PRESENCE_FILE" 2>/dev/null)"
    [ -n "$e" ] && S_presence_age=$((now - e))
  fi
  S_tcc_row=""
  tcc_row_cached
  S_mode="$(current_mode)"
}

# crash-loop evidence: one line "epoch pid" per observed recorder pid change
record_pid_change() {
  local f="$STATE_DIR/rec_pids" lastpid
  [ -n "$S_rec_pid" ] || return 0
  mkdir -p "$STATE_DIR" 2>/dev/null
  lastpid="$(tail -n1 "$f" 2>/dev/null | awk '{print $2}')"
  [ "$lastpid" = "$S_rec_pid" ] || printf '%s %s\n' "$(now_epoch)" "$S_rec_pid" >>"$f"
}

pid_changes_last_hour() {
  local f="$STATE_DIR/rec_pids" cut
  cut=$(( $(now_epoch) - 3600 ))
  [ -r "$f" ] || { echo 0; return; }
  awk -v c="$cut" '$1 >= c { n++ } END { print n + 0 }' "$f"
}

health_line() {
  printf '{"room_id":%s,"install_id":%s,"ts":%s,"state":%s,"mic_state":%s,"capture_open":%s,"pending_piece_count":%s,"rms_dbfs_2s":%s,"usb_mic_present":%s,"audio_engine_present":%s,"coreaudiod_age_s":%s,"recorder_pid_age_s":%s,"helper_xpc_ok":%s,"last_poll_ok_age_s":%s,"last_http":%s,"disk_free_pct_root":%s,"disk_free_pct_home":%s,"boot_age_s":%s,"presence_heartbeat_age_s":%s,"mode":%s,"guardian":%s}' \
    "$(jstr "$GUARDIAN_ROOM")" "$(jstr "$S_install_id")" "$(now_epoch)" "$(jstr "$S_state")" "$(jstr "$S_mic_state")" \
    "$(jbool "$S_capture_open")" "$(jnum "$S_pending")" "$(jnum "$S_rms")" "$(jbool "$S_usb")" "$(jbool "$S_engine")" \
    "$(jnum "$S_ca_age")" "$(jnum "$S_rec_age")" "$(jbool "$S_helper_ok")" "$(jnum "$S_poll_ok_age")" "$(jnum "$S_last_http")" \
    "$(jnum "$S_disk_root")" "$(jnum "$S_disk_home")" "$(jnum "$S_boot_age")" "$(jnum "$S_presence_age")" \
    "$(jstr "$S_mode")" "$(jstr "$GUARDIAN_VERSION")"
}
