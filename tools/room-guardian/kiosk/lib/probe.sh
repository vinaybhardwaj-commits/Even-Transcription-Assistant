#!/bin/bash
# shellcheck disable=SC2034,SC2154
# Kiosk Guardian: probe responder (spec 2.2, A2). `probe <room> <id>` -> one reply on
# kiosk/<room>/probe-reply. Every A2 row runs in parallel; a timeout is a verdict.
# One DEADLINE from probe start (PROBE_BUDGET_MS, 4.0 s: 1 s under the spec's 5 s for timer and fork lateness on a busy host), so a busy host cannot push the reply late:
#   check cap   = min(PROBE_CAP_S, remaining - PROBE_PUBLISH_RESERVE_MS)   (no check is started when under 0.2 s is left: all rows are marked timeout)
#   publish cap = remaining at publish time minus how late the check timers fired and PROBE_TIMER_SLACK_MS (the publish timer itself fires late too), at least PROBE_PUBLISH_MIN_MS

g_def PROBE_CAP_S 2.5
g_def PROBE_BUDGET_MS 4000
g_def PROBE_PUBLISH_RESERVE_MS 1000
g_def PROBE_PUBLISH_MIN_MS 300
# Deviation from the R3 ruling, accepted by gating-lead at R5: this allowance comes off the publish cap. It only shortens the publish.
# run_capped fires its kill 0.2-0.6 s after the cap on a busy host (refuter: publish lateness 171-593 ms; builder trace 0.2-0.3 s).
g_def PROBE_TIMER_SLACK_MS 250
PROBE_NAMES="rms_dbfs_2s tcc usb audio_engine default_input coreaudiod recorder helper upload presence disk power"

# Pure bash, no external process (every fork costs real time on a loaded host).
# _ms_of "2.5" -> PMS=2500.  _secs_of 1366 -> PSECS=1.366
_ms_of() { local i="${1%%.*}" f=""; case "$1" in *.*) f="${1#*.}" ;; esac; f="${f}000"; PMS=$(( 10#${i:-0} * 1000 + 10#${f:0:3} )); }
_secs_of() { printf -v PSECS '%d.%03d' $(( $1 / 1000 )) $(( $1 % 1000 )); }
# milliseconds left -> PCK_MS / PSECS for run_capped. 0 means "do not start any check".
probe_check_cap_v() { local c m; _ms_of "$PROBE_CAP_S"; c=$PMS; m=$(( $1 - PROBE_PUBLISH_RESERVE_MS )); [ "$m" -le "$c" ] || m=$c; [ "$m" -ge 200 ] || m=0; PCK_MS=$m; _secs_of "$m"; }
probe_publish_cap_v() { local r=$1; [ "$r" -ge "$PROBE_PUBLISH_MIN_MS" ] || r=$PROBE_PUBLISH_MIN_MS; _secs_of "$r"; }
probe_check_cap() { probe_check_cap_v "$1"; echo "$PSECS"; }
probe_publish_cap() { probe_publish_cap_v "$1"; echo "$PSECS"; }

# Test seam: runs once at probe start, so a test can inject overhead.
probe_start_hook() { :; }

# Each check writes "name=value" to $dir/<name>. The wrapper records "timeout" when the cap fires.
probe_check() { # dir name function
  local dir="$1" name="$2" fn="$3" rc
  set +m   # nested jobs (run_capped's) stay in this check's process group, so one group kill reaches them all
  run_capped "$PROBE_CHECK_CAP" "$dir/$name.raw" "$fn"
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

# The check phase is bounded by its own deadline (t0 + budget - publish reserve), whatever the check subshells do.
# Each check is a job in its own process group (set -m). Polled, never a bare `wait`: a check whose timer fires late
# or whose kill is slow cannot hold the reply. At the deadline every group still alive gets SIGKILL (hung children too),
# its row is "timeout", and it is reaped. Groups of checks that finished are swept too, so no timer sleep outlives the probe.
probe_run_checks() { # dir t0
  local dir="$1" t0="$2" check_deadline p k alive n=0
  local pids=() names=()
  check_deadline=$((t0 + PROBE_BUDGET_MS - PROBE_PUBLISH_RESERVE_MS))
  set -m
  exec 3>&2 2>/dev/null   # job-control notices ("Done", "Killed") stay out of the log
  probe_launch rms_dbfs_2s pc_rms; probe_launch tcc pc_tcc; probe_launch usb pc_usb; probe_launch audio_engine pc_engine
  probe_launch default_input pc_default_in; probe_launch coreaudiod pc_coreaudiod; probe_launch recorder pc_recorder
  probe_launch helper pc_helper; probe_launch upload pc_upload; probe_launch presence pc_presence
  probe_launch disk pc_disk; probe_launch power pc_power
  while :; do
    alive=0
    for p in "${pids[@]}"; do if kill -0 "$p" 2>/dev/null; then alive=1; break; fi; done
    [ "$alive" -eq 1 ] || break
    [ "$(mono_ms)" -lt "$check_deadline" ] || break
    sleep 0.1
  done
  for k in "${!pids[@]}"; do
    p="${pids[$k]}"
    if kill -0 "$p" 2>/dev/null; then
      kill -9 -- "-$p" 2>/dev/null; kill -9 "$p" 2>/dev/null
      wait "$p" 2>/dev/null          # already killed: returns at once
      printf 'timeout' >"$dir/${names[$k]}"
    else
      kill -9 -- "-$p" 2>/dev/null   # sweep: leftovers of a finished check (a timer's sleep)
    fi
  done
  exec 2>&3 3>&-
  set +m
}
probe_launch() { probe_check "$dir" "$1" "$2" & names[${#names[@]}]="$1"; pids[${#pids[@]}]=$!; }

probe_run() { # id
  local id="$1" dir ts name v verdict first=1 body="" t0 deadline payload pubcap planned_end late=0 now_ms
  t0="$(mono_ms)"; deadline=$((t0 + PROBE_BUDGET_MS))
  dir="$(mktemp -d "$STATE_DIR/probe.XXXXXX" 2>/dev/null)" || return 1
  ts="$((t0 / 1000))"; [ "${G_RUNMODE:-}" != 1 ] && [ "${GUARDIAN_TESTMODE:-}" = 1 ] && [ -n "${GUARDIAN_FAKE_NOW:-}" ] && ts="$GUARDIAN_FAKE_NOW"
  probe_start_hook
  now_ms="$(mono_ms)"
  probe_check_cap_v $((deadline - now_ms)); PROBE_CHECK_CAP="$PSECS"
  planned_end=$((now_ms + PCK_MS))
  if [ "$PCK_MS" -eq 0 ]; then
    # the deadline is spent: reply with what is ready, every row a timeout
    for name in $PROBE_NAMES; do printf 'timeout' >"$dir/$name"; done
  else
    probe_run_checks "$dir" "$t0"
  fi
  # assembly uses builtins only (read, parameter expansion, printf -v): no fork per row, so a loaded host does not eat the deadline
  local v_di="" v_ca="" v_usb="" v_eng="" room_j id_j verdict_j
  for name in $PROBE_NAMES; do
    v=""; IFS= read -r v <"$dir/$name" 2>/dev/null
    case "$name" in default_input) v_di="$v" ;; coreaudiod) v_ca="$v" ;; usb) v_usb="$v" ;; audio_engine) v_eng="$v" ;; esac
    [ "$first" -eq 1 ] || body="$body,"
    first=0
    jstr_v "$v"
    body="$body\"$name\":$JSTR_V"
  done
  verdict="ok"
  if [ "$v_di" = "timeout" ]; then verdict="coreaudio_unresponsive"
  elif [ "$v_ca" = "timeout" ]; then verdict="coreaudiod_check_timeout"
  elif [ "$v_usb" = "absent" ]; then verdict="usb_device_missing"
  elif [ "$v_usb/$v_eng" = "present/absent" ]; then verdict="coreaudio_no_device"
  fi
  jstr_v "$GUARDIAN_ROOM"; room_j="$JSTR_V"; jstr_v "$id"; id_j="$JSTR_V"; jstr_v "$verdict"; verdict_j="$JSTR_V"
  payload="{\"room_id\":$room_j,\"probe_id\":$id_j,\"ts\":$ts,\"verdict\":$verdict_j,\"checks\":{$body}}"
  # timer slack: a check timer that fired late (busy host) means the publish timer will too, so that lateness comes off the publish cap
  now_ms="$(mono_ms)"; late=$((now_ms - planned_end)); [ "$late" -gt 0 ] || late=0
  probe_publish_cap_v $((deadline - now_ms - late - PROBE_TIMER_SLACK_MS)); pubcap="$PSECS"
  PUBLISH_CAP_S="$pubcap" publish "kiosk/$GUARDIAN_ROOM/probe-reply" "$payload"
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
