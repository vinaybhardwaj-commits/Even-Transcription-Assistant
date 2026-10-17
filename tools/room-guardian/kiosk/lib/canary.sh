#!/bin/bash
# shellcheck disable=SC2034,SC2154
# Kiosk Guardian: canary (FR1-C5, kiosk side; R16d: two empty-room slots a day, pm post-check and am pre-flight). Plays a short 1 kHz tone in the empty room and checks that the recorder's own tape heard it.
# bash 3.2 compatible. No python3, no osascript. The tone is an ACTION: it goes through act_begin and act_step exactly like a heal action (D1).
#  Kill switch engaged or mode != heal: nothing is played. A canary event with result would_do is published and "would play canary" is audited.
#  G3 nothing here stops, pauses or restarts recording. G4 no deletes (the WAV is overwritten in place). G9 levels and verdicts only, never audio.
# Server-side confirm is out of this build (C5b).

G_AFPLAY=/usr/bin/afplay
CANARY_WAV="$STATE_DIR/canary.wav"
CANARY_SLOT_FILE="$STATE_DIR/canary_slot"   # R16d: the slot key YYYYMMDD-pm|am. The old canary_night file (bare date) is no longer read.
CANARY_LAST_FILE="$STATE_DIR/canary_last_play"
CANARY_MIN_GAP_S=21600   # no second play within 6 h of the last one, whatever the slot key says (a clock that went forward and back). pm to am is 9 h 40.
if [ "${G_RUNMODE:-}" = 1 ]; then readonly G_AFPLAY CANARY_MIN_GAP_S; fi   # R13 S6

# R16d: the slot now (pm 21:40-22:40, am 07:20-08:20 IST): pm | am | empty when outside both.
canary_slot_name() {
  local hhmm; hhmm="$(ist_hhmm)"
  if hhmm_in_window "$hhmm" "$CANARY_PM_START" "$CANARY_PM_END"; then echo pm
  elif hhmm_in_window "$hhmm" "$CANARY_AM_START" "$CANARY_AM_END"; then echo am
  fi
}
# Slot key YYYYMMDD-pm|am: the IST date of the slot's own start (neither slot crosses midnight). Empty outside a slot.
canary_slot_key() {
  local n; n="$(canary_slot_name)"
  [ -n "$n" ] || return 0
  printf '%s-%s' "$(ist_date)" "$n"
}
# 0 when the slot file already holds the current slot's key (the slot has played)
canary_slot_played() {
  local k; k="$(canary_slot_key)"
  [ -n "$k" ] && [ "$("$G_CAT" "$CANARY_SLOT_FILE" 2>/dev/null)" = "$k" ]
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

# Sets CANARY_WHY to the first failed condition. 0 = eligible (D2). Every gate fails closed.
canary_eligible() {
  local idle
  CANARY_WHY=""
  [ -n "$(canary_slot_name)" ] || { CANARY_WHY=outside_window; return 1; }
  # R16d: outside the night window (the am slot) the consult hold must be CLEAR (fresh new-form consult_open false for this room). In the night window (pm) it is not applied, as for Chrome.
  if ! in_night_window && ! consult_hold_clear; then CANARY_WHY=consult_not_clear; return 1; fi
  idle="$(hid_idle_s)"
  case "$idle" in ''|*[!0-9]*) CANARY_WHY=hid_unreadable; return 1 ;; esac
  [ "$idle" -ge "$CANARY_IDLE_MIN_S" ] || { CANARY_WHY=hid_active; return 1; }
  # R16d: state=failed is its own reason (checked before not_recording)
  [ "$S_state" != "failed" ] || { CANARY_WHY=recorder_failed; return 1; }
  # recorder_busy: any state other than recording (paused, upload_pending with a backlog, ...)
  if [ -n "$S_state" ] && [ "$S_state" != "recording" ]; then CANARY_WHY=recorder_busy; return 1; fi
  [ "$S_state" = "recording" ] || { CANARY_WHY=not_recording; return 1; }
  # tape advancing: rms_dbfs_2s is empty unless the newest tape.pcm was written in the last 5 s
  [ -n "$S_rms" ] || { CANARY_WHY=tape_not_advancing; return 1; }
  # recorder_busy, speech arm: speech on the tape now, or in the last SPEECH_QUIET_S (the room is not empty)
  if speech_recent; then CANARY_WHY=recorder_busy; return 1; fi
  canary_state_ok || return 1
  [ "$(actions_last_hour)" -lt "$HEAL_MAX_PER_HOUR" ] || { CANARY_WHY=heal_rate; return 1; }
  return 0
}

# R16d-3: after canary_commit_state the events carry the COMMITTED slot's name and IST date (CANARY_COMMIT_KEY), never the clock's at event time.
# Before a commit (refused, skipped or would_do events) they carry the slot and date computed at event time, as before.
canary_event_slot() { if [ -n "${CANARY_COMMIT_KEY:-}" ]; then printf '%s' "${CANARY_COMMIT_KEY##*-}"; else canary_slot_name; fi; }
canary_event_night() { if [ -n "${CANARY_COMMIT_KEY:-}" ]; then printf '%s' "${CANARY_COMMIT_KEY%%-*}"; else ist_date; fi; }

# canary_event <result> [pre_db burst_db rise_db]: one JSON line on kiosk/<room>/canary and in the audit log. Ids, levels and verdict only.
canary_event() {
  local line
  line="$(printf '{"room_id":%s,"install_id":%s,"ts":%s,"action":"canary","night":%s,"result":%s,"mode":%s,"pre_db":%s,"burst_db":%s,"rise_db":%s,"volume":%s,"output":%s,"slot":%s,"pass_db":%s,"plays":[%s],"pass_db_band":%s}' \
    "$(jstr "$GUARDIAN_ROOM")" "$(jstr "$S_install_id")" "$(now_epoch)" "$(jstr "$(canary_event_night)")" "$(jstr "$1")" "$(jstr "$(current_mode)")" \
    "$(jnum "${2:-}")" "$(jnum "${3:-}")" "$(jnum "${4:-}")" "$(jnum "$CANARY_VOLUME")" "$(jstr "${CANARY_OUTPUT:-unknown}")" "$(jstr "$(canary_event_slot)")" "$(jnum "$CANARY_PASS_DB")" "${CANARY_PLAYS:-}" "$(jnum "$CANARY_BAND_PASS_DB")")"
  printf '%s\n' "$line" >>"$AUDIT_LOG" 2>/dev/null
  publish "kiosk/$GUARDIAN_ROOM/canary" "$line"
}

canary_mark_slot() { "$G_MKDIR" -p "$STATE_DIR" 2>/dev/null; canary_slot_key >"$CANARY_SLOT_FILE" 2>/dev/null; }
# Write the slot and the play time, then read both back. 0 only when both read back exactly (a play never starts on a state it cannot keep).
canary_commit_state() {
  local key now
  key="$(canary_slot_key)"; now="$(now_epoch)"
  [ -n "$key" ] || return 1
  canary_mark_slot
  [ "$("$G_CAT" "$CANARY_SLOT_FILE" 2>/dev/null)" = "$key" ] || return 1
  printf '%s\n' "$now" >"$CANARY_LAST_FILE" 2>/dev/null
  [ "$("$G_CAT" "$CANARY_LAST_FILE" 2>/dev/null)" = "$now" ] || return 1
  CANARY_COMMIT_KEY="$key"
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

# Slot state fails closed. 0 = may play in this slot. Sets CANARY_WHY: already_tonight (quiet; the slot has played) or state_<why> (an inconclusive event).
# Slot order: date first, then am before pm (ordinal = date * 2 + (pm ? 1 : 0)).
canary_slot_ord() { # YYYYMMDD-am|pm
  local d="${1%%-*}"
  case "$1" in *-pm) echo $((10#$d * 2 + 1)) ;; *) echo $((10#$d * 2)) ;; esac
}
canary_state_ok() {
  local key v last now re='^[0-9]{8}-(am|pm)$'
  key="$(canary_slot_key)"; now="$(now_epoch)"
  [ -n "$key" ] || { CANARY_WHY=outside_window; return 1; }
  if [ -e "$CANARY_SLOT_FILE" ] || [ -L "$CANARY_SLOT_FILE" ]; then
    if [ ! -f "$CANARY_SLOT_FILE" ]; then CANARY_WHY=state_not_a_file; return 1; fi
    if [ ! -r "$CANARY_SLOT_FILE" ]; then CANARY_WHY=state_unreadable; return 1; fi
    v="$("$G_CAT" "$CANARY_SLOT_FILE" 2>/dev/null)"
    if [ -z "$v" ]; then CANARY_WHY=state_empty; return 1; fi
    if ! [[ $v =~ $re ]]; then CANARY_WHY=state_garbage; return 1; fi
    if [ "$(canary_slot_ord "$v")" -eq "$(canary_slot_ord "$key")" ]; then CANARY_WHY=already_tonight; return 1; fi
    if [ "$(canary_slot_ord "$v")" -gt "$(canary_slot_ord "$key")" ]; then CANARY_WHY=state_future; return 1; fi
  fi
  if [ -e "$CANARY_LAST_FILE" ] || [ -L "$CANARY_LAST_FILE" ]; then
    if [ ! -f "$CANARY_LAST_FILE" ] || [ ! -r "$CANARY_LAST_FILE" ]; then CANARY_WHY=state_lastplay; return 1; fi
    last="$("$G_CAT" "$CANARY_LAST_FILE" 2>/dev/null)"
    re='^[1-9][0-9]{0,14}$'
    if ! [[ $last =~ $re ]]; then CANARY_WHY=state_lastplay; return 1; fi
    # written "not (gap >= 6 h)": a last play in the future (clock went back) also refuses
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

# R16d item 8: the band statistic (1-3 kHz). Two RBJ biquads (HP 1 kHz then LP 3 kHz, fs 16000, Q 0.70710678, direct form I, double, samples in LSB) over ONE contiguous
# read from pre_off to s0+blen, zero state at pre_off. The first 160 filtered samples (10 ms warm-up) are dropped from the pre RMS. pre = RMS of the rest of the pre range;
# burst = loudest 0.5 s window (hop 0.125 s) over the burst range. Any RMS below 1 LSB counts as 1 LSB. Prints "<pre_db_band> <burst_db_band>", or nothing.
canary_band_stats() { # file pre_off pre_len blen
  local off=$(( $2 / 2 * 2 ))
  [ "$3" -ge 2 ] && [ "$4" -ge 16000 ] || return 0
  tail -c "+$((off + 1))" "$1" 2>/dev/null | head -c "$(( $3 + $4 ))" | od -An -v -t d2 | awk -v hp="$CANARY_HP_COEF" -v lp="$CANARY_LP_COEF" -v np="$(( $3 / 2 ))" '
    function db(ms) { r = sqrt(ms); if (r < 1) r = 1; return 20 * log(r / 32768) / log(10) }
    BEGIN { split(hp, h, " "); split(lp, l, " ") }
    { for (i = 1; i <= NF; i++) {
        k++; v = $i
        y = h[1] * v + h[2] * hx1 + h[3] * hx2 - h[4] * hy1 - h[5] * hy2; hx2 = hx1; hx1 = v; hy2 = hy1; hy1 = y
        z = l[1] * y + l[2] * lx1 + l[3] * lx2 - l[4] * ly1 - l[5] * ly2; lx2 = lx1; lx1 = y; ly2 = ly1; ly1 = z
        if (k <= 160) continue
        if (k <= np) { sp += z * z; cp++ } else { n++; c[n] = c[n - 1] + z * z }
    } }
    END {
      W = 8000; H = 2000; best = -1
      if (cp < 1 || n < W) exit
      for (a = 0; a + W <= n; a += H) { m = (c[a + W] - c[a]) / W; if (m > best) best = m }
      printf "%.1f %.1f\n", db(sp / cp), db(best)
    }'
}

# One play and its measurement. Sets P_PRE P_BURST P_RISE P_PRB P_BB P_RB P_PBB (broadband pass true|false) P_FILE P_END. Returns 0 measured; 1 otherwise with CANARY_PLAY_RES set (would_do | inconclusive:<why>).
canary_play_once() { # afplay_bin
  local ap="$1" f0 f1 s0 s1 pstart pre_off pre_len blen rem el out="$STATE_DIR/canary.play" bd
  CANARY_PLAY_RES=""
  f0="$(canary_tape_file)"; s0="$(canary_size "$f0")"
  case "$s0" in ''|*[!0-9]*) CANARY_PLAY_RES="inconclusive:tape_unreadable"; return 1 ;; esac
  pstart="$(mono_ms)"; P_START="$pstart"
  # the kill switch and the mode are re-checked directly before EACH tone (G8)
  act_step || { CANARY_PLAY_RES=would_do; return 1; }
  run_capped 10 "$out" "$ap" -v "$CANARY_VOLUME" "$CANARY_WAV"
  case $? in 0) ;; 124) CANARY_PLAY_RES="inconclusive:play_timeout"; return 1 ;; *) CANARY_PLAY_RES="inconclusive:afplay_error"; return 1 ;; esac
  # sample CANARY_SAMPLE_S after the start (the recorder checkpoints its tape with a lag)
  el=$(( $(mono_ms) - pstart )); rem=$(( CANARY_SAMPLE_S * 1000 - el ))
  if [ "$rem" -gt 0 ]; then gsleep "$(printf '%d.%03d' $((rem / 1000)) $((rem % 1000)))"; fi
  f1="$(canary_tape_file)"
  [ "$f1" = "$f0" ] || { CANARY_PLAY_RES="inconclusive:segment_rolled"; return 1; }
  s1="$(canary_size "$f1")"
  case "$s1" in ''|*[!0-9]*) CANARY_PLAY_RES="inconclusive:tape_unreadable"; return 1 ;; esac
  P_FILE="$f1"; P_END="$s1"   # R16e: where this play's measured range ends (the speech gap before the next play starts here)
  blen=$((s1 - s0)); [ "$blen" -le 320000 ] || blen=320000   # everything written since the start (up to 10 s): the tone may sit anywhere in it
  [ "$blen" -ge 32000 ] || { CANARY_PLAY_RES="inconclusive:tape_stalled"; return 1; }
  pre_off=$((s0 - 160000)); [ "$pre_off" -ge 0 ] || pre_off=0   # the 5 s before the start
  pre_len=$((s0 - pre_off))
  [ "$pre_len" -ge 32000 ] || { CANARY_PLAY_RES="inconclusive:tape_short"; return 1; }
  P_PRE="$(canary_rms_range "$f1" "$pre_off" "$pre_len")"
  P_BURST="$(canary_rms_peak_window "$f1" "$s0" "$blen")"
  { [ -n "$P_PRE" ] && [ -n "$P_BURST" ]; } || { CANARY_PLAY_RES="inconclusive:tape_unreadable"; return 1; }
  bd="$(canary_band_stats "$f1" "$pre_off" "$pre_len" "$blen")"
  P_PRB="${bd%% *}"; P_BB="${bd##* }"
  { [ -n "$bd" ] && [ -n "$P_PRB" ] && [ -n "$P_BB" ]; } || { CANARY_PLAY_RES="inconclusive:tape_unreadable"; return 1; }
  P_RISE="$(awk -v b="$P_BURST" -v p="$P_PRE" 'BEGIN { printf "%.1f", b - p }')"
  P_RB="$(awk -v b="$P_BB" -v p="$P_PRB" 'BEGIN { printf "%.1f", b - p }')"
  P_PBB=false
  awk -v r="$P_RISE" -v t="$CANARY_PASS_DB" 'BEGIN { exit !(r + 0 >= t + 0) }' && P_PBB=true
  return 0
}

# JSON member of one measured play (appended to CANARY_PLAYS)
canary_play_json() {
  printf '{"pre_db":%s,"burst_db":%s,"rise_db":%s,"pre_db_band":%s,"burst_db_band":%s,"rise_db_band":%s,"pass_broadband":%s}' \
    "$(jnum "$P_PRE")" "$(jnum "$P_BURST")" "$(jnum "$P_RISE")" "$(jnum "$P_PRB")" "$(jnum "$P_BB")" "$(jnum "$P_RB")" "$P_PBB"
}

# dBFS of the loudest 2 s window (hop 0.5 s, the rms_dbfs_2s statistic) inside a byte range of the 16 kHz mono s16le tape; a range under 2 s is one window. Prints a number, or nothing.
canary_rms_peak2s() { # file offset_bytes length_bytes
  local off=$(( $2 / 2 * 2 ))
  [ "$3" -ge 2 ] || return 0
  tail -c "+$((off + 1))" "$1" 2>/dev/null | head -c "$3" | od -An -v -t d2 | awk '
    { for (i = 1; i <= NF; i++) { n++; c[n] = c[n - 1] + $i * $i } }
    END {
      W = 32000; H = 8000; best = -1
      if (n == 0) exit
      if (n < W) best = c[n] / n
      for (a = 0; a + W <= n; a += H) { m = (c[a + W] - c[a]) / W; if (m > best) best = m }
      r = sqrt(best) / 32768
      if (r <= 0) printf "-120.0\n"; else printf "%.1f\n", 20 * log(r) / log(10)
    }'
}

# R16e (SHOULD-2): 0 when the tape written since play 1's measured range ended holds speech anywhere (the whole gap, not only its last 2 s), and remembers it as note_speech does.
# A segment that rolled since play 1 is gap from its first byte. An unreadable size fails closed (0).
canary_gap_speech() { # play1_tape_file play1_end_bytes
  local f off="$2" sz db
  f="$(canary_tape_file)"; [ "$f" = "$1" ] || off=0
  sz="$(canary_size "$f")"
  case "$sz" in ''|*[!0-9]*) return 0 ;; esac
  case "$off" in ''|*[!0-9]*) off=0 ;; esac
  [ "$off" -le "$sz" ] || off=0
  db="$(canary_rms_peak2s "$f" "$off" "$((sz - off))")"
  rms_is_speech "$db" || return 1
  "$G_MKDIR" -p "$STATE_DIR" 2>/dev/null; printf '%s\n' "$(now_epoch)" >"$STATE_DIR/speech_seen" 2>/dev/null
  return 0
}

# R16d-3 (fable G2): the gate set, re-checked on FRESHLY READ inputs directly before EACH play. canary_eligible runs once per tick on values collected at the start of the tick;
# play 2 starts CANARY_PLAY_GAP_S later, so every input is read again here (status.json, the tape, HID, the control payload, the clock).
# Same gates, same order and same CANARY_WHY as canary_eligible. NOT re-run: canary_state_ok and the heal rate (the slot is committed and its action spent).
# R16e (SHOULD-1): the kill switch and the mode are checked FIRST (kill | mode): a kill payload also holds the consult gate, and a kill must never read as consult_not_clear.
# act_step inside canary_play_once still re-checks both directly before the tone (would_do). R16e (SHOULD-2): before play 2, speech anywhere on the tape written since
# play 1's measured range ended (canary_gap_speech), not only the last 2 s. $1 = the committed slot key; $2 $3 = play 1's tape file and end offset (play 2 only).
# 0 = may play; 1 = abort, CANARY_WHY set.
canary_play_gate() {
  local key="$1" idle
  CANARY_WHY=""
  if killswitch_engaged; then CANARY_WHY="kill"; return 1; fi
  [ "$(current_mode)" = heal ] || { CANARY_WHY=mode; return 1; }
  { [ -n "$key" ] && [ "$(canary_slot_key)" = "$key" ]; } || { CANARY_WHY=outside_window; return 1; }
  if ! in_night_window && ! consult_hold_clear; then CANARY_WHY=consult_not_clear; return 1; fi
  idle="$(hid_idle_s)"
  case "$idle" in ''|*[!0-9]*) CANARY_WHY=hid_unreadable; return 1 ;; esac
  [ "$idle" -ge "$CANARY_IDLE_MIN_S" ] || { CANARY_WHY=hid_active; return 1; }
  S_state="$(json_get "$STATUS_JSON" state)"; S_capture_open="$(json_get "$STATUS_JSON" capture_open)"; S_pending="$(json_get "$STATUS_JSON" pending_piece_count)"
  [ "$S_state" != "failed" ] || { CANARY_WHY=recorder_failed; return 1; }
  if [ -n "$S_state" ] && [ "$S_state" != "recording" ]; then CANARY_WHY=recorder_busy; return 1; fi
  [ "$S_state" = "recording" ] || { CANARY_WHY=not_recording; return 1; }
  S_rms="$(rms_dbfs_2s)"
  [ -n "$S_rms" ] || { CANARY_WHY=tape_not_advancing; return 1; }
  if [ -n "${2:-}" ] && canary_gap_speech "$2" "$3"; then CANARY_WHY=recorder_busy; return 1; fi
  if speech_recent; then CANARY_WHY=recorder_busy; return 1; fi
  return 0
}

# R16d item 8: exactly two plays per slot, the second starting CANARY_PLAY_GAP_S (15 s, R16d-3 G1) after the first started; tape lag can only cause a false FAIL and 15 s removes it.
# Pass = both plays' band rise >= CANARY_BAND_PASS_DB. R16d-3: canary_play_gate runs directly before EACH play; a failed gate aborts the slot (aborted:<why>, no retry).
canary_play_and_confirm() {
  local ap="$G_AFPLAY" n wait_ms r1_pre r1_burst r1_rise ok=0 first_start p1_file="" p1_end="" ckey="${CANARY_COMMIT_KEY:-$(canary_slot_key)}"
  [ "${G_RUNMODE:-}" != 1 ] && [ "${GUARDIAN_TESTMODE:-}" = 1 ] && ap="${CANARY_AFPLAY:-/usr/bin/false}"   # test mode never reaches the real afplay
  CANARY_PLAYS=""
  if ! canary_volume_ok; then audit "canary not played: CANARY_VOLUME is not in (0,0.5]"; canary_event "inconclusive:bad_volume"; return 0; fi
  canary_output_present || { canary_event "inconclusive:output_absent"; return 0; }
  canary_make_wav "$CANARY_WAV"
  for n in 1 2; do
    if [ "$n" = 2 ]; then
      wait_ms=$(( first_start + CANARY_PLAY_GAP_S * 1000 - $(mono_ms) ))
      if [ "$wait_ms" -gt 0 ]; then gsleep "$(printf '%d.%03d' $((wait_ms / 1000)) $((wait_ms % 1000)))"; fi
    fi
    canary_play_gate "$ckey" ${p1_file:+"$p1_file" "$p1_end"} || { audit "canary aborted: $CANARY_WHY play=$n slot=$ckey"; canary_event "aborted:$CANARY_WHY" "${r1_pre:-}" "${r1_burst:-}" "${r1_rise:-}"; return 0; }
    if ! canary_play_once "$ap"; then
      canary_event "$CANARY_PLAY_RES" "${r1_pre:-}" "${r1_burst:-}" "${r1_rise:-}"
      return 0
    fi
    [ "$n" = 1 ] && { first_start="$P_START"; r1_pre="$P_PRE"; r1_burst="$P_BURST"; r1_rise="$P_RISE"; p1_file="$P_FILE"; p1_end="$P_END"; }
    CANARY_PLAYS="${CANARY_PLAYS:+$CANARY_PLAYS,}$(canary_play_json)"
    awk -v r="$P_RB" -v t="$CANARY_BAND_PASS_DB" 'BEGIN { exit !(r + 0 >= t + 0) }' && ok=$((ok + 1))
  done
  if [ "$ok" = 2 ]; then canary_event pass "$r1_pre" "$r1_burst" "$r1_rise"; else canary_event no_local_rise "$r1_pre" "$r1_burst" "$r1_rise"; fi
}

# R16d: a skip is audited once per slot per reason (never per tick). Quiet for a slot that already played.
canary_skip_audit() {
  local k; k="$(canary_slot_key)"
  [ -n "$k" ] || return 0
  canary_slot_played && return 0
  once_per "canary:skip:$k:$1" 86400 && audit "canary skipped: $1 slot=$k"
  return 0
}

# Called once per tick, after heal_cycle. Cheap when not eligible.
canary_cycle() {
  CANARY_OUTPUT=unknown; CANARY_PLAYS=""; CANARY_COMMIT_KEY=""
  [ "$CANARY_ENABLED" = 1 ] || return 0
  if ! canary_eligible; then
    # a slot state that cannot be trusted is reported (at most hourly), never played on
    case "$CANARY_WHY" in
      state_*) once_per "canary:$CANARY_WHY" 3600 && { audit "canary refused: $CANARY_WHY"; canary_event "inconclusive:$CANARY_WHY"; } ;;
      consult_not_clear|hid_active|hid_unreadable|recorder_failed|recorder_busy|not_recording|tape_not_advancing) canary_skip_audit "$CANARY_WHY" ;;
    esac
    return 0
  fi
  if ! act_begin canary canary_slot "mode=$(current_mode) hid_idle_s=$(hid_idle_s)"; then
    # act_begin refuses for the kill switch, for shadow mode, or for the heal rate limit (the last is not a would-do and is retried).
    # R16d: shadow is alert only. No kiosk action on any result.
    if killswitch_engaged || [ "$(current_mode)" != heal ]; then
      canary_mark_slot
      audit "would play canary slot=$(canary_slot_key)"
      canary_event would_do
    fi
    return 0
  fi
  act_step || { canary_mark_slot; audit "would play canary slot=$(canary_slot_key) (act_step refused)"; canary_event would_do; return 0; }
  if ! canary_commit_state; then audit "canary refused: slot state did not read back"; canary_event "inconclusive:state_write"; return 0; fi
  audit "canary start slot=$(canary_slot_key) volume=$CANARY_VOLUME"
  canary_play_and_confirm
}
