# OPD 7 (CONSUL7) — bring-up sequence, 11 Sep 2026

**Why this Mac:** Tailscale `100.127.98.43` shows `offline, last seen 22h`; a fresh enrolment (`install_qedhc39yj22s`) polled at
10:01 IST and went dark within minutes. It sleeps, or sits at the login screen. Nothing remote works until steps 2 and 4 are done.
Expected login user: `ehrc-consul7` (the `ehrc-<mac>` pattern; the prompt confirms it).

Run **on the Mac, in Terminal, one block at a time, in this order**. Each ends with a verdict line — move on only on `OK`.

## 1. Who am I (30 s)
```bash
echo "user=$(id -un) host=$(hostname -s)"; echo "STEP1 OK"
```
Write the `user=` value down — it is the SSH login for every paste from the desk.

## 2. Never sleep
```bash
sudo pmset -a sleep 0 disksleep 0 displaysleep 10 autorestart 1 womp 1 powernap 0; pmset -g custom | grep -E "^ (sleep|disksleep|autorestart|womp|powernap)"; echo "STEP2 $( [ "$(pmset -g | awk '/^ sleep/{print $2}')" = "0" ] && echo OK || echo FAIL )"
```

## 3. Remote Login (sshd)
```bash
sudo launchctl enable system/com.openssh.sshd; sudo launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist 2>/dev/null; sudo launchctl kickstart -k system/com.openssh.sshd; sleep 2; echo "STEP3 $( nc -z -w 2 127.0.0.1 22 >/dev/null 2>&1 && echo OK || echo FAIL )"
```
On FAIL: System Settings → General → Sharing → Remote Login → on → "All users", then re-run.

## 4. Automatic login (this is the OPD 7 fault)
Prompts once for this Mac's login password; the password is never echoed or stored in the command.
```bash
read -s "PW?This Mac's login password: "; echo; sudo sysadminctl -autologin set -userName "$(id -un)" -password "$PW"; unset PW; echo "STEP4 $( [ "$(sudo defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null)" = "$(id -un)" ] && echo OK || echo FAIL )"
```
On FAIL (FileVault on, or older macOS): System Settings → Users & Groups → Automatic login → this user. Then re-run only the
`echo "STEP4 …"` part to confirm.

## 5. Tailscale up
```bash
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; $TS status --self=true --peers=false 2>/dev/null | head -1; [ -z "$($TS ip -4 2>/dev/null)" ] && $TS login; sleep 3; echo "tailscale ip: $($TS ip -4 2>/dev/null)"; echo "STEP5 $( [ -n "$($TS ip -4 2>/dev/null)" ] && echo OK || echo FAIL )"
```
If `$TS login` opens a browser, sign in with the Even account, come back, re-run the block.

## 6. Identity this Mac reports
```bash
R="$HOME/Library/Application Support/EvenScribe/RoomRecorder"; echo "install_id=$(plutil -extract install_id raw -o - "$R/config.json") room=$(plutil -extract room_slug raw -o - "$R/config.json") channel=$(plutil -extract update_channel raw -o - "$R/config.json" 2>/dev/null || echo stable) app=$(plutil -extract CFBundleShortVersionString raw "$HOME/Applications/EvenScribe Room Recorder.app/Contents/Info.plist")"; echo "STEP6 OK"
```
Want `install_id=install_qedhc39yj22s room=opd-7-y74w channel=stable app=0.1.8`. A different install_id means someone re-pasted the
bootstrap again — fine, just report it.

## 7. Microphone present (TONOR)
```bash
system_profiler SPAudioDataType 2>/dev/null | grep -iE "tonor|c270|usb audio" | head -3; osascript -e "set volume input volume 50"; echo "input volume=$(osascript -e 'input volume of (get volume settings)')"; echo "STEP7 $( system_profiler SPAudioDataType 2>/dev/null | grep -qiE "tonor|c270|usb audio" && echo OK || echo FAIL )"
```
On FAIL: plug the TONOR in, then System Settings → Sound → Input → select it, re-run.

## 8. Restart the recorder and prove it
```bash
launchctl kickstart -k gui/$(id -u)/com.evenscribe.room-recorder; sleep 8; tail -3 "$HOME/Library/Application Support/EvenScribe/RoomRecorder/launchd.log"; echo "STEP8 $( tail -3 "$HOME/Library/Application Support/EvenScribe/RoomRecorder/launchd.log" | grep -q "microphone authorized" && echo OK || echo FAIL )"
```

## 9. From the Air, afterwards (proof the walk worked)
```bash
ssh -o PreferredAuthentications=password ehrc-consul7@100.127.98.43 'echo "sleep=$(pmset -g | awk "/^ sleep/{print \$2}") autologin=$(sudo -n defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || echo needs-sudo) app=$(plutil -extract CFBundleShortVersionString raw "$HOME/Applications/EvenScribe Room Recorder.app/Contents/Info.plist")"'
```
Connects and prints `sleep=0` = done. Then `scribe_diff_room opd-7-y74w` must say `listening`, and a piece lands within 5 min of a start.
