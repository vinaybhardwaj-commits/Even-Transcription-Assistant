#!/bin/bash
# shellcheck disable=SC2034,SC2154
# Kiosk Guardian: probe responder (spec 2.2, A2). `probe <room> <id>` -> one reply on
# kiosk/<room>/probe-reply. Every A2 row runs in parallel with its own 2.5 s cap; the reply publish is capped at 1.5 s, so check + publish <= 5 s; a timeout is a verdict.

PROBE_CAP_S="${PROBE_CAP_S:-2.5}"

# Each check writes "name=value" to $dir/<name>. The wrapper records "timeout" when the cap fires.
probe_check() { # dir name function
  local dir="$1" name="$2" fn="$3" rc
  run_capped "$PROBE_CAP_S" "$dir/$name.raw" "$fn"
  rc=$?
  if [ "$rc" -eq 124 ]; then printf 'timeout' >"$dir/$name"; else tr -d '\n' <"$dir/$name.raw" >"$dir/$name"; fi
}

pc_rms()        { local r; r="$(rms_dbfs_2s)"; echo "${r:-no_capture}"; }
pc_tcc()        { printf '%s/%s' "$(json_get "$STATUS_JSON" mic_state)" "$(root_do tcc-row "$(id -un)" 2>/dev/null | cut -d'|' -f1)"; }
pc_usb()        { ioreg -r -c IOUSBHostDevice -l -d 2 -w0 | grep -q -- "$USB_MIC_PATTERN" && echo present || echo absent; }
pc_engine()     { ioreg -r -c IOAudioEngine -d 1 -w0 | grep -q -- "$USB_MIC_PATTERN" && echo present || echo absent; }
pc_default_in() { system_profiler SPAudioDataType -json | grep -c 'coreaudio_default_audio_input_device' | sed 's/^0$/none/; s/^[1-9][0-9]*$/set/'; }
pc_coreaudiod() { local p; p="$(pgrep -x coreaudiod | head -n1)"; [ -n "$p" ] && echo "pid_age_s=$(pid_age_s "$p")" || echo none; }
pc_recorder()   { local p; p="$(recorder_pid)"; echo "pid_age_s=$([ -n "$p" ] && pid_age_s "$p" || echo none) state=$(json_get "$STATUS_JSON" state) last_http=$(json_get "$STATUS_JSON" last_http)"; }
pc_helper() {
  local h="$RR_APP/Contents/MacOS/room-recorder"
  if [ -x "$h" ]; then "$h" probe-helper >/dev/null 2>&1 && echo ok || echo fail
  else echo "status=$(json_get "$STATUS_JSON" helper_xpc_ok)"; fi
}
pc_upload()     { echo "pending=$(json_get "$STATUS_JSON" pending_piece_count)"; }
pc_presence()   { if pgrep -x "Google Chrome" >/dev/null 2>&1; then echo chrome_alive; else echo chrome_absent; fi; }
pc_disk()       { echo "root=$(disk_free_pct /) home=$(disk_free_pct "$HOME")"; }
pc_power()      { echo "sleep=$(pmset -g | awk '$1=="sleep"{print $2; exit}') boot_age_s=$(boot_age_s)"; }

probe_run() { # id
  local id="$1" dir ts name v verdict first=1 body=""
  dir="$(mktemp -d "$STATE_DIR/probe.XXXXXX" 2>/dev/null)" || return 1
  ts="$(now_epoch)"
  probe_check "$dir" rms_dbfs_2s pc_rms &
  probe_check "$dir" tcc pc_tcc &
  probe_check "$dir" usb pc_usb &
  probe_check "$dir" audio_engine pc_engine &
  probe_check "$dir" default_input pc_default_in &
  probe_check "$dir" coreaudiod pc_coreaudiod &
  probe_check "$dir" recorder pc_recorder &
  probe_check "$dir" helper pc_helper &
  probe_check "$dir" upload pc_upload &
  probe_check "$dir" presence pc_presence &
  probe_check "$dir" disk pc_disk &
  probe_check "$dir" power pc_power &
  wait
  for name in rms_dbfs_2s tcc usb audio_engine default_input coreaudiod recorder helper upload presence disk power; do
    v="$(cat "$dir/$name" 2>/dev/null)"
    [ "$first" -eq 1 ] || body="$body,"
    first=0
    body="$body\"$name\":$(jstr "$v")"
  done
  verdict="ok"
  if [ "$(cat "$dir/default_input" 2>/dev/null)" = "timeout" ]; then verdict="coreaudio_unresponsive"
  elif [ "$(cat "$dir/coreaudiod" 2>/dev/null)" = "timeout" ]; then verdict="coreaudiod_check_timeout"
  elif [ "$(cat "$dir/usb" 2>/dev/null)" = "absent" ]; then verdict="usb_device_missing"
  elif [ "$(cat "$dir/usb" 2>/dev/null)/$(cat "$dir/audio_engine" 2>/dev/null)" = "present/absent" ]; then verdict="coreaudio_no_device"
  fi
  PUBLISH_CAP_S=1.5 publish "kiosk/$GUARDIAN_ROOM/probe-reply" "$(printf '{"room_id":%s,"probe_id":%s,"ts":%s,"verdict":%s,"checks":{%s}}' "$(jstr "$GUARDIAN_ROOM")" "$(jstr "$id")" "$ts" "$(jstr "$verdict")" "$body")"
  rm -f "$dir"/* 2>/dev/null
  rmdir "$dir" 2>/dev/null
}

# One subscribed line: "<topic>\t<payload>". Payload form: probe <room> <id>
handle_message() {
  local topic="$1" payload="$2" verb room id
  case "$topic" in "kiosk/$GUARDIAN_ROOM/probe") ;; *) return 0 ;; esac
  # shellcheck disable=SC2086
  set -- $payload
  verb="$1"; room="$2"; id="$3"
  [ "$verb" = "probe" ] && [ "$room" = "$GUARDIAN_ROOM" ] || return 0
  case "$id" in ''|*[!A-Za-z0-9_-]*) return 0 ;; esac
  [ "${#id}" -le 64 ] || return 0
  probe_run "$id"
}
