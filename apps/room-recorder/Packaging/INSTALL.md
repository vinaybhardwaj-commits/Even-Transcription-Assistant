# Room visit: install the Room Recorder pkg with the privileged helper

For V, at the room Mac's own screen, signed in as the room's admin account. The pkg is built on
the Mini by `Packaging/sign-and-package.sh` (last section). Nothing here is run over SSH.

The pkg is **unsigned**. The app inside it is signed with the EvenScribe Room Recorder identity.
Install it with `sudo installer`, which Gatekeeper does not check. Do not double-click it.

## Before you go
- Copy `EvenScribe-Room-Recorder-<version>.pkg` and its `.pkg.sha256` to the room Mac (same folder).
  A file copied by AirDrop or a browser is quarantined; a file copied with `scp` or a USB stick is not.

## At the room (all in Terminal, as the room's admin user)
1. Check the file. It must print `OK`:
   `shasum -a 256 -c EvenScribe-Room-Recorder-<version>.pkg.sha256`
2. Install into `/Applications` (owned by root). Type the admin password:
   `sudo installer -pkg EvenScribe-Room-Recorder-<version>.pkg -target /`
3. Check the installed bundle. It prints nothing and returns 0:
   `codesign --verify --deep --strict "/Applications/EvenScribe Room Recorder.app"`
4. **Point the room's LaunchAgent at the /Applications app.** The existing agent still runs the old
   `~/Applications` copy, so the new app and the helper never start until this is done.
   Stop the old one, rewrite the agent from the new app (this is the same `install-launch-agent`
   the bootstrap script runs), then start it:
   ```
   launchctl bootout gui/$(id -u)/com.evenscribe.room-recorder
   "/Applications/EvenScribe Room Recorder.app/Contents/MacOS/room-recorder" install-launch-agent
   plutil -extract ProgramArguments.0 raw ~/Library/LaunchAgents/com.evenscribe.room-recorder.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.evenscribe.room-recorder.plist
   ```
   The `plutil` line must print `/Applications/EvenScribe Room Recorder.app/Contents/MacOS/room-recorder`.
   If it prints anything else, stop; do not run the `bootstrap` line.
   This also installs the 0.1.29 plist: `KeepAlive` is now `true`, so launchd restarts the app after
   ANY exit, a clean one included. Check it before the `bootstrap` line (it must print `true`):
   `plutil -extract KeepAlive raw ~/Library/LaunchAgents/com.evenscribe.room-recorder.plist`
   An old plist (`SuccessfulExit` instead of `true`) means this step was skipped; a room left on it
   stays stopped after a clean exit. The agent is only re-read at `bootout` then `bootstrap`; a
   `kickstart` does not reload the file.
   A retired or never-enrolled app now idles instead of exiting. That is deliberate: it is how it
   stays stopped under `KeepAlive true`.
   A Mac that was never enrolled needs the usual bootstrap paste first; this step does not enrol.
   **0.1.30 also fixes the tool paths.** `install-launch-agent` (and every app start) rewrites
   `tapewriter_path` and `ffmpeg_path` in `config.json` to the copies inside the running bundle, and
   prints one line per change. Check, after step 5, that neither points into `~/Applications`:
   `plutil -p "$HOME/Library/Application Support/EvenScribe/RoomRecorder/config.json" | grep -E "tapewriter_path|ffmpeg_path"`
   Both must start with `/Applications/EvenScribe Room Recorder.app/`.
5. Check the right app is running. The path in the output must start with `/Applications/`:
   `pgrep -fl "room-recorder run"`
6. **No approval click (0.1.32).** The pkg's postinstall installs the helper as a classic system
   LaunchDaemon, which macOS does not ask the user to approve: no Login Items prompt, no Screen
   Sharing. Check it is loaded and answering (the first line must be the job, `state = running`):
   `sudo launchctl print system/com.evenscribe.room-recorder.helper | head -20`
   and that the app and the daemon plist are owned by root:
   `ls -ld "/Applications/EvenScribe Room Recorder.app" /Library/LaunchDaemons/com.evenscribe.room-recorder.helper.plist`
   Both must show `root  wheel`, and the plist `-rw-r--r--`. If `launchctl print` says it could not
   find the service, load it by hand:
   `sudo launchctl bootstrap system /Library/LaunchDaemons/com.evenscribe.room-recorder.helper.plist`
   Installing the same pkg again is safe: it rewrites the same plist and reloads the job.
7. **Re-grant the microphone** if asked. The app moved from `~/Applications` to `/Applications`, so
   macOS may ask again: **System Settings › Privacy & Security › Microphone**, switch ON
   **EvenScribe Room Recorder**. If it is already ON, leave it.
   The app reports how the helper runs as `helper_mode` in `status.json` and on the bench row:
   `launchd` (the system daemon above; `helper_registration` is `enabled` once it answers over XPC,
   `notAnswering` if the job is there but silent), `smappservice` (no system plist, so the app asks
   macOS to register the bundle's own daemon plist, which DOES need approval in Login Items), or `none`.
   While the system plist exists the app never calls `register()`: two registrations of one Mach
   service would fight. `helper_registration_error` carries macOS's refusal in the other modes.
8. Wait about 90 seconds, then check this room's bench row: `mic_state=authorized`,
   `helper_mode=launchd`, `helper_registration=enabled`, `helper_xpc_ok=true`, `helper_version=0.2.0-h2`.

## Remove the old ~/Applications copy (only after steps 5 and 8 pass)
Never delete it before the new app is the one running.
1. Confirm nothing runs from it. This must print nothing:
   `pgrep -fl "$HOME/Applications/EvenScribe Room Recorder.app"`
2. Move it aside, do not delete it yet:
   `mv "$HOME/Applications/EvenScribe Room Recorder.app" "$HOME/Applications/EvenScribe Room Recorder.app.old"`
3. Leave `EvenScribe Room Recorder.app.previous` (the updater's rollback copy) alone if it exists.
4. After a full clinic day with the room recording normally, delete the `.old` copy:
   `rm -rf "$HOME/Applications/EvenScribe Room Recorder.app.old"`
Roll back (before step 4 of this section): `launchctl bootout gui/$(id -u)/com.evenscribe.room-recorder`,
move the `.old` copy back, run its `install-launch-agent`, then `launchctl bootstrap` as above.

## If the installer is blocked
`sudo installer` is not subject to Gatekeeper, so this should not happen. If macOS still refuses the
pkg, the only fallback is **System Settings › Privacy & Security**, scroll to the message about the
pkg, and click **Open Anyway**, then re-run step 2. Right-click › Open does not work on macOS 15.

## What to write down (the registration proof)
The helper only registers if macOS accepts this self-signed identity for a root daemon. That is not
proven until this step. Record for each room:
- `sfltool dumpbtm | grep -A6 room-recorder` lines (no secrets), or a screenshot of Login Items.
- The `helper_registration` value after step 8.
- If it stays `requiresApproval` after step 6, or shows `notFound`: stop and report. Do not retry in a loop.

## The command client (0.1.30), off by default
0.1.30 contains the outbound long-poll client for the signed command channel. It is OFF: it reads no
key, registers nothing and sends nothing unless `config.json` says `"fleet_client_enabled": true`, which
only a hand on this Mac sets. Install 0.1.30 first; turn it on per room, later, when the server queues
commands. It cannot be turned on by the server.

## Updates only go up (0.1.30), and are OFF while the root daemon is installed (0.1.32)
The self-updater installs a version only if it is HIGHER than the one running, and only into the
bundle that is running. A channel that offers an older version is ignored, so withdrawing a release no
longer rolls rooms back. To roll a room back, install the older pkg by hand.

With the system LaunchDaemon installed, **the self-updater is switched off** (the app logs
`self-update is off: a root LaunchDaemon runs the helper from this bundle`). The updater swaps the
whole bundle with a user-level move; that would leave a helper binary owned by the room user under a
daemon that runs as root, and it cannot chown to root. So the bundle changes only through a pkg
installed with `sudo installer`, which re-owns it to root:wheel and reloads the daemon. Rooms on
0.1.32 therefore need each upgrade installed by hand (or by the fleet's root path when it exists).
An admin user can still replace the bundle by hand (room accounts are admin); that was true before and
is the known limit below.

## Uninstall the helper daemon, or roll back to the app without it
Both need `sudo`. The recorder app keeps running; only the root helper goes.
```
sudo launchctl bootout system/com.evenscribe.room-recorder.helper
sudo rm /Library/LaunchDaemons/com.evenscribe.room-recorder.helper.plist
```
Check: `sudo launchctl print system/com.evenscribe.room-recorder.helper` must say it could not find the
service, and `ls /Library/LaunchDaemons | grep room-recorder` must print nothing. The app then reports
`helper_mode=smappservice` (or `none`) and, from the next start, tries the old SMAppService path.
The self-updater comes back as soon as the plist is gone. Installing the pkg again re-adds the daemon.
To go back to 0.1.31 entirely: remove the daemon as above, then `sudo installer` the 0.1.31 pkg.

## Switches
- Kill file: `sudo mkdir -p "/Library/Application Support/EvenScribe" && sudo touch "/Library/Application Support/EvenScribe/helper-disabled"`
  then `sudo launchctl kickstart -k system/com.evenscribe.room-recorder.helper`. The helper stays up, idle, with no XPC listener.
  Remove the file and kickstart again to re-enable.
- Safe mode starts by itself after 3 launches in a row that do not last a minute.

## Known limit
The app's self-updater swaps the bundle with a user-level move, so an updated bundle is owned by
the room user, not root. This undoes the pkg's root ownership for the bundle the helper runs from.
Accepted for now; it needs a ruling before the update path ships.

## Building the pkg (on the Mini, Terminal.app, as V)
`apps/room-recorder/Packaging/sign-and-package.sh`
