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
   The postinstall does not trust `launchctl` exit codes: `bootout` is asynchronous, and a `bootstrap`
   fired while the old job is still being removed is refused ("in progress", error 5 or 37) or silently
   leaves nothing (this is how 0.1.33 rooms ended up with no daemon). So it (1) boots the job out, then
   asks `launchctl print system/<label>` once a second, up to 10 s, until the job is GONE; (2)
   bootstraps, and if the job is not there afterwards retries up to 3 more times, 2 s apart; (3) if the
   job is loaded but not running, runs `launchctl kickstart system/<label>` (never `-k`); (4) requires
   `state = running` from `launchctl print`. Every step is logged to
   `/var/log/evenscribe-room-recorder-install.log`:
   `grep postinstall /var/log/evenscribe-room-recorder-install.log | tail -20`.
   A good install ends with `VERIFIED: com.evenscribe.room-recorder.helper is running`.
   **If every try is spent and the job is still not running, the postinstall exits 1 and the installer
   reports the install as FAILED.** The app and the daemon plist are already on disk at that point, so
   the failure is not a broken room: the log's last line says the one command that finishes it
   (`sudo launchctl bootstrap system /Library/LaunchDaemons/com.evenscribe.room-recorder.helper.plist`, or
   `sudo launchctl kickstart system/com.evenscribe.room-recorder.helper` when it is loaded but idle).
   A line starting `WARNING: ... is running, but no bootstrap succeeded` means an older definition of
   the job is still running the previous helper code: `sudo launchctl bootout system/<label>` then the
   bootstrap command. A helper that is missing from the bundle, or a copy that fails the signature check,
   changes nothing and does NOT fail the install (there is nothing to load; the log says why).
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

## Signed commands are live (0.1.35)
The app polls the server for commands over HTTPS (outbound only, no inbound port) and the root helper runs the
ones that need root. It is **ON by default**; turn it off on one Mac with `"fleet_client_enabled": false` in
`config.json` (a hand on the Mac; nothing the server sends can change it). A command is run only if it is a v2
envelope **signed with the server's key `fk1`** (compiled into both the app and the helper), addressed to THIS
device and machine, inside its time window, and with a nonce never seen before. The root helper verifies every
envelope itself before acting, so a tampered app cannot make it do anything the server did not sign.

The catalogue is closed: `helper_status`, `collect_diag` (answers `unsupported` until an upload route exists),
`report_diag`, `list_audio_inputs`, `select_audio_input`, `coreaudiod_reset`, `usb_reseat` (always `unsupported`),
`self_test`, `restart_recorder`, `reload_launchagent`, `pieces_inventory`, `pieces_reupload`, `wake`,
`pmset_enforce`, `schedule_poweron`. No shell, no file path, no autologin. Gates: a reset, restart or reload is
refused while a session is open (a restart can be forced with `force` AND an `approval_ref`); the four privileged
verbs need an `approval_ref` between 07:30 and 21:30 IST; at most 10 privileged verbs an hour and one
coreaudiod reset per 30 minutes; the GUI verbs need someone at the console. A refusal comes back as a result with
the reason (`replay`, `expired`, `machine_mismatch`, `session_open`, ...).

## Power and the app watchdog (0.1.35, the helper)
- **Power baseline.** At helper start and every 15 minutes the helper sets `sleep 0, disksleep 0, displaysleep 0,
  powernap 0, autorestart 1, womp 1` (only what differs) and re-asserts `pmset repeat wakeorpoweron MTWRFSU
  07:05:00`; a manual change is reverted at the next pass and logged. Autologin is never touched.
- **Watchdog.** Every 30 s the helper checks for a console user and for the app process. If the app is gone it
  puts the LaunchAgent plist back when it is missing, then `bootstrap`s it (or `kickstart`s it, never `-k`),
  backing off 30 s, 1, 2, 4, then 5 minutes. At the login window it does nothing and records
  `app_state=no_console_user`. It will NOT fight a recorder that stopped for `needs_enrol`, an update in flight
  (`update-handover.json` under 30 minutes old), or an operator: `touch` a file called `watchdog-hold` in
  `~/Library/Application Support/EvenScribe/RoomRecorder/` to keep the helper's hands off the app, delete it to
  give it back.
- **What to read.** `/Library/Application Support/EvenScribe/helper-heartbeat.json` (root-written, readable by
  all) has `app_state`, `console_user`, `power_schedule`, `pmset_drift`, `watchdog_failures`. The app reports the
  same on its bench poll and in `status.json` as `helper_state`, `power_schedule`, `pmset_drift`.
- **Not built:** the helper cannot post its own heartbeat to the server (the device key lives with the app in the
  room user's keychain), so nothing reports while nobody is logged in except that local file; and the helper checks
  the app by its process, not by an XPC hello to the app.

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
