# The one paste — hospital runbook, 10 September 2026

Stable release is 0.1.8 (`rel_nz8d8uh5q9pj`). The card's "Copy install command" mints a per-room token and installs
0.1.8; fetching the command does not spend the token, so a failed paste can be re-run. Proven on Home Office 10 Sep:
no password, no mic prompt, card row updates within a minute.

Before leaving: sign in to evenscribe.app/admin/bench on the phone.

Per room — OPD 3, OPD 5, Cardiology OPD, OPD 7:
1. Between patients. The install stops the running app ~30 s; an open session ends.
2. OPD 5 first: plug the TONOR TM20, System Settings → Sound → Input → TONOR, unplug the C270.
3. Terminal on the room Mac → paste the room's install command → Return. Expect
   `Installed and enrolled as <room>. Close this window.`
4. Refresh the card: row reads 0.1.8, mic authorized, tape line within a minute. If still 0.1.7 after 2 min, stop
   and report before the next room.
5. Cardiology: kiosk silent since 19:21 IST 9 Sep with a session still marked recording. Check the Mac is awake and
   on the network first.

Skip `df -h /` — 0.1.8 reports disk_free_bytes.

After the first clinic room is on 0.1.8, the orchestrator runs §13.5 item 7 remotely (publish to `test`, prove only
Home Office moves). Item 5 (corrupted zip) runs remotely on Home Office. OPD 1 / OPD 4 Ortho: per V's decision.

## While at each Mac — the "never walk again" settings (no code, 3 minutes per room)
1. System Settings → General → Sharing → **Remote Login ON**, **Screen Sharing ON**. Note the Mac's IP / hostname.
   If the hospital has Tailscale or a VPN reachable from home, join the Mac to it.
2. Users & Groups → **Automatic login ON** for the room user. The LaunchAgent runs only inside a login session.
3. Terminal: `sudo pmset -a autorestart 1 sleep 0 disksleep 0` (Mac password) — restart after power failure, never sleep.
4. Record which microphone the card shows for the room after the paste.

Standing rule from today: nothing is published to `stable` until the same build has polled successfully from `test`
on Home Office. Release B, in order: launch canary (roll back to `.previous` if the new version does not poll within
N minutes), remote channel + input-device selection (R4), session-token refresh before the 365-day expiry.

## Tailscale, per room Mac (V's account, same tailnet as the Air and the Mini)
1. Install (App Store or tailscale.com pkg), open, sign in — approve in the browser on that Mac.
2. Preferences → Start at login.
3. Remote Login ON (Sharing). Note the Tailscale machine name and the room user's short name.
4. From the Air, before leaving the building: `ssh <user>@<machine-name>` then
   `launchctl print gui/$(id -u)/com.evenscribe.room-recorder | head -5`. That working = the last walk.

## Per-Mac terminal blocks (same on every room Mac; block 1 is per room)

Block 1 — Safari on the room Mac → evenscribe.app/admin/bench → sign in → the room's "Copy install command" → Terminal →
paste → Return. Tokens live 30 min; fetching does not spend them. OPD 5: swap the mic (Sound → Input → TONOR) before this.

Block 2 — remote access + power (Mac password once):
sudo -v && sudo systemsetup -setremotelogin on && sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart -activate -configure -allowAccessFor -allUsers -privs -all -restart -agent >/dev/null 2>&1; sudo pmset -a autorestart 1 sleep 0 disksleep 0 womp 1; echo "--- filevault:"; fdesetup status; echo "--- autologin:"; sudo defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || echo "OFF -> System Settings > Users & Groups > Automatic login"; echo "--- me: $(whoami) @ $(hostname) $(ipconfig getifaddr en0)"; launchctl print gui/$(id -u)/com.evenscribe.room-recorder 2>/dev/null | grep -E "state =|pid =" | head -2
FileVault On ⇒ auto-login impossible on that Mac; report it. Autologin OFF ⇒ set it in Users & Groups before leaving.

Block 3 — Tailscale (standalone pkg, has the CLI):
curl -fsSL -o /tmp/Tailscale.pkg https://pkgs.tailscale.com/stable/Tailscale-1.102.3-macos.pkg && sudo installer -pkg /tmp/Tailscale.pkg -target / && open -a Tailscale && sleep 6 && /Applications/Tailscale.app/Contents/MacOS/Tailscale up --ssh --accept-dns
Open the printed login URL in Safari on that Mac, sign in, approve. Menu bar → Preferences → Start at login.

Block 4 — record for home:
/Applications/Tailscale.app/Contents/MacOS/Tailscale status --self | head -2; echo "ssh $(whoami)@$(hostname -s)"
Photograph it. Then refresh the card: 0.1.8, mic authorized. Next room.
