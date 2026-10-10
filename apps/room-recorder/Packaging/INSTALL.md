# Room visit: install the Room Recorder pkg with the privileged helper

For V, at the room Mac's own screen, signed in as the room's admin account. The pkg is built on the
Mini by `Packaging/sign-and-package.sh` (see the end of this file). Nothing here is run over SSH.

## Before you go
- Copy `EvenScribe-Room-Recorder-<version>.pkg` and its `.sha256` to the room Mac.
- The pkg is NOT Apple-notarized and, because the signing identity has no Installer key usage, may
  be unsigned. macOS will say so. That is expected.

## At the room
1. In Terminal, check the file: `shasum -a 256 -c EvenScribe-Room-Recorder-<version>.pkg.sha256`. It must print `OK`.
2. Install: `sudo installer -pkg EvenScribe-Room-Recorder-<version>.pkg -target /`. Type the admin password.
   (Double-clicking the pkg also works; right-click › Open if macOS blocks it, then enter the admin password.)
   The app lands in `/Applications/EvenScribe Room Recorder.app`, owned by root.
3. Check the install: `codesign --verify --strict --deep "/Applications/EvenScribe Room Recorder.app"` prints nothing and exits 0.
4. Enrol if the Mac is not enrolled yet (the existing bootstrap paste). Then start the app:
   `launchctl kickstart -k gui/$(id -u)/com.evenscribe.room-recorder`.
5. **Approve the background item.** On first launch the app registers the helper and macOS shows
   *Background Items Added*. If it does not, open **System Settings › General › Login Items &
   Extensions**. Under *Allow in the Background*, switch ON **EvenScribe Room Recorder**
   (the entry for the helper). Enter the admin password if asked. The app opens this pane itself
   once if approval is pending.
6. **Re-grant the microphone.** The app's signing identity has not changed, but the app moved from
   `~/Applications` to `/Applications`, so macOS may ask again. **System Settings › Privacy &
   Security › Microphone**: switch ON **EvenScribe Room Recorder**. If it is already ON, leave it.
7. Wait about 90 seconds, then check the bench row for this room: `mic_state=authorized`,
   `helper_registration=enabled`, `helper_xpc_ok=true`, `helper_version=0.2.0-h2`.

## What to write down (the registration proof)
The helper only registers if macOS accepts this self-signed identity for a root daemon. That is not
proven until this step. Record for each room:
- `sfltool dumpbtm | grep -A6 room-recorder` output lines (no secrets), or a screenshot of Login Items.
- `helper_registration` value after step 7.
- If it stays `requiresApproval` after step 5, or `notFound`: stop and report. Do not retry in a loop.

## Switches
- Kill file: `sudo mkdir -p "/Library/Application Support/EvenScribe" && sudo touch "/Library/Application Support/EvenScribe/helper-disabled"`
  then `sudo launchctl kickstart -k system/com.evenscribe.room-recorder.helper`. The helper stays up, idle, with no XPC listener.
  Remove the file and kickstart again to re-enable.
- Safe mode starts by itself after 3 launches in a row that do not last a minute.

## Building the pkg (on the Mini, Terminal.app, as V)
`apps/room-recorder/Packaging/sign-and-package.sh`
