# ETA FLEET — OPD DAY KIT: OPD 4 and OPD 1 off 0.1.8, onto the tailnet, and 0.1.23 prepared

**Written 16 Sep 2026 for V's site visit on 17 Sep.** Lane 2, fleet cluster 3. Researcher, read-only. Uncommitted.
Why this visit is needed: `ETA-FLEET-C3-UPDATE-PATH-16-SEP-2026.md`. 0.1.8's updater requires `anchor trusted` as well as
our certificate leaf. No release we publish can satisfy that on these two Macs, so each one gets one bootstrap paste by hand.

Rulings applied (Orchestrator, 16 Sep):
- Bootstrap paste only. No per-Mac certificate trust.
- A new install id is accepted.
- PR #3 ships as 0.1.23: `test` first, then `stable`.

---

## 0. The facts this kit stands on (read 16 Sep 13:14Z, fleet + source)

| | OPD 4 - Ortho | OPD 1 |
|---|---|---|
| room slug | `opd-4-ortho-778q` | `opd-1-xqj7` |
| install id NOW (will be retired by the paste) | `install_kurmsj5wdjau` | `install_fygsnma88x2d` |
| app / build | 0.1.8 / `7d21f5e` | 0.1.8 / `7d21f5e` |
| macOS | 26.6.2 | 15.7.9 |
| hostname the app reports | `EHRC-CONSUL4’s Mac mini (2)` | `EHRC-CONSUL2’s Mac mini (2)` |
| mic the fleet expects | `C270 HD WEBCAM` | `C270 HD WEBCAM` |
| last update | `signature_mismatch` on 0.1.21, 00:56Z today | `signature_mismatch` on 0.1.21, 01:44Z today |
| on the tailnet | **no** | **no** |
| SSH from the desk | **no** | **no** (see below) |
| what the paste installs | `stable` **0.1.21**, build `55be1d1`, sha256 `02658e6a…9e158` | same |

**OPD 1's reachability, determined 16 Sep from the Home Office Mini, read-only:**
- `tailscale status` lists 10 peers. The clinic Macs among them are consul4, consul5, consul6, consul7, discussion and echo. There is no consul2 and no OPD 1 entry.
- The fleet row gives no IP.
- The clinic Macs accept passwords only: a `BatchMode` key login to consul6 and consul4 was refused. So no tailnet Mac can serve as a LAN jump without typing a password, and I did not try one.

**Verdict: OPD 1 cannot be reached from anywhere off site today. Treat it exactly like OPD 4, with console first.**

**Does the paste force a re-enrol? YES, always.**
- The command is minted by the room card's "Copy install command" (`components/admin/BenchInstallFleet.tsx:120` → `POST /api/admin/rooms/{id}/bootstrap-token`).
- Minting inserts a new `room_install` row with a fresh id every time (`lib/room-install.ts:157–211`).
- The script always runs `enrol --token` (`lib/room-install.ts:579`).
- The enrol transaction retires every other live install of the room at that moment, not at mint (`lib/room-install.ts:662–679`).
- So after a successful paste, OPD 4 and OPD 1 each have a new install id, and `install_kurmsj5wdjau` / `install_fygsnma88x2d` are retired. Their history stays on the retired rows.

**The token lasts 30 minutes** (`TOKEN_TTL_MINUTES = 30`, `lib/room-install.ts:150`) and works once. Mint it on site, right before pasting.

**The microphone grant carries over.** The designated requirement is unchanged since 0.1.13 (`identifier "com.evenscribe.room-recorder" and certificate leaf = H"187dd424…"`). The five SSH rooms kept their grant through the same paste on 11 Sep. §B4 still checks it.

---

## How to use this kit

- **Terminal on the Mac** means Spotlight → Terminal. The shell is zsh. Paste one block at a time. Every block ends with a line
  `<STEP> OK` or `<STEP> FAIL`. Move on only on OK.
- **Order per room: A (bring-up, console only), then B (upgrade), then C (audio), then D (desk).** Bring-up comes first on
  purpose: if the upgrade goes wrong halfway, a room with SSH and Tailscale can be recovered from the desk.
- **Timing.** The paste stops the recorder for about a minute. Do it before the first patient or after the last one.
- `sudo` asks for the Mac's login password. Type it at the prompt; never paste a password into this file or a chat.

### Console versus SSH, per room (identical for OPD 4 and OPD 1)

| Step | Where | Why |
|---|---|---|
| A1 who am I | console | there is no SSH yet |
| A2 never sleep | console | `sudo`; there is no SSH yet |
| A3 Remote Login | console | `sudo`; this is what creates SSH |
| A4 automatic login | console | password prompt; FileVault may send you to System Settings |
| A5 Tailscale install + login | **console only, always** | macOS extension/VPN prompts and the browser login need clicks on this screen |
| B1 before-state | console **or** SSH from the Air once A3+A5 are OK | read-only |
| B2 backup | console or SSH | files only |
| B3 mint + paste | console or SSH (`launchctl … gui/<uid>` works over SSH while the room user is logged in, as on 11 Sep) | |
| B4 after-state | console or SSH | read-only |
| B5 microphone fix (only if B4 says so) | **console** | Privacy & Security toggle |
| C1 audio sanity | console or SSH | read-only |
| D1 fleet check, D2 SSH key | the desk / the Air | |

**Count per room:** 5 steps are console-only (A1–A5); 5 can go either way (B1–B4, C1); 1 conditional step is console (B5); 2 are desk
steps (D1, D2). **Recommendation for tomorrow:** after A5 is OK, run B1–C1 **from the Air over SSH while standing in the room.**
If the first `ssh` connects, that proves A3 and A5 before you walk away. If it does not connect, run B1–C1 on the Mac's own
Terminal instead; nothing in B depends on SSH.

---

# ROOM: OPD 4 - Ortho

## A. Bring-up, on the Mac's own Terminal

These are the 11 Sep bring-up blocks (`ETA-ROOM-OPD4-BRING-UP-11-SEP-2026.md`), proven on six rooms. Only A5 changed: it
installs Tailscale from the standalone package the hospital runbook used, and names the node.

### A1 — who am I
```bash
echo "user=$(id -un) host=$(hostname -s) macos=$(sw_vers -productVersion) console=$(stat -f %Su /dev/console) lan=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)"; echo "A1 OK"
```
- **Works:** `user=<name> … macos=26.6.2 console=<same name> lan=<192.168…>`. Write `user=` down; every later SSH line uses it.
  Expected `ehrc-consul4`, UNVERIFIED, inferred from the hostname.
- **Does not work:** `console=root` or a different name means someone else is logged in at the screen. Log in as the room user first.

### A2 — never sleep
```bash
sudo pmset -a sleep 0 disksleep 0 displaysleep 10 autorestart 1 womp 1 powernap 0; pmset -g custom | grep -E "^ (sleep|disksleep|autorestart|womp|powernap)"; echo "A2 $( [ "$(pmset -g | awk '/^ sleep/{print $2}')" = "0" ] && echo OK || echo FAIL )"
```
- **Works:** ` sleep 0`, ` disksleep 0`, ` autorestart 1`, ` womp 1`, ` powernap 0`, then `A2 OK`.
- **Does not work:** `Sorry, try again.` means the wrong password. `A2 FAIL` means `pmset` was refused: System Settings → Energy → "Prevent automatic sleeping" on, then re-run.

### A3 — Remote Login (sshd) on, and listening
```bash
sudo launchctl enable system/com.openssh.sshd; sudo launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist 2>/dev/null; sudo launchctl kickstart -k system/com.openssh.sshd; sleep 2; echo "A3 $( nc -z -w 2 127.0.0.1 22 >/dev/null 2>&1 && echo OK || echo FAIL )"
```
- **Works:** `A3 OK`.
- **Does not work:** `A3 FAIL`. Go to System Settings → General → Sharing → Remote Login → on → "All users", then re-run.
  (`systemsetup -setremotelogin on` fails without Full Disk Access; this block does not use it.)

### A4 — automatic login (so a power cut does not park the Mac at the login window)
```bash
read -s "PW?This Mac's login password: "; echo; sudo sysadminctl -autologin set -userName "$(id -un)" -password "$PW"; unset PW; echo "A4 $( [ "$(sudo defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null)" = "$(id -un)" ] && echo OK || echo FAIL )"
```
- **Works:** `A4 OK`.
- **Does not work:** `A4 FAIL`, usually because FileVault is on. Go to System Settings → Users & Groups → Automatic login → this user. Then re-run only the `echo "A4 …"` part.

### A5 — Tailscale: install, log in, name the node
A5a installs, or skips if Tailscale is already installed:
```bash
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; if [ -x "$TS" ]; then echo "already installed: $($TS version 2>/dev/null | head -1)"; else curl -fsSL -o /tmp/Tailscale.pkg https://pkgs.tailscale.com/stable/Tailscale-1.102.3-macos.pkg && sudo installer -pkg /tmp/Tailscale.pkg -target / ; fi; open -a Tailscale; echo "A5a DONE - now click through every macOS prompt, then Tailscale menu-bar icon -> Log in -> Even account"
```
- **Works:** `installer: The install was successful.` or `already installed: 1.102.x`. macOS then shows one or more prompts:
  a system extension or VPN configuration, sometimes under System Settings → General → Login Items & Extensions → Network
  Extensions. **Allow every one.** Log in with the Even account in the browser that opens.
- **Does not work:** `curl: (6)`/`(7)` means no internet; that is the S4 DNS class, so check Wi-Fi/Ethernet first.
  `installer: Error` means re-run A5a once.

The URL returned HTTP 200 on 16 Sep; `…/Tailscale-latest-macos.pkg` redirects to 1.102.4. The desk Mini runs 1.102.3.

A5b verifies, and gives this Mac a name that cannot collide with OPD 3. OPD 3 is already `ehrc-consul4s-mac-mini` on the tailnet,
and this Mac reports the same base name with "(2)":
```bash
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; $TS set --hostname=opd-4-ortho 2>/dev/null; sleep 2; echo "tailscale ip: $($TS ip -4 2>/dev/null)"; $TS status --self=true --peers=false 2>/dev/null | head -1; echo "A5 $( [ -n "$($TS ip -4 2>/dev/null)" ] && echo OK || echo FAIL )"
```
- **Works:** `tailscale ip: 100.x.y.z`, a status line naming `opd-4-ortho`, then `A5 OK`. **Write the 100.x IP down.**
- **Does not work:** `A5 FAIL` with no IP means Tailscale is not logged in, or a prompt was not allowed. Open the menu-bar icon → Log in, then re-run A5b.
  If the status line still shows an `ehrc-consul4s-mac-mini-…` name, `set --hostname` did nothing on this build (UNVERIFIED on
  the GUI build). That is harmless: rename it later in the Tailscale admin console. The IP is what matters.

**Proof from the Air, standing in the room:** `ssh <user>@<100.x IP> 'echo ssh-ok'`. The password prompt appears, then `ssh-ok`.
If it connects, run B and C from the Air. If it does not, run them here on the Mac.

## B. Upgrade 0.1.8 → 0.1.21 by bootstrap paste

### B1 — before-state (read-only)
```bash
A="$HOME/Applications/EvenScribe Room Recorder.app"; R="$HOME/Library/Application Support/EvenScribe/RoomRecorder"; echo "app=$(plutil -extract CFBundleShortVersionString raw "$A/Contents/Info.plist") build=$(plutil -extract ETABuildSHA raw "$A/Contents/Info.plist" 2>/dev/null) install_id=$(plutil -extract install_id raw -o - "$R/config.json") room=$(plutil -extract room_slug raw -o - "$R/config.json") device_uid=$(plutil -extract device_uid raw -o - "$R/config.json")"; launchctl print gui/$(id -u)/com.evenscribe.room-recorder 2>/dev/null | grep -E "^[[:space:]]*(state|pid|last exit code) ="; "$A/Contents/MacOS/room-recorder" status 2>/dev/null | grep -E '"(state|pending_piece_count|last_error)"'; for REQ in '= anchor trusted and certificate leaf = H"187dd424fb866204111113d60c6f88a21d098edb"' '= certificate leaf = H"187dd424fb866204111113d60c6f88a21d098edb"'; do codesign --verify --strict --deep -R "$REQ" "$A" >/dev/null 2>&1; echo "codesign exit=$? :: $REQ"; done; echo "B1 $( [ "$(plutil -extract install_id raw -o - "$R/config.json")" = "install_kurmsj5wdjau" ] && echo OK || echo "FAIL - not the install this kit expects; stop and report" )"
```
- **Works:**
  - `app=0.1.8 build=7d21f5e install_id=install_kurmsj5wdjau room=opd-4-ortho-778q device_uid=<…C270…>`
  - `state = running`, `pid = <N>`. **Write the pid down.**
  - `"state" : "recording"` or `"ready"`, and `"pending_piece_count" : 0`.
  - `codesign exit=3 :: = anchor trusted …` and `codesign exit=0 :: = certificate leaf …`. These two lines confirm the cause
    from yesterday's report on this Mac.
  - `B1 OK`.
- **Does not work:**
  - A different `install_id`: someone re-pasted since 16 Sep. Stop and report the id; the rest of the kit is still valid, but R1 must use that id.
  - `pending_piece_count` above 0: wait 2 minutes and re-run B1, so pieces upload under the old install before it is retired.
    What happens to pieces left behind is UNVERIFIED.

### B2 — backup (touches only files in your home folder)
```bash
A="$HOME/Applications/EvenScribe Room Recorder.app"; R="$HOME/Library/Application Support/EvenScribe/RoomRecorder"; B="$HOME/rr-backup-0.1.8-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$B" && ditto "$A" "$B/EvenScribe Room Recorder.app" && cp -p "$R/config.json" "$B/config.json" && cp -p "$HOME/Library/LaunchAgents/com.evenscribe.room-recorder.plist" "$B/"; for f in update-result.json update-attempts.json; do if [ -f "$R/$f" ]; then mv "$R/$f" "$B/"; fi; done; echo "backup=$B"; echo "B2 $( [ -x "$B/EvenScribe Room Recorder.app/Contents/MacOS/room-recorder" ] && [ -f "$B/config.json" ] && [ -f "$B/com.evenscribe.room-recorder.plist" ] && echo OK || echo FAIL )"
```
- **Works:** `backup=/Users/<user>/rr-backup-0.1.8-2026…`, then `B2 OK`.
- **Does not work:** `B2 FAIL`. Do not paste; report `ls -la "$B"`.

Why the two `update-*.json` files move aside: 0.1.21 reads `update-result.json` once at launch and reports it
(`RoomEngine.swift:750` at `55be1d1`). Left in place, the new install row would open with 0.1.8's stale `signature_mismatch`.

### B3 — mint the command, paste it
1. On the Air: evenscribe.app → Admin → Bench → fleet card **OPD 4 - Ortho** → **Copy install command**. It copies
   `curl -fsSL "https://evenscribe.app/api/room-recorder/bootstrap/<token>" | bash`. Every Copy mints a new token and a new
   install row; unused ones are cleaned up nightly. The token is good for **30 minutes**.
2. Paste it into the Terminal (the Mac's, or the SSH session from the Air). Press Enter.

**Works:** exactly these lines (`lib/room-install.ts:559–588`, `main.swift:125/327` at `55be1d1`):
```
Downloading EvenScribe Room Recorder 0.1.21...
Verifying the download...
Stopping any earlier copy...
Installing into ~/Applications...
Enrolling this Mac...
Enrolled as OPD 4 - Ortho (opd-4-ortho-778q), install install_XXXXXXXXXXXX     <- WRITE THIS ID DOWN
Installing the LaunchAgent...
Installed /Users/<user>/Library/LaunchAgents/com.evenscribe.room-recorder.plist
Starting the app...
Installed and enrolled as OPD 4 - Ortho. Close this window.
```

**Does not work.** Where it stopped tells you what to do:

| Last line printed | State of the Mac | Do |
|---|---|---|
| `curl: (22) The requested URL returned error: 404` (nothing else) | Nothing changed; 0.1.8 still recording | The token expired or was already used. Copy a fresh command, paste again. |
| `curl: (6)` / `(7)` / `(28)` | Nothing changed | No network or DNS. Fix the network, then paste a fresh command. |
| `Checksum mismatch. Install stopped. Nothing was changed.` | Nothing changed | Stop. Report to the Orchestrator; the stable blob is wrong. |
| `Stopping any earlier copy...` or `Installing into ~/Applications...`, then an error | **Recorder stopped; bundle may be half-replaced; old install still live** | **R1** |
| `Enrolling this Mac...` then an error line | **Recorder stopped; 0.1.21 on disk; enrol probably not done** | **R1** (R1 checks this itself) |
| `Enrolled as …` printed, then an error at `Installing the LaunchAgent...` or `Starting the app...` | **New install enrolled; old one retired; recorder not running** | **R2**, never R1 |

### B4 — after-state (read-only; wait ~15 s after the paste)
```bash
A="$HOME/Applications/EvenScribe Room Recorder.app"; R="$HOME/Library/Application Support/EvenScribe/RoomRecorder"; sleep 10; echo "app=$(plutil -extract CFBundleShortVersionString raw "$A/Contents/Info.plist") build=$(plutil -extract ETABuildSHA raw "$A/Contents/Info.plist" 2>/dev/null) install_id=$(plutil -extract install_id raw -o - "$R/config.json") room=$(plutil -extract room_slug raw -o - "$R/config.json") session_file=$( [ -f "$R/room-session.json" ] && echo present || echo MISSING )"; launchctl print gui/$(id -u)/com.evenscribe.room-recorder 2>/dev/null | grep -E "^[[:space:]]*(state|pid|last exit code) ="; tail -6 "$R/launchd.log"; echo "B4 $( [ "$(plutil -extract CFBundleShortVersionString raw "$A/Contents/Info.plist")" = "0.1.21" ] && [ "$(plutil -extract install_id raw -o - "$R/config.json")" != "install_kurmsj5wdjau" ] && launchctl print gui/$(id -u)/com.evenscribe.room-recorder 2>/dev/null | grep -q "state = running" && tail -30 "$R/launchd.log" | grep -q "room-recorder: microphone authorized" && echo OK || echo FAIL )"
```
- **Works:**
  - `app=0.1.21 build=55be1d1 install_id=<the id B3 printed> room=opd-4-ortho-778q session_file=present`
  - `state = running`, and a `pid =` **different from B1's**. That proves the LaunchAgent is loaded and the app relaunched.
  - The log tail includes `room-recorder: microphone authorized`, with no `409 RETIRED` and no `no room session`.
  - `B4 OK`.
- **Does not work:**
  - `app=0.1.8` or `install_id=install_kurmsj5wdjau`: the paste did not complete. Go to **R1**.
  - `app=0.1.21`, new install id, but no `state = running`: go to **R2**.
  - `room-recorder: microphone denied` or `not_determined`: go to **B5**.
  - `poll refused (409 RETIRED)`: the id in `config.json` is not the one just enrolled. Go to **R3**.

### B5 — only if the microphone is not authorized (console)
System Settings → Privacy & Security → Microphone → **EvenScribe Room Recorder** on. Then:
```bash
launchctl kickstart -k gui/$(id -u)/com.evenscribe.room-recorder; sleep 10; tail -4 "$HOME/Library/Application Support/EvenScribe/RoomRecorder/launchd.log"; echo "B5 $( tail -30 "$HOME/Library/Application Support/EvenScribe/RoomRecorder/launchd.log" | grep -q "room-recorder: microphone authorized" && echo OK || echo FAIL )"
```

### Rollback

**Which one:** read `install_id` in `config.json`.
- It is still `install_kurmsj5wdjau` and there is no fresh `room-session.json`: the old install was never retired. Use **R1**.
- Anything else: **never put 0.1.8 back.** The server has retired the old install, and 0.1.8 would not record under it. Use **R2** or **R3**.

**R1 — put 0.1.8 back (only while the old install id is still in `config.json`)**
```bash
A="$HOME/Applications/EvenScribe Room Recorder.app"; R="$HOME/Library/Application Support/EvenScribe/RoomRecorder"; P="$HOME/Library/LaunchAgents/com.evenscribe.room-recorder.plist"; B="$(ls -dt "$HOME"/rr-backup-0.1.8-* | head -1)"; CUR="$(plutil -extract install_id raw -o - "$R/config.json")"; if [ "$CUR" = "install_kurmsj5wdjau" ] && [ ! -f "$R/room-session.json" ]; then launchctl bootout gui/$(id -u)/com.evenscribe.room-recorder 2>/dev/null; rm -rf "$A" && ditto "$B/EvenScribe Room Recorder.app" "$A" && cp -p "$B/com.evenscribe.room-recorder.plist" "$P" && launchctl bootstrap gui/$(id -u) "$P"; sleep 10; echo "app=$(plutil -extract CFBundleShortVersionString raw "$A/Contents/Info.plist") install_id=$(plutil -extract install_id raw -o - "$R/config.json")"; launchctl print gui/$(id -u)/com.evenscribe.room-recorder 2>/dev/null | grep -E "^[[:space:]]*(state|pid) ="; echo "R1 $( launchctl print gui/$(id -u)/com.evenscribe.room-recorder 2>/dev/null | grep -q "state = running" && echo OK || echo FAIL )"; else echo "R1 REFUSED: config.json names $CUR (session file: $( [ -f "$R/room-session.json" ] && echo present || echo absent )) - the enrol reached the server. Use R2 or R3."; fi
```
- **Works:** `app=0.1.8 install_id=install_kurmsj5wdjau`, `state = running`, `R1 OK`. Then ask the Orchestrator for D1. The
  row must still be `install_kurmsj5wdjau` with `last_seen_at` under a minute old.
  Edge case: if the enrol reached the server but the reply was lost in transit, the old row is already retired even though
  `config.json` was never touched. D1 shows that as a stale `last_seen_at`. The fix then is **R3**.
- **Does not work:** `R1 FAIL`: report `tail -20 "$R/launchd.log"`.

**R2 — finish forward (the new install is enrolled but the agent is not running)**
```bash
A="$HOME/Applications/EvenScribe Room Recorder.app"; P="$HOME/Library/LaunchAgents/com.evenscribe.room-recorder.plist"; "$A/Contents/MacOS/room-recorder" install-launch-agent; launchctl bootout gui/$(id -u)/com.evenscribe.room-recorder 2>/dev/null; launchctl bootstrap gui/$(id -u) "$P" || launchctl load "$P"; sleep 10; launchctl print gui/$(id -u)/com.evenscribe.room-recorder 2>/dev/null | grep -E "^[[:space:]]*(state|pid) ="; echo "R2 $( launchctl print gui/$(id -u)/com.evenscribe.room-recorder 2>/dev/null | grep -q "state = running" && echo OK || echo FAIL )"
```
- **Works:** `Installed /Users/…/com.evenscribe.room-recorder.plist`, `state = running`, `R2 OK`. Then re-run **B4**.
- **Does not work:** `R2 FAIL`: go to **R3**.

**R3 — paste again with a fresh command.** Copy a new install command on the card and repeat **B3**, then **B4**. The new
enrol retires any half-finished install from the failed attempt; nothing needs cleaning by hand.

## C. Audio sanity (two minutes; stock tools only: `ps`, `lsof`, `stat`, `dd`, `od`, `awk`)

How it works, from source:
- The recorder runs `tapewriter record --out <segment dir> --device <device uid>`, and `--device` is the last argument
  (`RoomEngine.swift:402` at `55be1d1`; `:351` at 0.1.8). So `ps` shows the bound device.
- The tape is `<segment dir>/tape.pcm`: raw headerless PCM, 16 kHz, mono, signed 16-bit little-endian, 2 bytes per sample,
  32,000 bytes per second (`TapeFormat.swift:4–8`, `TapeWriter.swift:95, 245–258`).
- The block measures growth over 5 seconds, then reads the last 5 seconds of samples.

**Speak normally near the microphone during the 5-second wait.**
```bash
P=$(pgrep -f "[t]apewriter record" | head -1); if [ -z "$P" ]; then echo "C1 FAIL - no tapewriter running: the room is not recording. Start the day on the kiosk, re-run."; else ARGS="$(ps -ww -o args= -p "$P")"; DEV="${ARGS##* --device }"; OUT="${ARGS#* --out }"; OUT="${OUT% --device *}"; T="$OUT/tape.pcm"; [ -f "$T" ] || T="$(lsof -p "$P" -Fn 2>/dev/null | sed -n 's/^n//p' | grep '/tape\.pcm$' | head -1)"; S1=$(stat -f %z "$T"); sleep 5; S2=$(stat -f %z "$T"); G=$((S2-S1)); N=$(( S2/32000 - 5 )); [ "$N" -lt 0 ] && N=0; dd if="$T" bs=32000 skip=$N count=5 2>/dev/null | od -An -v -t d2 | awk -v dev="$DEV" -v g="$G" '{for(i=1;i<=NF;i++){n++; v=($i<0)?-$i:$i; if(v==0)z++; if(v>m)m=v}} END{printf "device=%s\ngrowth_5s=%d bytes (want 150000-170000)\nsamples=%d peak=%.4f zero_ratio=%.4f\n", dev, g, n, m/32768, (n?z/n:1); if(g<100000) print "C1 FAIL - tape not advancing"; else if(n==0||z==n) print "C1 FAIL - digital silence (every sample 0): stale or dead device binding"; else if(m<33) print "C1 WARN - near-silent (peak < 0.001): input level at 0 or wrong input selected"; else print "C1 OK"}'; fi
```
- **Works:**
  - `device=AppleUSBAudioEngine:Unknown Manufacturer:C270 HD WEBCAM:<serial>:3`
  - `growth_5s=` about 160000
  - a `peak=` somewhere between 0.01 and 0.5 while you talk (the healthy C270 rooms read 0.015–0.065 on the fleet today)
  - a `zero_ratio=` near 0
  - `C1 OK`
- **Does not work, and what each means:**
  - `tape not advancing`: `tapewriter` is alive but writing nothing.
  - `digital silence`: every sample is exactly 0. This is cluster 1: the binding is stale, or the device is dead. Unplug and
    replug the C270, then `launchctl kickstart -k gui/$(id -u)/com.evenscribe.room-recorder` and re-run C1. On 0.1.21 the desk
    can also rebind it with `set_audio_input`.
  - `near-silent`: System Settings → Sound → Input → select the C270, level about 50%, re-run.
  - A `device=` that is not the C270 is the wrong binding. Report it.

---

# ROOM: OPD 1

Identical to OPD 4 in every command, with these substitutions. **Do not skip a substitution: B1, B4 and R1 check the old id literally.**

| In OPD 4's blocks | For OPD 1 use |
|---|---|
| `install_kurmsj5wdjau` (B1, B4, R1) | `install_fygsnma88x2d` |
| `opd-4-ortho-778q` (expected output) | `opd-1-xqj7` |
| `OPD 4 - Ortho` (card name, B3 output) | `OPD 1` |
| A5b `--hostname=opd-4-ortho` | `--hostname=opd-1` |
| A1 expected `macos=26.6.2`, user `ehrc-consul4` | `macos=15.7.9`, user `ehrc-consul2` (UNVERIFIED, inferred from hostname) |

For zero-thought pasting, here are the three blocks that carry the id, already substituted.

### OPD 1 — A5b
```bash
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; $TS set --hostname=opd-1 2>/dev/null; sleep 2; echo "tailscale ip: $($TS ip -4 2>/dev/null)"; $TS status --self=true --peers=false 2>/dev/null | head -1; echo "A5 $( [ -n "$($TS ip -4 2>/dev/null)" ] && echo OK || echo FAIL )"
```

### OPD 1 — B1
```bash
A="$HOME/Applications/EvenScribe Room Recorder.app"; R="$HOME/Library/Application Support/EvenScribe/RoomRecorder"; echo "app=$(plutil -extract CFBundleShortVersionString raw "$A/Contents/Info.plist") build=$(plutil -extract ETABuildSHA raw "$A/Contents/Info.plist" 2>/dev/null) install_id=$(plutil -extract install_id raw -o - "$R/config.json") room=$(plutil -extract room_slug raw -o - "$R/config.json") device_uid=$(plutil -extract device_uid raw -o - "$R/config.json")"; launchctl print gui/$(id -u)/com.evenscribe.room-recorder 2>/dev/null | grep -E "^[[:space:]]*(state|pid|last exit code) ="; "$A/Contents/MacOS/room-recorder" status 2>/dev/null | grep -E '"(state|pending_piece_count|last_error)"'; for REQ in '= anchor trusted and certificate leaf = H"187dd424fb866204111113d60c6f88a21d098edb"' '= certificate leaf = H"187dd424fb866204111113d60c6f88a21d098edb"'; do codesign --verify --strict --deep -R "$REQ" "$A" >/dev/null 2>&1; echo "codesign exit=$? :: $REQ"; done; echo "B1 $( [ "$(plutil -extract install_id raw -o - "$R/config.json")" = "install_fygsnma88x2d" ] && echo OK || echo "FAIL - not the install this kit expects; stop and report" )"
```
Works: `app=0.1.8 build=7d21f5e install_id=install_fygsnma88x2d room=opd-1-xqj7 …`, the two codesign lines `exit=3` then
`exit=0`, and `B1 OK`.

### OPD 1 — B2, B3, B5, C1
B2, B5 and C1 are the same commands as OPD 4's. B3 is the same procedure on the **OPD 1** card. B3's success line reads
`Enrolled as OPD 1 (opd-1-xqj7), install install_…`.

### OPD 1 — B4
```bash
A="$HOME/Applications/EvenScribe Room Recorder.app"; R="$HOME/Library/Application Support/EvenScribe/RoomRecorder"; sleep 10; echo "app=$(plutil -extract CFBundleShortVersionString raw "$A/Contents/Info.plist") build=$(plutil -extract ETABuildSHA raw "$A/Contents/Info.plist" 2>/dev/null) install_id=$(plutil -extract install_id raw -o - "$R/config.json") room=$(plutil -extract room_slug raw -o - "$R/config.json") session_file=$( [ -f "$R/room-session.json" ] && echo present || echo MISSING )"; launchctl print gui/$(id -u)/com.evenscribe.room-recorder 2>/dev/null | grep -E "^[[:space:]]*(state|pid|last exit code) ="; tail -6 "$R/launchd.log"; echo "B4 $( [ "$(plutil -extract CFBundleShortVersionString raw "$A/Contents/Info.plist")" = "0.1.21" ] && [ "$(plutil -extract install_id raw -o - "$R/config.json")" != "install_fygsnma88x2d" ] && launchctl print gui/$(id -u)/com.evenscribe.room-recorder 2>/dev/null | grep -q "state = running" && tail -30 "$R/launchd.log" | grep -q "room-recorder: microphone authorized" && echo OK || echo FAIL )"
```

### OPD 1 — R1
```bash
A="$HOME/Applications/EvenScribe Room Recorder.app"; R="$HOME/Library/Application Support/EvenScribe/RoomRecorder"; P="$HOME/Library/LaunchAgents/com.evenscribe.room-recorder.plist"; B="$(ls -dt "$HOME"/rr-backup-0.1.8-* | head -1)"; CUR="$(plutil -extract install_id raw -o - "$R/config.json")"; if [ "$CUR" = "install_fygsnma88x2d" ] && [ ! -f "$R/room-session.json" ]; then launchctl bootout gui/$(id -u)/com.evenscribe.room-recorder 2>/dev/null; rm -rf "$A" && ditto "$B/EvenScribe Room Recorder.app" "$A" && cp -p "$B/com.evenscribe.room-recorder.plist" "$P" && launchctl bootstrap gui/$(id -u) "$P"; sleep 10; echo "app=$(plutil -extract CFBundleShortVersionString raw "$A/Contents/Info.plist") install_id=$(plutil -extract install_id raw -o - "$R/config.json")"; launchctl print gui/$(id -u)/com.evenscribe.room-recorder 2>/dev/null | grep -E "^[[:space:]]*(state|pid) ="; echo "R1 $( launchctl print gui/$(id -u)/com.evenscribe.room-recorder 2>/dev/null | grep -q "state = running" && echo OK || echo FAIL )"; else echo "R1 REFUSED: config.json names $CUR (session file: $( [ -f "$R/room-session.json" ] && echo present || echo absent )) - the enrol reached the server. Use R2 or R3."; fi
```
R2 and R3 are the same as OPD 4's.

---

## D. From the desk, after each room

### D1 — the room reports to the fleet, under which install id (Orchestrator: MCP; V: Bench card)
Orchestrator: `scribe_rooms view=fleet room=opd-4-ortho-778q detail=full`, and the same for `opd-1-xqj7`. **Wants:**
- `install.install_id` = the id B3 printed, **not** `install_kurmsj5wdjau` / `install_fygsnma88x2d`
- `app_version` `0.1.21`, `build_sha` `55be1d1`
- `last_seen_at` under 60 s old, `retired_at` null
- `launch_agent_loaded` true, `mic_state` `authorized`
- `peak` and `zero_ratio` **no longer null**. 0.1.8 never reported them, and 0.1.21 does, so the desk can watch audio for these rooms from now on.
- `last_update_result` null. B2 moved the stale receipt aside.

The Bench card shows the same `install_id` and version on the room's row.

### D2 — make SSH key-based so the room never needs a password again (from the Air)
```bash
U="PUT-A1-USER-HERE"; IP="PUT-A5-TAILSCALE-IP-HERE"   # edit these two values first
ssh-copy-id -i ~/.ssh/id_ecdsa "$U@$IP"   # the Mac's password, once
ssh -i ~/.ssh/id_ecdsa -o BatchMode=yes "$U@$IP" 'echo "sleep=$(pmset -g | awk "/^ sleep/{print \$2}") app=$(plutil -extract CFBundleShortVersionString raw "$HOME/Applications/EvenScribe Room Recorder.app/Contents/Info.plist")"'
```
- **Works:** `sleep=0 app=0.1.21` with no password prompt. Same key as the other six rooms (`ETA-ROOM-FAULT-PLAYBOOK-AND-RELEASE-SPEC-12-SEP-2026.md:134`).
- Afterwards, add both rooms to the fleet host table: user, tailscale IP, new install id.

---

## E. While you are on site: other rooms the fleet flagged at 13:14Z on 16 Sep (not part of this kit's scope; C1 works on each)

| Room | Fleet says | C1 can be run from the desk (SSH) |
|---|---|---|
| OPD 5 | `DEVICE_MISSING`, `ENCODER_STALLED`, tape not advancing, `input_devices: []` | yes. It sees no microphone at all, so check the C270's USB. |
| OPD 7 | no poll since 10:53Z | desk SSH first; if the Mac is asleep or at the login window, it needs hands |
| Cardiology, OPD 3 | `SILENT_WHILE_RECORDING`, TONOR bound, `peak 0`, `zero_ratio 1` | yes; expect `digital silence` (cluster 1 / S3/S7) |

---

## F. The 0.1.23 version bump — PREPARED, NOT MADE

Nothing below has been edited. V and the Orchestrator run it as its own round.

### What PR #3 is
- Branch `origin/cursor/piece-pipeline-pipe-close-6a9c`, two commits:
  - `5e09132` Close Pipe ends after piece encode and poll helpers.
  - `0803d51` Stop using Foundation.Pipe on the live recording poll and cutter.
- Merge-base with this branch: `14a4f38`. That base contains the 0.1.22 test build `d516204`, stable `55be1d1` and the
  0.1.22 bump `40ab2bd`. **There are no `apps/room-recorder` commits between `d516204` and `14a4f38`.** So 0.1.23 = the Home Office
  0.1.22 code + the FD fix, and nothing else.
- On the branch, `Packaging/VERSION` is still `0.1.22` and the CHANGELOG line reads `**unreleased**`.

### The exact edits (two files; nothing else reads the version)

1. **`apps/room-recorder/Packaging/VERSION`**
   ```
   - 0.1.22
   + 0.1.23
   ```
2. **`apps/room-recorder/CHANGELOG.md`**: the line PR #3 added, relabelled. The 0.1.22 line below it stays:
   ```
   - - **unreleased** — do not use `Foundation.Pipe` for poll helpers or ffmpeg stderr (`RoomSubprocess` temp files). The live leak was `MachineFacts.runTool` three times per 1.5 s poll while recording, not only failed piece writes.
   + - **0.1.23** — do not use `Foundation.Pipe` for poll helpers or ffmpeg stderr (`RoomSubprocess` temp files). The live leak was `MachineFacts.runTool` three times per 1.5 s poll while recording, not only failed piece writes.
   ```

### Why that is the whole list (checked)
- **The only reader of `VERSION`** is `Packaging/build-bundle.sh`: it reads the file at `:24/:34–:38` (regex-validated) and
  stamps it into `CFBundleShortVersionString`/`CFBundleVersion`, the zip name and `release.json` `"version"`. The app reads its
  version from its own `Info.plist` at runtime (`InstallPollFields.swift:350–351`).
- **No test or source asserts `0.1.22` as the current version.** Every `0.1.22`/`0.1.21` outside `docs/` is a version floor:
  - `TEST_CHANNEL_MIN_APP_VERSION = "0.1.22"` (`lib/bench-bus-constants.ts:718`)
  - `VERBS_MIN_APP_VERSION = "0.1.22"`, `SET_AUDIO_INPUT_MIN_APP_VERSION = "0.1.21"` (`lib/bench-commands.ts:127,153`)
  - tests of those floors
- **Floors compare numerically**, component by component (`appVersionAtLeast`, `lib/bench-bus-constants.ts:683–702`). 0.1.23
  clears every floor.
- **`build_sha`** comes from `git rev-parse --short HEAD`. The script refuses a dirty tree unless `ETA_ALLOW_DIRTY_BUILD=1`
  (`build-bundle.sh:77–82`). **The bump must be committed before the build, and a release build must not use that override.**
- **Signing is unchanged:** same identity, leaf-only verify. 0.1.21 and 0.1.22 installs will accept it (C3 report §3).

### The release round, in order (for V and the Orchestrator; not run here)
1. Commit the two edits on the PR #3 line, which branch is V's call. Run the full gate plus `swift build`/`swift test`.
   Build with `Packaging/build-bundle.sh` (V unlocks the keychain first). Expect `release.json` with `"version": "0.1.23"`, and
   `codesign -dr -` unchanged from 0.1.22.
2. Upload the zip to the `test` blob key (0.1.22 used `room-recorder/EvenScribe-Room-Recorder-<v>.zip`), then
   `POST /api/admin/releases` `{blob_url, channel:"test", manifest:<release.json>}`. The server re-hashes the blob
   (`createRelease`, `lib/room-install.ts:329–359`).
3. Home Office (0.1.22, `test`) is offered it, because `"0.1.23" != "0.1.22"` (`RoomSelfUpdate.swift:590–596`).
   Want `last_update_result ok`, `last_update_version 0.1.23` on its row.
4. **Leak check on Home Office.** Nothing in the code prescribes this check; it is the kit's suggestion, built from S1's numbers.
   Take the `room-recorder` process's PIPE count twice, 10 minutes apart, while recording:
   `P=$(pgrep -f "[E]venScribe Room Recorder.app/Contents/MacOS/room-recorder run" | head -1); lsof -p "$P" 2>/dev/null | grep -c PIPE; lsof -p "$P" 2>/dev/null | wc -l`
   0.1.22 grew about 6 PIPEs every 1.5 s. On 0.1.23, both numbers should stay flat.
5. **Promote.** Upload the **same zip** to a **second blob key**, as 0.1.21 did with
   `room-recorder/stable/EvenScribe-Room-Recorder-<v>.zip`. `app_release.blob_url` is `UNIQUE` (`db/migrations/0075_room_install.sql:84`), so one URL cannot serve both
   channels. Then `POST /api/admin/releases` with `channel:"stable"`. `UNIQUE (version, channel)` allows 0.1.23 on both channels.
6. The 0.1.21 rooms take it at their next check, within 6 h, or on `check_update_now` for rooms on ≥0.1.22.
   After tomorrow's paste, OPD 4 and OPD 1 are 0.1.21 rooms, so they take it by self-update too. No second visit.

---

## What this kit could not determine, and what settles it

| Unknown | Settled by |
|---|---|
| OPD 1 and OPD 4 login user names (`ehrc-consul2` / `ehrc-consul4` are inferences from the hostnames) | A1 on site |
| Whether OPD 1 accepts SSH on its LAN (it is off the tailnet, so it cannot be reached from the desk either way) | A3 on site. There is no need to find out sooner: the paste needs the console for A5 regardless |
| Whether `tailscale set --hostname` works on the standalone GUI build | A5b's status line; harmless if it does not |
| What happens to pieces still spooled under the old install at the moment of re-enrol | Avoided by B1's `pending_piece_count 0` gate; a source read of the upload route would settle it |
| That the enrol exchange's server commit and a lost reply cannot leave the room without a live install | D1 after R1 (the stale `last_seen_at` case → R3) |
| Whether the tape runs with no clinic day open on 0.1.21 | C1 says so plainly (`no tapewriter running`) |
