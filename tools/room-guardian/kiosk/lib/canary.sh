#!/bin/bash
# shellcheck disable=SC2034,SC2154
# Kiosk Guardian: nightly canary (FR1-C5, kiosk side). Plays a short 1 kHz tone in the empty room and checks that the recorder's own tape heard it.
# bash 3.2 compatible. No python3, no osascript. The tone is an ACTION: it goes through act_begin and act_step exactly like a heal action (D1).
#  Kill switch engaged or mode != heal: nothing is played. A canary event with result would_do is published and "would play canary" is audited.
#  G3 nothing here stops, pauses or restarts recording. G4 no deletes (the WAV is overwritten in place). G9 levels and verdicts only, never audio.
# Server-side confirm is out of this build (C5b).

G_AFPLAY=/usr/bin/afplay
CANARY_WAV="$STATE_DIR/canary.wav"
CANARY_NIGHT_FILE="$STATE_DIR/canary_night"
CANARY_LAST_FILE="$STATE_DIR/canary_last_play"
CANARY_MIN_GAP_S=43200   # no second play within 12 h of the last one, whatever the night key says (a clock that went forward and back)
if [ "${G_RUNMODE:-}" = 1 ]; then readonly G_AFPLAY CANARY_MIN_GAP_S; fi   # R13 S6

# IST night key YYYYMMDD. Before 07:00 the night still belongs to the evening before.
canary_night_key() {
  local e hhmm
  e="$(now_epoch)"; hhmm="$(ist_hhmm "$e")"
  [ "$((10#$hhmm))" -lt 700 ] && e=$((e - 86400))
  TZ=Asia/Kolkata "$G_DATE" -r "$e" +%Y%m%d 2>/dev/null || TZ=Asia/Kolkata "$G_DATE" -d "@$e" +%Y%m%d
}

# little-endian N-byte integer as octal escapes for printf
canary_le() { # value nbytes
  local v="$1" n="$2" out="" i
  for ((i = 0; i < n; i++)); do out="$out\\$(printf '%03o' $((v & 255)))"; v=$((v >> 8)); done
  printf '%s' "$out"
}

# 48 kHz mono 16-bit WAV: 1 kHz tone, 3 bursts of 0.5 s with 0.5 s gaps (2.5 s). Pure bash: a one-cycle table (48 samples, peak 16000), written with printf.
# shellcheck disable=SC2059  # the format strings are octal escapes this function built itself (a sample byte can be NUL, which a variable cannot hold)
canary_make_wav() { # path
  local f="$1" i b cyc="" zero="" v tab k
  tab=(0 2088 4141 6123 8000 9740 11314 12694 13856 14782 15455 15863 16000 15863 15455 14782 13856 12694 11314 9740 8000 6123 4141 2088
       0 -2088 -4141 -6123 -8000 -9740 -11314 -12694 -13856 -14782 -15455 -15863 -16000 -15863 -15455 -14782 -13856 -12694 -11314 -9740 -8000 -6123 -4141 -2088)
  for v in "${tab[@]}"; do cyc="$cyc$(canary_le $((v & 65535)) 2)"; done
  for ((i = 0; i < 48; i++)); do zero="$zero\\000\\000"; done
  {
    printf 'RIFF'; printf "$(canary_le $((36 + 240000)) 4)"; printf 'WAVEfmt '
    printf "$(canary_le 16 4)$(canary_le 1 2)$(canary_le 1 2)$(canary_le 48000 4)$(canary_le 96000 4)$(canary_le 2 2)$(canary_le 16 2)"
    printf 'data'; printf "$(canary_le 240000 4)"
    for b in 1 2 3; do
      for ((k = 0; k < 500; k++)); do printf "$cyc"; done          # 500 cycles = 0.5 s
      [ "$b" -lt 3 ] && for ((k = 0; k < 500; k++)); do printf "$zero"; done   # 0.5 s gap
    done
  } >"$f" 2>/dev/null
}

# newest tape.pcm (same choice as rms_dbfs_2s)
canary_tape_file() {
  # shellcheck disable=SC2012
  ls -t "$RR_ROOT"/captures/*/seg_*/tape.pcm 2>/dev/null | head -n1
}
canary_size() { stat -f %z "$1" 2>/dev/null || stat -c %s "$1" 2>/dev/null; }

# dBFS of a byte range of a 16 kHz mono s16le tape (same arithmetic as rms_dbfs_2s). Prints a number, or nothing.
canary_rms_range() { # file offset_bytes length_bytes
  local off=$(( $2 / 2 * 2 ))
  [ "$3" -ge 2 ] || return 0
  tail -c "+$((off + 1))" "$1" 2>/dev/null | head -c "$3" | od -An -v -t d2 | awk '
    { for (i = 1; i <= NF; i++) { s += $i * $i; n++ } }
    END { if (n == 0) exit; r = sqrt(s / n) / 32768; if (r <= 0) printf "-120.0\n"; else printf "%.1f\n", 20 * log(r) / log(10) }'
}

# Sets CANARY_WHY to the first failed condition. 0 = eligible (D2).
canary_eligible() {
  local idle hhmm
  CANARY_WHY=""
  hhmm="$(ist_hhmm)"
  hhmm_in_window "$hhmm" "$CANARY_START" "$CANARY_END" || { CANARY_WHY=outside_window; return 1; }
  idle="$(hid_idle_s)"
  case "$idle" in ''|*[!0-9]*) CANARY_WHY=hid_unreadable; return 1 ;; esac
  [ "$idle" -ge "$CANARY_IDLE_MIN_S" ] || { CANARY_WHY=hid_active; return 1; }
  [ "$S_state" = "recording" ] || { CANARY_WHY=not_recording; return 1; }
  # tape advancing: rms_dbfs_2s is empty unless the newest tape.pcm was written in the last 5 s
  [ -n "$S_rms" ] || { CANARY_WHY=tape_not_advancing; return 1; }
  canary_state_ok || return 1
  [ "$(actions_last_hour)" -lt "$HEAL_MAX_PER_HOUR" ] || { CANARY_WHY=heal_rate; return 1; }
  return 0
}

# canary_event <result> [pre_db burst_db rise_db]: one JSON line on kiosk/<room>/canary and in the audit log. Ids, levels and verdict only.
canary_event() {
  local line
  line="$(printf '{"room_id":%s,"install_id":%s,"ts":%s,"action":"canary","night":%s,"result":%s,"mode":%s,"pre_db":%s,"burst_db":%s,"rise_db":%s,"volume":%s,"output":%s}' \
    "$(jstr "$GUARDIAN_ROOM")" "$(jstr "$S_install_id")" "$(now_epoch)" "$(jstr "$(canary_night_key)")" "$(jstr "$1")" "$(jstr "$(current_mode)")" \
    "$(jnum "${2:-}")" "$(jnum "${3:-}")" "$(jnum "${4:-}")" "$(jnum "$CANARY_VOLUME")" "$(jstr "${CANARY_OUTPUT:-unknown}")")"
  printf '%s\n' "$line" >>"$AUDIT_LOG" 2>/dev/null
  publish "kiosk/$GUARDIAN_ROOM/canary" "$line"
}

canary_mark_night() { "$G_MKDIR" -p "$STATE_DIR" 2>/dev/null; canary_night_key >"$CANARY_NIGHT_FILE" 2>/dev/null; }
# Write the night and the play time, then read both back. 0 only when both read back exactly (a play never starts on a state it cannot keep).
canary_commit_state() {
  local key now
  key="$(canary_night_key)"; now="$(now_epoch)"
  canary_mark_night
  [ "$("$G_CAT" "$CANARY_NIGHT_FILE" 2>/dev/null)" = "$key" ] || return 1
  printf '%s\n' "$now" >"$CANARY_LAST_FILE" 2>/dev/null
  [ "$("$G_CAT" "$CANARY_LAST_FILE" 2>/dev/null)" = "$now" ] || return 1
  return 0
}

# The output device must exist. system_profiler lists the default output device when there is one.
# Sets CANARY_OUTPUT: present | absent | unknown (the profiler itself failed or timed out). Returns 0 only for present.
canary_output_present() {
  local out="$STATE_DIR/canary.sp"
  CANARY_OUTPUT=unknown
  run_capped 8 "$out" system_profiler SPAudioDataType -json || return 1
  if "$G_GREP" -q 'coreaudio_default_audio_output_device' "$out" 2>/dev/null; then CANARY_OUTPUT=present; return 0; fi
  CANARY_OUTPUT=absent; return 1
}

# CANARY_VOLUME must be a decimal 0.d or 0.dd in (0, 0.5]. Anything else: the canary does not play.
canary_volume_ok() {
  local re='^0\.[0-9]{1,2}$' v="$CANARY_VOLUME"
  [[ $v =~ $re ]] || return 1
  awk -v v="$v" 'BEGIN { exit !(v + 0 > 0 && v + 0 <= 0.5) }'
}

# Night state fails closed. 0 = may play tonight. Sets CANARY_WHY: already_tonight (quiet) or state_<why> (an inconclusive event).
canary_state_ok() {
  local key v last now re='^[0-9]{8}$'
  key="$(canary_night_key)"; now="$(now_epoch)"
  if [ -e "$CANARY_NIGHT_FILE" ] || [ -L "$CANARY_NIGHT_FILE" ]; then
    if [ ! -f "$CANARY_NIGHT_FILE" ]; then CANARY_WHY=state_not_a_file; return 1; fi
    if [ ! -r "$CANARY_NIGHT_FILE" ]; then CANARY_WHY=state_unreadable; return 1; fi
    v="$("$G_CAT" "$CANARY_NIGHT_FILE" 2>/dev/null)"
    if [ -z "$v" ]; then CANARY_WHY=state_empty; return 1; fi
    if ! [[ $v =~ $re ]]; then CANARY_WHY=state_garbage; return 1; fi
    if [ "$((10#$v))" -eq "$((10#$key))" ]; then CANARY_WHY=already_tonight; return 1; fi
    if [ "$((10#$v))" -gt "$((10#$key))" ]; then CANARY_WHY=state_future; return 1; fi
  fi
  if [ -e "$CANARY_LAST_FILE" ] || [ -L "$CANARY_LAST_FILE" ]; then
    if [ ! -f "$CANARY_LAST_FILE" ] || [ ! -r "$CANARY_LAST_FILE" ]; then CANARY_WHY=state_lastplay; return 1; fi
    last="$("$G_CAT" "$CANARY_LAST_FILE" 2>/dev/null)"
    re='^[1-9][0-9]{0,14}$'
    if ! [[ $last =~ $re ]]; then CANARY_WHY=state_lastplay; return 1; fi
    # written "not (gap >= 12 h)": a last play in the future (clock went back) also refuses
    if ! [ "$((now - 10#$last))" -ge "$CANARY_MIN_GAP_S" ]; then CANARY_WHY=state_recent_play; return 1; fi
  fi
  return 0
}

# dBFS of the loudest 0.5 s window (hop 0.125 s) inside a byte range of the 16 kHz mono s16le tape. Anchors the measure to the tone wherever the tape lag put it.
canary_rms_peak_window() { # file offset_bytes length_bytes
  local off=$(( $2 / 2 * 2 ))
  [ "$3" -ge 16000 ] || return 0
  tail -c "+$((off + 1))" "$1" 2>/dev/null | head -c "$3" | od -An -v -t d2 | awk '
    { for (i = 1; i <= NF; i++) { n++; c[n] = c[n - 1] + $i * $i } }
    END {
      W = 8000; H = 2000; best = -1
      if (n < W) exit
      for (a = 0; a + W <= n; a += H) { m = (c[a + W] - c[a]) / W; if (m > best) best = m }
      r = sqrt(best) / 32768
      if (r <= 0) printf "-120.0\n"; else printf "%.1f\n", 20 * log(r) / log(10)
    }'
}

canary_play_and_confirm() {
  local ap="$G_AFPLAY" f0 f1 s0 s1 pstart pre_off pre_len blen pre burst rise rem el out="$STATE_DIR/canary.play"
  [ "${G_RUNMODE:-}" != 1 ] && [ "${GUARDIAN_TESTMODE:-}" = 1 ] && ap="${CANARY_AFPLAY:-/usr/bin/false}"   # test mode never reaches the real afplay
  if ! canary_volume_ok; then audit "canary not played: CANARY_VOLUME is not in (0,0.5]"; canary_event "inconclusive:bad_volume"; return 0; fi
  canary_output_present || { canary_event "inconclusive:output_absent"; return 0; }
  f0="$(canary_tape_file)"; s0="$(canary_size "$f0")"
  case "$s0" in ''|*[!0-9]*) canary_event "inconclusive:tape_unreadable"; return 0 ;; esac
  canary_make_wav "$CANARY_WAV"
  pstart="$(mono_ms)"
  # the kill switch and the mode are re-checked directly before the tone, after the up to 8 s output check (G8)
  act_step || { canary_event would_do; return 0; }
  run_capped 10 "$out" "$ap" -v "$CANARY_VOLUME" "$CANARY_WAV"
  case $? in 0) ;; 124) canary_event "inconclusive:play_timeout"; return 0 ;; *) canary_event "inconclusive:afplay_error"; return 0 ;; esac
  # sample CANARY_SAMPLE_S after the start (the recorder checkpoints its tape with a lag)
  el=$(( $(mono_ms) - pstart )); rem=$(( CANARY_SAMPLE_S * 1000 - el ))
  if [ "$rem" -gt 0 ]; then gsleep "$(printf '%d.%03d' $((rem / 1000)) $((rem % 1000)))"; fi
  f1="$(canary_tape_file)"
  [ "$f1" = "$f0" ] || { canary_event "inconclusive:segment_rolled"; return 0; }
  s1="$(canary_size "$f1")"
  case "$s1" in ''|*[!0-9]*) canary_event "inconclusive:tape_unreadable"; return 0 ;; esac
  blen=$((s1 - s0)); [ "$blen" -le 320000 ] || blen=320000   # everything written since the start (up to 10 s): the tone may sit anywhere in it
  [ "$blen" -ge 32000 ] || { canary_event "inconclusive:tape_stalled"; return 0; }
  pre_off=$((s0 - 160000)); [ "$pre_off" -ge 0 ] || pre_off=0   # the 5 s before the start
  pre_len=$((s0 - pre_off))
  [ "$pre_len" -ge 32000 ] || { canary_event "inconclusive:tape_short"; return 0; }
  pre="$(canary_rms_range "$f1" "$pre_off" "$pre_len")"
  burst="$(canary_rms_peak_window "$f1" "$s0" "$blen")"
  { [ -n "$pre" ] && [ -n "$burst" ]; } || { canary_event "inconclusive:tape_unreadable"; return 0; }
  rise="$(awk -v b="$burst" -v p="$pre" 'BEGIN { printf "%.1f", b - p }')"
  if awk -v r="$rise" -v t="$CANARY_PASS_DB" 'BEGIN { exit !(r + 0 >= t + 0) }'; then
    canary_event pass "$pre" "$burst" "$rise"
  else
    canary_event no_local_rise "$pre" "$burst" "$rise"
  fi
}

# Called once per tick, after heal_cycle. Cheap when not eligible.
canary_cycle() {
  CANARY_OUTPUT=unknown
  [ "$CANARY_ENABLED" = 1 ] || return 0
  if ! canary_eligible; then
    # a night state that cannot be trusted is reported (at most hourly), never played on
    case "$CANARY_WHY" in state_*) once_per "canary:$CANARY_WHY" 3600 && { audit "canary refused: $CANARY_WHY"; canary_event "inconclusive:$CANARY_WHY"; } ;; esac
    return 0
  fi
  if ! act_begin canary canary_nightly "mode=$(current_mode) hid_idle_s=$(hid_idle_s)"; then
    # act_begin refuses for the kill switch, for shadow mode, or for the heal rate limit (the last is not a would-do and is retried).
    if killswitch_engaged || [ "$(current_mode)" != heal ]; then
      canary_mark_night
      audit "would play canary night=$(canary_night_key)"
      canary_event would_do
    fi
    return 0
  fi
  act_step || { canary_mark_night; audit "would play canary night=$(canary_night_key) (act_step refused)"; canary_event would_do; return 0; }
  if ! canary_commit_state; then audit "canary refused: night state did not read back"; canary_event "inconclusive:state_write"; return 0; fi
  audit "canary start night=$(canary_night_key) volume=$CANARY_VOLUME"
  canary_play_and_confirm
}
