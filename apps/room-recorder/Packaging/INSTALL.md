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
2. Install into `/Applications`. Type the admin password. The pkg hands the app to the room user (the console
   user) so the self-updater keeps working; only the helper side is root-owned (step 6):
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
   Sharing. The daemon does NOT run the file in the app bundle (an admin could swap that): the
   postinstall copies the signed helper to `/Library/PrivilegedHelperTools/`, checks the copy against
   the pinned code-signing requirement, and the daemon plist points there. Check it is loaded:
   `sudo launchctl print system/com.evenscribe.room-recorder.helper | head -20` (`state = running`)
   and that the copy and the plist are root-owned, the directory is not writable by the room user, and
   the copy still carries our signature:
   ```
   ls -ld /Library/PrivilegedHelperTools /Library/PrivilegedHelperTools/com.evenscribe.room-recorder.helper /Library/LaunchDaemons/com.evenscribe.room-recorder.helper.plist
   codesign --verify --strict -R='=identifier "com.evenscribe.room-recorder.helper" and certificate leaf = H"187dd424fb866204111113d60c6f88a21d098edb"' /Library/PrivilegedHelperTools/com.evenscribe.room-recorder.helper && echo pinned-ok
   ```
   All three lines must show `root  wheel` (the directory and the copy `rwxr-xr-x`, the plist
   `-rw-r--r--`) and the last command must print `pinned-ok`. If `launchctl print` cannot find the
   service, load it by hand:
   `sudo launchctl bootstrap system /Library/LaunchDaemons/com.evenscribe.room-recorder.helper.plist`
   After bootstrapping, the postinstall asks launchd for the job BY NAME and logs every step to
   `/var/log/evenscribe-room-recorder-install.log`: `grep postinstall /var/log/evenscribe-room-recorder-install.log | tail -20`.
   A good install ends with `VERIFIED: com.evenscribe.room-recorder.helper is running`. If the job is
   not loaded it bootstraps ONCE more (after 2 s); if it is loaded but not running it runs
   `launchctl kickstart system/<label>` (never `-k`). If it still is not there the log ends with
   `WARNING: ... NOT loaded` or `NOT running`; the app install itself still succeeds, so READ that log
   after every install. The one-line cure is
   `sudo launchctl bootstrap system /Library/LaunchDaemons/com.evenscribe.room-recorder.helper.plist`.
   If the postinstall's log says the copy "does not satisfy the pinned code-signing requirement", it
   changed nothing; the pkg was built wrong, do not use it. Installing the same pkg again is safe: it
   stages and checks a new copy, boots the job out, swaps the copy in, and boots the job back in.
7. **Re-grant the microphone** if asked. The app moved from `~/Applications` to `/Applications`, so
   macOS may ask again: **System Settings › Privacy & Security › Microphone**, switch ON
   **EvenScribe Room Recorder**. If it is already ON, leave it.
   The app reports how the helper runs as `helper_mode` in `status.json` and on the bench row:
   `launchd` (the system daemon above; `helper_registration` is `enabled` once it answers over XPC,
   `notAnswering` if the job is there but silent), `smappservice` (no system plist, so the app asks
   macOS to register the bundle's own daemon plist, which DOES need approval in Login Items), or `none`.
   While the system plist exists the app makes **no SMAppService call at all**: not `register`, not
   `unregister`, not even a status read (0.1.34). In 0.1.33 the app's `unregister()` for this label made
   launchd log `removing service: com.evenscribe.room-recorder.helper` and the daemon vanished at the
   app's first start (OPD 5 and OPD 6); launchd owns the job in this mode. In the other modes
   `helper_registration_error` carries macOS's refusal. If a room that ran 0.1.31 shows a leftover
   background-item entry (`sfltool dumpbtm | grep -A6 room-recorder`), leave it and report it.
   `status.json` also carries `helper_xpc_ok` (did the helper answer a hello over XPC) and
   `helper_version`, beside `helper_mode` and `helper_registration`.
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

## Updates only go up (0.1.30)
The self-updater installs a version only if it is HIGHER than the one running, and only into the
bundle that is running. A channel that offers an older version is ignored, so withdrawing a release no
longer rolls rooms back. To roll a room back, use the rollback script below.

## The self-updater and the root helper (0.1.32, ownership fixed in 0.1.33)
The self-updater is ON. The root daemon runs its own copy in `/Library/PrivilegedHelperTools`, so the
updater swapping the app bundle (a user-level move) can no longer put anything under a root job. The
updater never touches that copy, and its swap script never calls launchd's system domain. **A change to
the helper itself therefore ships only by pkg** (through the fleet's root path when it exists, or
`sudo installer` by hand): an app update leaves the old helper running, and the two talk over a versioned
protocol (a request with a protocol version the helper does not know is refused, not misread).

**Who owns the app bundle.** The room user, not root. 0.1.29 to 0.1.32 left it `root:wheel` and
write-protected, which let the updater work ONCE: the second swap could not delete or reuse the
`.previous` aside copy, failed, and was held. From 0.1.33 the postinstall chowns the bundle to the
console user (or, at the login window, the one user who has the recorder's LaunchAgent), keeps it
non-writable for group and others, and deletes any `.previous` or `.failed` that an earlier swap left
root-owned. Installing the 0.1.33 pkg over a 0.1.29 to 0.1.32 room therefore repairs the updater. If it
cannot tell which user runs the recorder, it says so in the install log and leaves the ownership alone.
Check after installing: `ls -ld "/Applications/EvenScribe Room Recorder.app"` shows the room user, and
`ls -d /Applications/*.previous /Applications/*.failed 2>/dev/null` shows nothing root-owned.

## Uninstall the helper daemon only
Needs `sudo`. The recorder app keeps running; only the root helper goes.
```
sudo launchctl bootout system/com.evenscribe.room-recorder.helper
sudo rm -f /Library/LaunchDaemons/com.evenscribe.room-recorder.helper.plist /Library/PrivilegedHelperTools/com.evenscribe.room-recorder.helper
```
Check: `sudo launchctl print system/com.evenscribe.room-recorder.helper` must say it could not find the
service, and `ls /Library/LaunchDaemons /Library/PrivilegedHelperTools | grep room-recorder` must print
nothing. At the next app start the app reports `helper_mode=smappservice` (or `none`) and, with no
system plist, tries the old SMAppService path. Installing the pkg again re-adds the daemon.

## Roll a room back to an older pkg (for example 0.1.32 to 0.1.31)
**`sudo installer -pkg <older>` alone does NOT downgrade.** The pkgs mark the app bundle as
version-checked, so Installer skips the app when a newer one is installed, and the room stays on the
newer app. The newer app has to be removed first. `Packaging/rollback.sh` does the whole sequence, in
an order that cannot leave the room without an app. Copy it and the older pkg to the room, then:
```
sudo sh rollback.sh /path/to/EvenScribe-Room-Recorder-0.1.31.pkg
```
It prints five numbered steps (the last one now includes the **update pin**, below): (1) boots the recorder's LaunchAgent out for the console user; (2) boots
the root daemon out and deletes its plist and its `/Library/PrivilegedHelperTools` copy; (3) MOVES the
app to `EvenScribe Room Recorder.app.rollback-saved` (it does not delete it) and runs
`pkgutil --forget com.evenscribe.room-recorder.pkg`; (4) runs `installer -pkg <older> -target /`; (5) if
that succeeded, deletes the saved app and boots the agent back in, and if it FAILED, puts the saved app
back and says so (the room then runs the newer app without the root helper; install the newer pkg
again to restore it). Afterwards check `/Applications/EvenScribe Room Recorder.app/Contents/Info.plist`:
`plutil -extract CFBundleShortVersionString raw "/Applications/EvenScribe Room Recorder.app/Contents/Info.plist"`
must print the older version, and `pgrep -fl "room-recorder run"` must show the `/Applications` path.
Rolling back to a pkg older than 0.1.32 leaves no root helper (those pkgs do not install one).

**The update pin (0.1.34).** Without it a room rolled back to 0.1.31 would update itself straight back
up to whatever the channel offers. So the last step of a successful rollback writes
`/Library/Application Support/EvenScribe/update-pin` (root:wheel 644) holding the version that is now
installed, and the self-updater ignores any offered version ABOVE it (one at or below it, and above the
running version, is still taken). It logs `update to X skipped: this Mac was rolled back and pinned at Y`
to `launchd.log`. Look at it with `cat "/Library/Application Support/EvenScribe/update-pin"`. A failed
rollback writes no pin and leaves an existing one alone. If the installed version cannot be read, the
script says `NO pin was written` and the room can climb again; pin it by hand as root:
`echo 0.1.31 | sudo tee "/Library/Application Support/EvenScribe/update-pin"`.
**Any pkg install clears the pin** (its postinstall deletes the file), which is how the fleet's root
path or `sudo installer` of a newer pkg lets the room move forward again; so does
`sudo rm "/Library/Application Support/EvenScribe/update-pin"`. A pin file that is there but is not a
version holds EVERY update and says so in the log: fix or remove it as root. Rolling back is therefore
a deliberate, sticky act, and moving forward again is one too.

The same commands by hand, if the script cannot be used (as root, in this order):
```
launchctl bootout gui/$(stat -f %u /dev/console)/com.evenscribe.room-recorder
launchctl bootout system/com.evenscribe.room-recorder.helper
rm -f /Library/LaunchDaemons/com.evenscribe.room-recorder.helper.plist /Library/PrivilegedHelperTools/com.evenscribe.room-recorder.helper
mv "/Applications/EvenScribe Room Recorder.app" "/Applications/EvenScribe Room Recorder.app.rollback-saved"
pkgutil --forget com.evenscribe.room-recorder.pkg
installer -pkg /path/to/older.pkg -target /
```
If `installer` succeeds, `rm -rf "/Applications/EvenScribe Room Recorder.app.rollback-saved"`. If it fails,
`rm -rf "/Applications/EvenScribe Room Recorder.app"` and move the saved app back.

## Switches
- Kill file: `sudo mkdir -p "/Library/Application Support/EvenScribe" && sudo touch "/Library/Application Support/EvenScribe/helper-disabled"`
  then `sudo launchctl kickstart -k system/com.evenscribe.room-recorder.helper`. The helper stays up, idle, with no XPC listener.
  Remove the file and kickstart again to re-enable.
- Safe mode starts by itself after 3 launches in a row that do not last a minute.

## Known limit
The app bundle is owned by the room user (so it can update itself), which means an admin room user can
replace it. That cannot reach root: the daemon runs only its root-owned, signature-checked copy in
`/Library/PrivilegedHelperTools`, and the helper accepts XPC clients only if they are signed by our
certificate with the app's identifier. What an admin room user can still do by hand (they could already
`sudo`) is stop the daemon, or delete its plist or helper copy; that is detected (`helper_missing`) and
not prevented.

## Building the pkg (on the Mini, Terminal.app, as V)
`apps/room-recorder/Packaging/sign-and-package.sh`
