#!/bin/bash
# shellcheck disable=SC2034,SC2154
# Kiosk Guardian: fault tree (spec 2.3, A3). Pure function of the S_* snapshot.
# Output: one line per fault, in tree order: layer|verdict|evidence
# Faults stack (OPD 4): every fault is listed; the caller fixes, re-collects and re-runs from the top.
# CoreAudio (layer 4) is evaluated in its place but its verdict is held back until layers 5-9 are
# clear (A3 cross-cutting note, spec 2.4b): killing coreaudiod never fixed a permission or 409 fault.

# <=80 chars of printable ASCII (control bytes and non-ASCII dropped, runs of blanks collapsed, then trimmed); "null" when nothing is left
fault_err80() {
  local e
  e="$(printf '%s' "$1" | LC_ALL=C "$G_TR" '\n\t\r' '   ' | LC_ALL=C "$G_TR" -cd ' -~' | "$G_TR" -s ' ' | "$G_SED" -e 's/^ //' -e 's/ $//' | "$G_HEAD" -c 80 | "$G_SED" -e 's/ $//')"
  [ -n "$e" ] && printf '%s' "$e" || printf 'null'
}

fault_tree() {
  local ca_held="" l59=0 k

  # 1 power / sleep
  if [ -n "$S_boot_age" ] && [ "$S_boot_age" -lt 900 ] 2>/dev/null; then
    echo "power|power_rebooted|boot_age_s=$S_boot_age"
  fi
  # 2 network / tailnet (the recorder's own view)
  case "$S_state" in
    offline) echo "network|network_offline|state=offline last_http=${S_last_http:-null}" ;;
  esac
  # 3 USB device
  # 3' (2.4 d') rung d' sits before d: absent for >= 2 ticks AND a fresh CC cable-detect "powering off" line. Absence without that line stays d (escalate only).
  if [ "$S_usb" = "false" ]; then
    case "${S_cc_age:-}" in
      ''|*[!0-9]*) echo "usb|usb_device_missing|usb_mic_present=false audio_engine_present=${S_engine:-null}" ;;
      *) if [ "${S_usb_ticks:-0}" -ge "$USB_ABSENT_MIN_TICKS" ] 2>/dev/null && [ "${S_usb_span:-0}" -ge "$USB_ABSENT_MIN_SPAN_S" ] 2>/dev/null; then
           echo "usb|usb_power_off|usb_mic_present=false usb_absent_ticks=$S_usb_ticks cc_power_off_age_s=$S_cc_age port=${S_cc_port:-unknown}"
         else
           echo "usb|usb_device_missing|usb_mic_present=false audio_engine_present=${S_engine:-null}"
         fi ;;
    esac
  fi
  # 4 CoreAudio (held)
  if [ "$S_usb" = "true" ] && [ "$S_engine" = "false" ]; then
    ca_held="coreaudio|coreaudio_no_device|usb_mic_present=true audio_engine_present=false coreaudiod_age_s=${S_ca_age:-null}"
  elif [ "$S_mic_state" = "authorized" ] && [ "$S_capture_open" = "true" ] && [ -n "$S_rms" ] && [ "${S_rms%.*}" -le -100 ] 2>/dev/null; then
    ca_held="coreaudio|coreaudio_rms_dead|rms_dbfs_2s=$S_rms capture_open=true mic_state=authorized"
  fi
  # 5 TCC permission
  case "$S_mic_state" in
    denied) echo "tcc|mic_denied|mic_state=denied tcc_row=${S_tcc_row:-null}"; l59=1 ;;
    restricted) echo "tcc|mic_restricted|mic_state=restricted"; l59=1 ;;
    *)
      if [ "$S_state" = "mic_denied" ]; then echo "tcc|mic_denied|state=mic_denied tcc_row=${S_tcc_row:-null}"; l59=1
      elif [ -z "$S_tcc_row" ] || [ "$S_tcc_row" = "2" ]; then :
      elif [ "$S_tcc_row" = "none" ]; then
        echo "tcc|mic_row_missing|tcc_row=none"; l59=1
      elif [[ $S_tcc_row =~ ^[0-9]+$ ]]; then
        echo "tcc|mic_denied|tcc_row=$S_tcc_row mic_state=${S_mic_state:-null}"; l59=1
      else
        # R15c + R16: error, error:read, error:<why> and ANY other non-numeric text = the row is UNKNOWN (the helper could not read TCC.db): no verdict, no l59, no page. Only a number other than 2 is a denial.
        # R16d NIT-1: the stamp key is bounded: the first 32 chars of the row, reduced to [A-Za-z0-9:_-]
        k="$(printf '%.32s' "$S_tcc_row" | LC_ALL=C "$G_TR" -c 'A-Za-z0-9:_-' '_')"
        once_per "tcc_row_unreadable:$k" 86400 && audit "tcc row unreadable: $S_tcc_row"
      fi ;;
  esac
  # 6 recorder process
  if [ "$S_rec_running" = "false" ]; then
    echo "recorder|recorder_not_running|pid=none state=${S_state:-null}"; l59=1
  elif [ "$(pid_changes_last_hour)" -ge 3 ] 2>/dev/null; then
    echo "recorder|recorder_crash_loop|pid_changes_1h=$(pid_changes_last_hour)"; l59=1
  elif [ -n "$S_poll_ok_age" ] && [ "$S_poll_ok_age" -gt "$HUNG_AFTER_S" ] && [ "$S_state" != "retired" ] && [ "$S_state" != "offline" ]; then
    echo "recorder|recorder_hung|last_poll_ok_age_s=$S_poll_ok_age last_http=${S_last_http:-null}"; l59=1
  fi
  case "$S_state" in
    needs_enrol) echo "recorder|recorder_needs_enrol|state=needs_enrol"; l59=1 ;;
    capture_stalled) echo "recorder|recorder_capture_stalled|state=capture_stalled"; l59=1 ;;
    # R16d: state=failed is its own fault (escalate only in heal.sh). last_error is printable ASCII only, whitespace collapsed, at most 80 chars; the JSON escape happens in heal_event.
    failed) echo "recorder|recorder_failed|state=failed last_error=$(fault_err80 "$S_last_error")"; l59=1 ;;
  esac
  # 7 helper (XPC)
  if [ "$S_helper_ok" = "false" ]; then echo "helper|helper_xpc_down|helper_xpc_ok=false"; l59=1; fi
  # 8 upload path
  if [ "$S_state" = "upload_pending" ] && [ -n "$S_pending" ] && [ "$S_pending" -gt 0 ] 2>/dev/null; then
    echo "upload|upload_pending|pending_piece_count=$S_pending"; l59=1
  fi
  if { [ -n "$S_disk_root" ] && [ "$S_disk_root" -lt 5 ]; } || { [ -n "$S_disk_home" ] && [ "$S_disk_home" -lt 5 ]; } 2>/dev/null; then
    echo "upload|disk_low|disk_free_pct_root=${S_disk_root:-null} disk_free_pct_home=${S_disk_home:-null}"; l59=1
  fi
  # 9 server install / room state (kiosk escalates only)
  if [ "$S_state" = "retired" ]; then echo "server|server_retired|state=retired last_http=${S_last_http:-null}"; l59=1; fi
  case "$S_last_error" in *room_disabled*|*"room is disabled"*) echo "server|server_disabled|last_error=room_disabled"; l59=1 ;; esac

  # 4 again: emit the held CoreAudio verdict only when 5-9 are clear
  if [ -n "$ca_held" ] && [ "$l59" -eq 0 ]; then echo "$ca_held"; fi

  # 10 Presence / Chrome
  if [ -n "$S_presence_age" ] && [ "$S_presence_age" -gt "$PRESENCE_STALE_S" ] 2>/dev/null; then
    echo "presence|presence_stale|presence_heartbeat_age_s=$S_presence_age"
  fi
  # drift (spec 2.4g)
  drift_faults
}

# pmset baseline, auto-login unchanged, recorder LaunchAgent present
drift_faults() {
  local sleepv autorst baseline cur
  sleepv="$(pmset -g 2>/dev/null | awk '$1 == "sleep" { print $2; exit }')"
  autorst="$(pmset -g 2>/dev/null | awk '$1 == "autorestart" { print $2; exit }')"
  if { [ -n "$sleepv" ] && [ "$sleepv" != "0" ]; } || { [ -n "$autorst" ] && [ "$autorst" != "1" ]; }; then
    echo "drift|pmset_drift|sleep=${sleepv:-null} autorestart=${autorst:-null}"
  fi
  cur="$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null)"
  mkdir -p "$STATE_DIR" 2>/dev/null
  baseline="$STATE_DIR/autologin_baseline"
  if [ ! -e "$baseline" ]; then
    printf '%s\n' "${cur:-none}" >"$baseline"
  elif [ "$(cat "$baseline")" != "${cur:-none}" ]; then
    echo "drift|autologin_changed|autologin_user_changed=true"
  fi
  if [ ! -e "$RR_PLIST" ]; then echo "drift|launchagent_missing|plist_present=false"; fi
}

# USB enumeration-failure ladder trigger (kept out of fault_tree so its verdict list is unchanged).
# Prints "absent" (the mic class is off the USB bus and the d' power-off rung does not own it), "no_input" (on the bus, zero CoreAudio input engine), or nothing.
# New codes: usb_enum_reboot (rung B, the allowlisted heal code), room_device_unplugged (rung C, escalate only).
usb_enum_fault_kind() {
  if [ "$S_usb" = "false" ]; then
    [ "${S_usb_ticks:-0}" -ge "$USB_ABSENT_MIN_TICKS" ] 2>/dev/null && [ "${S_usb_span:-0}" -ge "$USB_ABSENT_MIN_SPAN_S" ] 2>/dev/null || return 0
    case "${S_cc_age:-}" in ''|*[!0-9]*) echo absent ;; esac   # a fresh cable-detect line = rung d', which has priority
  elif [ "$S_usb" = "true" ] && [ "$S_engine" = "false" ]; then
    echo no_input
  fi
  [ "$S_usb" = "false" ] || [ "$S_engine" = "false" ] || { usb_enum_rec_trigger && echo rec_failed; }
  return 0
}

# R4: the recorder itself reports the start failure (state=failed with the tapewriter start-failure signature in last_error). rec_ioret = the IOKit code kIOReturnNotResponding (0xE00002ED = -536870163).
usb_enum_rec_ioret() { case "${S_last_error:-}" in *-536870163*|*0xE00002ED*|*0xe00002ed*) return 0 ;; esac; return 1; }
usb_enum_rec_trigger() {
  [ "${S_state:-}" = failed ] || return 1
  case "${S_last_error:-}" in *"tapewriter exited with status 1"*|*physical_fallback_required*) return 0 ;; esac
  usb_enum_rec_ioret
}
