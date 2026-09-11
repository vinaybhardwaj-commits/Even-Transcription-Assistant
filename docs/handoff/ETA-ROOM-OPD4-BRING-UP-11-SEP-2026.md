# OPD 4 (Ortho) — bring-up sequence, 11 Sep 2026

**Why this Mac:** enrolled by paste (`app_install_kurmsj5wdjau`, room `opd-4-ortho-778q`), kiosk listening — but **not on the
tailnet under any name**, and its tape says "recording, silent 31 min" with a mic level of exactly 0: no input device selected.
It never had the fleet basics. Mac name and user unknown until step 1.

Run **on the Mac, in Terminal, one block at a time**. Move on only on `OK`.

## 1. Who am I
```bash
echo "user=$(id -un) host=$(hostname -s) macos=$(sw_vers -productVersion)"; echo "STEP1 OK"
```
Write `user=` and `host=` down — the §C row and every desk paste key on them.

## 2. Never sleep
```bash
sudo pmset -a sleep 0 disksleep 0 displaysleep 10 autorestart 1 womp 1 powernap 0; pmset -g custom | grep -E "^ (sleep|disksleep|autorestart|womp|powernap)"; echo "STEP2 $( [ "$(pmset -g | awk '/^ sleep/{print $2}')" = "0" ] && echo OK || echo FAIL )"
```

## 3. Remote Login (sshd)
```bash
sudo launchctl enable system/com.openssh.sshd; sudo launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist 2>/dev/null; sudo launchctl kickstart -k system/com.openssh.sshd; sleep 2; echo "STEP3 $( nc -z -w 2 127.0.0.1 22 >/dev/null 2>&1 && echo OK || echo FAIL )"
```
On FAIL: System Settings → General → Sharing → Remote Login → on → "All users", re-run.

## 4. Automatic login
```bash
read -s "PW?This Mac's login password: "; echo; sudo sysadminctl -autologin set -userName "$(id -un)" -password "$PW"; unset PW; echo "STEP4 $( [ "$(sudo defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null)" = "$(id -un)" ] && echo OK || echo FAIL )"
```
On FAIL: System Settings → Users & Groups → Automatic login → this user.

## 5. Tailscale — installed, logged in, on the tailnet
```bash
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; if [ ! -x "$TS" ]; then echo "Tailscale not installed"; open "https://apps.apple.com/app/tailscale/id1475387142"; fi; [ -x "$TS" ] && { $TS status --self=true --peers=false 2>/dev/null | head -1; [ -z "$($TS ip -4 2>/dev/null)" ] && $TS login; sleep 3; echo "tailscale ip: $($TS ip -4 2>/dev/null)"; }; echo "STEP5 $( [ -x "$TS" ] && [ -n "$($TS ip -4 2>/dev/null)" ] && echo OK || echo FAIL )"
```
If it says not installed: install from the App Store page it opened, open Tailscale once, log in with the Even account, re-run.
Write the `tailscale ip:` down.

## 6. Identity this Mac reports
```bash
R="$HOME/Library/Application Support/EvenScribe/RoomRecorder"; echo "install_id=$(plutil -extract install_id raw -o - "$R/config.json") room=$(plutil -extract room_slug raw -o - "$R/config.json") channel=$(plutil -extract update_channel raw -o - "$R/config.json" 2>/dev/null || echo stable) app=$(plutil -extract CFBundleShortVersionString raw "$HOME/Applications/EvenScribe Room Recorder.app/Contents/Info.plist")"; echo "STEP6 OK"
```
Want `install_id=install_kurmsj5wdjau room=opd-4-ortho-778q channel=stable app=0.1.8`.

## 7. Microphone — this is the OPD 4 fault
```bash
system_profiler SPAudioDataType 2>/dev/null | grep -iE "tonor|c270|usb audio|built-in" | head -4; echo "STEP7 $( system_profiler SPAudioDataType 2>/dev/null | grep -qiE "tonor|c270|usb audio" && echo OK || echo "FAIL - no external mic" )"
```
On FAIL: plug a microphone in (TONOR preferred; C270 acceptable). Then, always: **System Settings → Sound → Input → select it**
and check the level meter moves when you speak. Then:
```bash
osascript -e "set volume input volume 50"; echo "input volume=$(osascript -e 'input volume of (get volume settings)')"; echo "STEP7b OK"
```

## 8. Restart the recorder and prove it
```bash
launchctl kickstart -k gui/$(id -u)/com.evenscribe.room-recorder; sleep 8; tail -3 "$HOME/Library/Application Support/EvenScribe/RoomRecorder/launchd.log"; echo "STEP8 $( tail -3 "$HOME/Library/Application Support/EvenScribe/RoomRecorder/launchd.log" | grep -q "microphone authorized" && echo OK || echo FAIL )"
```

## 9. From the Air, afterwards
```bash
ssh -o PreferredAuthentications=password <user>@<tailscale-ip> 'echo "sleep=$(pmset -g | awk "/^ sleep/{print \$2}") app=$(plutil -extract CFBundleShortVersionString raw "$HOME/Applications/EvenScribe Room Recorder.app/Contents/Info.plist")"'
```
Connects, `sleep=0` = done. Then `scribe_diff_room opd-4-ortho-778q`: `mic_level.peak` must be > 0 and a piece must land within
5 min of recording. A peak that stays at 0.000 means the input is still not selected.
