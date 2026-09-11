# OPD 1 — bring-up sequence, 11 Sep 2026

**Why this Mac:** enrolled by paste (`app_install_fygsnma88x2d`, room `opd-1-xqj7`), kiosk listening, recording with a live mic
level (0.011) — the tape side works. But it is **not on the tailnet** (no OPD 1 / consul1 entry in `tailscale status`), so it has no
SSH, no sleep guard and no proven auto-login: the first night it sleeps, it is gone until someone walks in. Mac name and user unknown
until step 1. Same sequence as OPD 4 minus the microphone fault.

Run **on the Mac, in Terminal, one block at a time**. Move on only on `OK`.

## 1. Who am I
```bash
echo "user=$(id -un) host=$(hostname -s) macos=$(sw_vers -productVersion)"; echo "STEP1 OK"
```
Write `user=` and `host=` down.

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
If not installed: install from the App Store page it opened, open Tailscale once, log in with the Even account, re-run.
Write the `tailscale ip:` down.

## 6. Identity this Mac reports
```bash
R="$HOME/Library/Application Support/EvenScribe/RoomRecorder"; echo "install_id=$(plutil -extract install_id raw -o - "$R/config.json") room=$(plutil -extract room_slug raw -o - "$R/config.json") channel=$(plutil -extract update_channel raw -o - "$R/config.json" 2>/dev/null || echo stable) app=$(plutil -extract CFBundleShortVersionString raw "$HOME/Applications/EvenScribe Room Recorder.app/Contents/Info.plist")"; echo "STEP6 OK"
```
Want `install_id=install_fygsnma88x2d room=opd-1-xqj7 channel=stable app=0.1.8`.

## 7. Microphone — confirm which one, set headroom
```bash
system_profiler SPAudioDataType 2>/dev/null | grep -iE "tonor|c270|usb audio|built-in" | head -4; osascript -e "set volume input volume 50"; echo "input volume=$(osascript -e 'input volume of (get volume settings)')"; echo "STEP7 $( system_profiler SPAudioDataType 2>/dev/null | grep -qiE "tonor|c270|usb audio" && echo OK || echo "FAIL - built-in mic only" )"
```
A built-in-only result means it is recording the Mac's own mic — works, but add a TONOR at the next opportunity.

## 8. Restart the recorder and prove it
```bash
launchctl kickstart -k gui/$(id -u)/com.evenscribe.room-recorder; sleep 8; tail -3 "$HOME/Library/Application Support/EvenScribe/RoomRecorder/launchd.log"; echo "STEP8 $( tail -3 "$HOME/Library/Application Support/EvenScribe/RoomRecorder/launchd.log" | grep -q "microphone authorized" && echo OK || echo FAIL )"
```

## 9. From the Air, afterwards
```bash
ssh -o PreferredAuthentications=password <user>@<tailscale-ip> 'echo "sleep=$(pmset -g | awk "/^ sleep/{print \$2}") app=$(plutil -extract CFBundleShortVersionString raw "$HOME/Applications/EvenScribe Room Recorder.app/Contents/Info.plist")"'
```
Connects, `sleep=0` = done. Add the row to §C of `ETA-OPD-VISIT-RUNBOOK-11-SEP-2026.md`.
