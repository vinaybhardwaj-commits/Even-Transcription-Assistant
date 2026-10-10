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
5. Check the right app is running. The path in the output must start with `/Applications/`:
   `pgrep -fl "room-recorder run"`
6. **Approve the background item.** On first launch macOS shows *Background Items Added*. If it does
   not, open **System Settings › General › Login Items & Extensions** and under *Allow in the
   Background* switch ON **EvenScribe Room Recorder** (the helper). Enter the admin password if asked.
   The app opens this pane itself once if approval is pending.
7. **Re-grant the microphone** if asked. The app moved from `~/Applications` to `/Applications`, so
   macOS may ask again: **System Settings › Privacy & Security › Microphone**, switch ON
   **EvenScribe Room Recorder**. If it is already ON, leave it.
8. Wait about 90 seconds, then check this room's bench row: `mic_state=authorized`,
   `helper_registration=enabled`, `helper_xpc_ok=true`, `helper_version=0.2.0-h2`.

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
