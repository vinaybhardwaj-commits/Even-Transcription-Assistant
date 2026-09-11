# OPD 6 (CONSUL6) — check-and-restart, 11 Sep 2026 (desk-side, no walk)

**State at 10:42 IST:** `ehrc-consul6@100.122.91.123`, `install_j6k3essxumrc`, `stable`, 0.1.8, `sleep=0`, sshd on, C270 as input,
`microphone authorized`. Server: listener **listening**, room state **"Finished for today"**, start available. The morning tape
(`bs_99kvetk6`) ran 23 min with 0 pieces and was ended; an earlier session `bs_zgrm28z3` carries `ended_at_lies` (server record, B2 list).
So "doesn't work" = not recording, not broken. Everything below runs **from the Air**.

## 1. Is the app alive and what does it think (10 s)
```bash
ssh -o PreferredAuthentications=password ehrc-consul6@100.122.91.123 'R="$HOME/Library/Application Support/EvenScribe/RoomRecorder"; cat "$R/status.json"; echo; tail -5 "$R/launchd.log"; pgrep -fl "EvenScribe Room Recorder" | head -2; echo "STEP1 OK"'
```
Want `"state" : "ready"` (or `recording`), `last_error` null, a running process.

## 2. Is the microphone actually delivering signal
```bash
ssh -o PreferredAuthentications=password ehrc-consul6@100.122.91.123 'system_profiler SPAudioDataType 2>/dev/null | grep -B2 -A6 -i "C270" | head -12; echo "input volume=$(osascript -e "input volume of (get volume settings)")"; echo "STEP2 OK"'
```
Want the C270 listed with `Default Input Device: Yes` and input volume > 0. If the volume is 0:
```bash
ssh -o PreferredAuthentications=password ehrc-consul6@100.122.91.123 'osascript -e "set volume input volume 60"; osascript -e "input volume of (get volume settings)"'
```

## 3. Restart the recorder cleanly
```bash
ssh -o PreferredAuthentications=password ehrc-consul6@100.122.91.123 'launchctl kickstart -k gui/$(id -u)/com.evenscribe.room-recorder; sleep 8; tail -3 "$HOME/Library/Application Support/EvenScribe/RoomRecorder/launchd.log"; echo "STEP3 $( tail -3 "$HOME/Library/Application Support/EvenScribe/RoomRecorder/launchd.log" | grep -q "microphone authorized" && echo OK || echo FAIL )"'
```

## 4. Start the tape — from the desk
Either press **Start** on the room page, or ask the orchestrator to run `scribe_start_recording` for `opd-6-webcam-only-am8n`
(remote tape control through the kiosk listener; refuses a consent-paused room). Then, after 5 minutes:
`scribe_diff_room opd-6-webcam-only-am8n` must show `1 piece` and a `baseline_bytes_per_ms` near 3.5–4.0. **0 pieces after
10 min with `recording: true` = the C270 is not delivering** → step 5.

## 5. If still silent: the C270 is the fault, not the Mac
The 9 Sep measurement already showed OPD 5's C270 delivering 88% of its energy below 300 Hz. If OPD 6's C270 produces no pieces
at all, swap it for a TONOR at the next walk and re-run steps 2–4. Nothing else on this Mac needs a visit.
